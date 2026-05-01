/**
 * unread.ts — Server-authoritative unread count and mute state management.
 *
 * Design philosophy: the PLATFORM is the source of truth for unread state.
 * We mirror platform unread state into conduit's chat_read_state table,
 * and use that as the basis for computing unread counts.
 *
 * Per-platform approach:
 *   - Slack:    conversations.list returns last_read per channel. We seed
 *               the cursor from that. Real-time cross-device sync via
 *               channel_marked / im_marked Socket Mode events.
 *   - Telegram: getDialogs() returns readInboxMaxId per dialog. We find
 *               the matching message timestamp in the local DB and seed
 *               the cursor from that. Real-time via UpdateReadHistoryInbox.
 *   - Discord:  No read cursor API available for selfbots. Discord unread
 *               counts are NOT tracked — no badges, no read state.
 *   - Gmail:    Per-message isRead boolean from UNREAD label. Unread counts
 *               are per-thread (thread has unread if any message isRead=false).
 *   - Twitter:  Cursor-based (no platform API), unchanged.
 *
 * Unread counts are computed as:
 *   COUNT(messages WHERE timestamp > last_read_at)
 *
 * This module is imported by all sync modules (slack, telegram) and
 * by the API router. It has no dependency on any platform-specific code.
 */

import { getDb } from '../db/client.js';
import {
  slackMessages, telegramMessages, twitterDms,
  chatReadState, chatMuteState, gmailMessages,
} from '../db/schema.js';
import { eq, and, gt, sql } from 'drizzle-orm';
import { broadcastUnread } from '../websocket/hub.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnreadEntry {
  source: string;
  chatId: string;
  count: number;
  isMuted: boolean;
}

// ---------------------------------------------------------------------------
// Read state persistence
// ---------------------------------------------------------------------------

/**
 * Seed (or overwrite) the read cursor for a batch of chats from platform data.
 * Called by each service's fetchUnreadCounts() to propagate the platform's own
 * read position into conduit's chat_read_state table, so that already-read
 * messages are not counted as unread after a sync.
 *
 * Uses an upsert — always overwrites any existing row — so re-syncing always
 * reflects the freshest platform read state.
 */
