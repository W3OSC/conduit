/**
 * unread.ts — Server-authoritative unread count and mute state management.
 *
 * The server is the sole source of truth for:
 *   - chat_read_state  — when each chat was last read (updated by markChatRead)
 *   - chat_mute_state  — whether each chat is muted (updated by fetchUnreadCounts per service)
 *
 * Unread counts are computed as:
 *   COUNT(messages WHERE timestamp > last_read_at)
 *
 * This module is imported by all sync modules (discord, slack, telegram) and
 * by the API router. It has no dependency on any platform-specific code.
 */

import { getDb } from '../db/client.js';
import {
  discordMessages, slackMessages, telegramMessages, twitterDms,
  chatReadState, chatMuteState,
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
// Mute state persistence
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
 */
function countUnreadForChat(source: string, chatId: string, lastReadAt: string | null): number {
  const db = getDb();
  const since = lastReadAt ?? '1970-01-01T00:00:00.000Z';

  if (source === 'discord') {
    const row = db.select({ count: sql<number>`count(*)` })
      .from(discordMessages)
      .where(and(eq(discordMessages.channelId, chatId), gt(discordMessages.timestamp, since)))
      .get();
    return row?.count ?? 0;
  }
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
 * Compute unread counts for ALL chats across all services.
 * Called by GET /api/unread — the authoritative initial-load endpoint.
 *
 * Returns an entry for every chat that has either unread messages OR a mute
 * state entry, so the client always gets a complete picture.
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

  const results: UnreadEntry[] = [];

  // Helper to add entries for a given source + distinct chatIds
  const addEntries = (source: string, chatIds: string[]) => {
    for (const chatId of chatIds) {
      const key = `${source}:${chatId}`;
      const lastReadAt = readStateMap.get(key) ?? null;
      const isMuted = muteMap.get(key) ?? false;
      const count = countUnreadForChat(source, chatId, lastReadAt);
      // Always include the entry so the client gets isMuted even for count=0
      results.push({ source, chatId, count, isMuted });
    }
  };

  // Discord — distinct channel IDs from messages
  const discordChats = db.selectDistinct({ chatId: discordMessages.channelId })
    .from(discordMessages).all().map((r) => r.chatId);
  addEntries('discord', discordChats);

  // Slack — distinct channel IDs from messages
  const slackChats = db.selectDistinct({ chatId: slackMessages.channelId })
    .from(slackMessages).all().map((r) => r.chatId);
  addEntries('slack', slackChats);

  // Telegram — distinct chat IDs from messages (stored as integer, cast to string)
  const telegramChats = db.selectDistinct({ chatId: telegramMessages.chatId })
    .from(telegramMessages).all().map((r) => String(r.chatId));
  addEntries('telegram', telegramChats);

  // Twitter — distinct conversation IDs
  const twitterChats = db.selectDistinct({ chatId: twitterDms.conversationId })
    .from(twitterDms).all().map((r) => r.chatId);
  addEntries('twitter', twitterChats);

  // Also include any chats that have a mute entry but no messages (rare but possible)
  for (const [key, isMuted] of muteMap) {
    const colonIdx = key.indexOf(':');
    const source = key.slice(0, colonIdx);
    const chatId = key.slice(colonIdx + 1);
    if (!results.some((r) => r.source === source && r.chatId === chatId)) {
      results.push({ source, chatId, count: 0, isMuted });
    }
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
 */
export function broadcastUnreadForChat(source: string, chatId: string): void {
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

// ---------------------------------------------------------------------------
// Mark as read
// ---------------------------------------------------------------------------

/**
 * Record that the user read a chat at the current time.
 * Writes to chat_read_state and broadcasts count=0 for this chat.
 * Called by POST /api/unread/:source/:chatId/read.
 */
export function markChatRead(source: string, chatId: string): void {
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