export function seedReadState(
  updates: Array<{ source: string; chatId: string; lastReadAt: string }>,
): void {
  if (updates.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  for (let i = 0; i < updates.length; i += 100) {
    db.insert(chatReadState)
      .values(updates.slice(i, i + 100).map(({ source, chatId, lastReadAt }) => ({
        source, chatId, lastReadAt, updatedAt: now,
      })))
      .onConflictDoUpdate({
        target: [chatReadState.source, chatReadState.chatId],
        set: { lastReadAt: sql`excluded.last_read_at`, updatedAt: now },
      })
      .run();
  }
}

/**
 * Persist mute state for a batch of chats. Called by each service's
 * fetchUnreadCounts() after computing mute state from the platform.
 */
export function persistMuteState(
  updates: Array<{ source: string; chatId: string; isMuted: boolean }>,
): void {
  if (updates.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  for (let i = 0; i < updates.length; i += 100) {
    db.insert(chatMuteState)
      .values(updates.slice(i, i + 100).map(({ source, chatId, isMuted }) => ({
        source, chatId, isMuted, updatedAt: now,
      })))
      .onConflictDoUpdate({
        target: [chatMuteState.source, chatMuteState.chatId],
        set: { isMuted: sql`excluded.is_muted`, updatedAt: now },
      })
      .run();
  }
}

/**
 * Get the current mute state for a single chat from the DB.
 * Returns false (not muted) if no row exists.
 */
export function getChatMuteState(source: string, chatId: string): boolean {
  const db = getDb();
  const row = db.select({ isMuted: chatMuteState.isMuted })
    .from(chatMuteState)
    .where(and(eq(chatMuteState.source, source), eq(chatMuteState.chatId, chatId)))
    .get();
  return row?.isMuted ?? false;
}

// ---------------------------------------------------------------------------
// Count computation
// ---------------------------------------------------------------------------

/**
 * Count unread messages for a single chat (since last_read_at).
 * Used by broadcastUnreadForChat — the hot path after every new message.
 * Relies on the composite (channelId/chatId, timestamp) indexes for speed.
 *
 * NOTE: Discord is intentionally excluded — no reliable read cursor available.
 */
function countUnreadForChat(source: string, chatId: string, lastReadAt: string | null): number {
  const db = getDb();
  const since = lastReadAt ?? '1970-01-01T00:00:00.000Z';

  if (source === 'slack') {
    const row = db.select({ count: sql<number>`count(*)` })
      .from(slackMessages)
      .where(and(eq(slackMessages.channelId, chatId), gt(slackMessages.timestamp, since)))
      .get();
    return row?.count ?? 0;
  }
  if (source === 'telegram') {
    const row = db.select({ count: sql<number>`count(*)` })
      .from(telegramMessages)
      .where(and(eq(telegramMessages.chatId, sql<number>`${chatId}`), gt(telegramMessages.timestamp, since)))
      .get();
    return row?.count ?? 0;
  }
  if (source === 'twitter') {
    const row = db.select({ count: sql<number>`count(*)` })
      .from(twitterDms)
      .where(and(eq(twitterDms.conversationId, chatId), gt(twitterDms.createdAt, since)))
      .get();
    return row?.count ?? 0;
  }
  return 0;
}

/**
 * Compute unread counts for ALL chats across all services using a single
 * grouped query per source (queries total) instead of N+1 per-chat queries.
 *
 * Discord is excluded — no reliable read cursor API for selfbots.
 * Gmail is separate — uses per-thread unread counts from the gmail_messages table.
 *
 * Strategy:
 *   1. Load all chat_read_state and chat_mute_state rows into maps (2 queries).
 *   2. For each source, run one GROUP BY query that counts messages per chat
 *      that are newer than a reference timestamp.
 *   3. For Gmail, count threads with at least one unread message.
 *   4. Merge the counts with mute state.
 *
 * Called by GET /api/unread and after fetchUnreadCounts() on reconnect.
 */
export function computeAllUnreads(): UnreadEntry[] {
  const db = getDb();

  // Load all chat_read_state rows into a map for O(1) lookup
  const readStateMap = new Map<string, string>(); // "source:chatId" → last_read_at
  for (const row of db.select().from(chatReadState).all()) {
    readStateMap.set(`${row.source}:${row.chatId}`, row.lastReadAt);
  }

  // Load all chat_mute_state rows
  const muteMap = new Map<string, boolean>(); // "source:chatId" → isMuted
  for (const row of db.select().from(chatMuteState).all()) {
    muteMap.set(`${row.source}:${row.chatId}`, row.isMuted);
  }

  // Accumulate results by "source:chatId" key to avoid duplicates
  const countMap = new Map<string, number>(); // "source:chatId" → unread count

  // ── Slack: one aggregated query ───────────────────────────────────────────
  const slackRows = db.all<{ channelId: string; count: number }>(sql`
    SELECT m.channel_id AS channelId,
           COUNT(*) AS count
    FROM slack_messages m
    LEFT JOIN chat_read_state r
      ON r.source = 'slack' AND r.chat_id = m.channel_id
    WHERE m.timestamp > COALESCE(r.last_read_at, '1970-01-01T00:00:00.000Z')
    GROUP BY m.channel_id
  `);
  for (const row of slackRows) {
    countMap.set(`slack:${row.channelId}`, Number(row.count));
  }

  // ── Telegram: one aggregated query ───────────────────────────────────────
  // chat_id is stored as INTEGER; cast to text for the JOIN key.
  const telegramRows = db.all<{ chatId: string; count: number }>(sql`
    SELECT CAST(m.chat_id AS TEXT) AS chatId,
           COUNT(*) AS count
    FROM telegram_messages m
    LEFT JOIN chat_read_state r
      ON r.source = 'telegram' AND r.chat_id = CAST(m.chat_id AS TEXT)
    WHERE m.timestamp > COALESCE(r.last_read_at, '1970-01-01T00:00:00.000Z')
    GROUP BY m.chat_id
  `);
  for (const row of telegramRows) {
    countMap.set(`telegram:${row.chatId}`, Number(row.count));
  }

  // ── Twitter DMs: one aggregated query ────────────────────────────────────
  const twitterRows = db.all<{ conversationId: string; count: number }>(sql`
    SELECT m.conversation_id AS conversationId,
           COUNT(*) AS count
    FROM twitter_dms m
    LEFT JOIN chat_read_state r
      ON r.source = 'twitter' AND r.chat_id = m.conversation_id
    WHERE m.created_at > COALESCE(r.last_read_at, '1970-01-01T00:00:00.000Z')
    GROUP BY m.conversation_id
  `);
  for (const row of twitterRows) {
    countMap.set(`twitter:${row.conversationId}`, Number(row.count));
  }

  // ── Gmail: per-thread unread counts ──────────────────────────────────────
  // A thread is unread if it has at least one message with is_read = 0 (false).
  // chatId = thread_id, source = 'gmail'.
  const gmailRows = db.all<{ threadId: string; count: number }>(sql`
    SELECT thread_id AS threadId,
           COUNT(*) AS count
    FROM gmail_messages
    WHERE is_read = 0
    GROUP BY thread_id
  `);
  for (const row of gmailRows) {
    countMap.set(`gmail:${row.threadId}`, Number(row.count));
  }

  // ── Collect all known chat keys (union of message tables + mute/read state) ─
  const allKeys = new Set<string>();

  // Chats that have messages (distinct keys already in countMap)
  for (const key of countMap.keys()) allKeys.add(key);

  // Chats that have a read state but zero unread messages (not in countMap yet)
  // Exclude discord entries from read state that may have been seeded previously
  for (const key of readStateMap.keys()) {
    if (!key.startsWith('discord:')) allKeys.add(key);
  }

  // Chats that have a mute state entry but possibly no messages
  // Exclude discord mute entries from count — still track mute but not unread
  for (const key of muteMap.keys()) {
    if (!key.startsWith('discord:')) allKeys.add(key);
  }

  const results: UnreadEntry[] = [];
  for (const key of allKeys) {
    const colonIdx = key.indexOf(':');
    const source = key.slice(0, colonIdx);
    const chatId = key.slice(colonIdx + 1);
    results.push({
      source,
      chatId,
      count: countMap.get(key) ?? 0,
      isMuted: muteMap.get(key) ?? false,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Real-time push after new message
// ---------------------------------------------------------------------------

/**
 * Called immediately after a new message is stored in the DB.
 * Computes the updated unread count for this chat and broadcasts it
 * via WebSocket to all connected clients.
 *
 * This is the hot path — it runs on every incoming live message.
 * Discord is excluded — no reliable read cursor tracking.
 */
export function broadcastUnreadForChat(source: string, chatId: string): void {
  // Discord unread tracking is disabled — no reliable read cursor API
  if (source === 'discord') return;

  try {
    const db = getDb();
    const readRow = db.select({ lastReadAt: chatReadState.lastReadAt })
      .from(chatReadState)
      .where(and(eq(chatReadState.source, source), eq(chatReadState.chatId, chatId)))
      .get();
    const lastReadAt = readRow?.lastReadAt ?? null;
    const isMuted = getChatMuteState(source, chatId);
    const count = countUnreadForChat(source, chatId, lastReadAt);
    broadcastUnread([{ source, chatId, count, isMuted }]);
  } catch (e) {
    console.error(`[unread] broadcastUnreadForChat error (${source}:${chatId}):`, e);
  }
}

/**
 * Mark every known non-Discord chat as read at the current time, then
 * broadcast count=0 for all.
 * Returns the list of chats that were marked so the caller can also hit platform APIs.
 */
export function markAllChatsRead(): Array<{ source: string; chatId: string }> {
  const db = getDb();
  const now = new Date().toISOString();

  const allEntries = computeAllUnreads();
  // Filter out Discord — we don't track read state for Discord
  const eligibleEntries = allEntries.filter(({ source }) => source !== 'discord');

  for (const { source, chatId } of eligibleEntries) {
    db.insert(chatReadState)
      .values({ source, chatId, lastReadAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [chatReadState.source, chatReadState.chatId],
        set: { lastReadAt: now, updatedAt: now },
      })
      .run();
  }

  const isMutedFn = (source: string, chatId: string) => getChatMuteState(source, chatId);
  broadcastUnread(eligibleEntries.map(({ source, chatId }) => ({
    source, chatId, count: 0, isMuted: isMutedFn(source, chatId),
  })));

  return eligibleEntries.map(({ source, chatId }) => ({ source, chatId }));
}

// ---------------------------------------------------------------------------
// Mark as read / unread
// ---------------------------------------------------------------------------

/**
 * Record that the user read a chat at the current time.
 * Writes to chat_read_state and broadcasts count=0 for this chat.
 * Called by POST /api/unread/:source/:chatId/read.
 *
 * Discord is a no-op — we don't track read state for Discord.
 */
export function markChatRead(source: string, chatId: string): void {
  if (source === 'discord') return;

  const db = getDb();
  const now = new Date().toISOString();
  db.insert(chatReadState)
    .values({ source, chatId, lastReadAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [chatReadState.source, chatReadState.chatId],
      set: { lastReadAt: now, updatedAt: now },
    })
    .run();
  const isMuted = getChatMuteState(source, chatId);
  broadcastUnread([{ source, chatId, count: 0, isMuted }]);
}

/**
 * Mark a chat as unread by resetting (deleting) the read cursor.
 * Without a cursor, all messages in the chat count as unread.
 * Broadcasts the new count.
 *
 * Discord is a no-op — we don't track read state for Discord.
 */
export function markChatUnread(source: string, chatId: string): void {
  if (source === 'discord') return;

  const db = getDb();
  db.delete(chatReadState)
    .where(and(eq(chatReadState.source, source), eq(chatReadState.chatId, chatId)))
    .run();
  const isMuted = getChatMuteState(source, chatId);
  const count = countUnreadForChat(source, chatId, null);
  broadcastUnread([{ source, chatId, count, isMuted }]);
}
