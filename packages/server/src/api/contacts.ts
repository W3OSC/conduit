/**
 * Contact API — designed for both the Conduit UI and AI agent consumers.
 *
 * All endpoints return clean, fully-specified JSON with no nulls hidden in
 * ambiguous shapes. AI agents can rely on the documented response schema.
 *
 * Endpoints:
 *   GET  /api/contacts                           — search / list contacts
 *   GET  /api/contacts/criteria/:service         — get contact filter criteria
 *   PUT  /api/contacts/criteria/:service         — update contact filter criteria
 *   GET  /api/contacts/:source/:platformId        — single contact detail
 *   GET  /api/contacts/:source/:platformId/history— full chat history (DMs + shared groups)
 *   GET  /api/contacts/:source/:platformId/dm-channel — resolve the DM channel ID
 *   POST /api/contacts/:source/:platformId/message — send a message to this contact
 *   POST /api/contacts/:source/:platformId/sync   — re-sync this specific contact's metadata
 *   DELETE /api/contacts/:source/:platformId      — remove from local DB only
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import {
  contacts, slackMessages, discordMessages, telegramMessages, twitterDms, gmailMessages, outbox, permissions, accounts,
} from '../db/schema.js';

import { eq, and, or, like, desc, lt, gte, sql, isNull } from 'drizzle-orm';
import { optionalAuth, writeAuditLog } from '../auth/middleware.js';
import { getContactCriteria, setContactCriteria, syncGmailContactsFromDb, syncCalendarContactsFromDb, rebuildContactsFromMessages, type ContactCriteria } from '../sync/contacts.js';
import { getConnectionManager } from '../connections/manager.js';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatContact(c: typeof contacts.$inferSelect) {
  return {
    id:          c.id,
    source:      c.source,
    platformId:  c.platformId,
    accountId:   c.accountId,
    displayName: c.displayName,
    username:    c.username,
    firstName:   c.firstName,
    lastName:    c.lastName,
    phone:       c.phone,
    avatarUrl:   c.avatarUrl,
    bio:         c.bio,
    statusText:  c.statusText,
    workspaceIds:    tryParse<string[]>(c.workspaceId, []),
    mutualGroupIds:  tryParse<string[]>(c.mutualGroupIds, []),
    criteria: {
      hasDm:            !!c.hasDm,
      isFromOwnedGroup: !!c.isFromOwnedGroup,
      isFromSmallGroup: !!c.isFromSmallGroup,
      isNativeContact:  !!c.isNativeContact,
    },
    firstSeenAt:   c.firstSeenAt,
    lastSeenAt:    c.lastSeenAt,
    lastMessageAt: c.lastMessageAt,
    updatedAt:     c.updatedAt,
  };
}

function tryParse<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

// ─── Activity score computation ────────────────────────────────────────────────
// Computes a per-contact activity score from the raw message tables:
//   DM messages the contact sent                    × 3  (direct engagement)
//   Messages in channels where the user also posted × 1  (shared participation)
//
// Uses SQL GROUP BY aggregation — does not load individual message rows.

interface ActivityScore {
  platformId: string;
  source: string;
  score: number;
  messageCount: number;
  lastMsgAt: string | null;
}

function computeActivityScores(db: ReturnType<typeof getDb>): Map<string, ActivityScore> {
  const scores = new Map<string, ActivityScore>();

  const merge = (source: string, platformId: string, delta: number, ts: string | null) => {
    const k = `${source}:${platformId}`;
    const existing = scores.get(k);
    if (existing) {
      existing.score += delta;
      existing.messageCount++;
      if (ts && (!existing.lastMsgAt || ts > existing.lastMsgAt)) existing.lastMsgAt = ts;
    } else {
      scores.set(k, { platformId, source, score: delta, messageCount: 1, lastMsgAt: ts });
    }
  };

  // ── Discord ────────────────────────────────────────────────────────────────
  const dcMyIds = new Set(
    db.select({ accountId: accounts.accountId }).from(accounts)
      .where(eq(accounts.source, 'discord')).all()
      .map((a) => a.accountId).filter(Boolean) as string[],
  );

  if (dcMyIds.size > 0) {
    // Channels where the authenticated user has posted (for shared-channel weight)
    const dcMyChannelRows = db.select({ channelId: discordMessages.channelId })
      .from(discordMessages)
      .where(sql`${discordMessages.authorId} IN (${sql.join(Array.from(dcMyIds).map((id) => sql`${id}`), sql`, `)})`)
      .groupBy(discordMessages.channelId)
      .all();
    const dcMyChannels = new Set(dcMyChannelRows.map((r) => r.channelId));

    // DM messages (no guildId) — weight 3 each
    const dcDmGroups = db.select({
      authorId: discordMessages.authorId,
      count: sql<number>`count(*)`,
      lastTs: sql<string>`max(${discordMessages.timestamp})`,
    }).from(discordMessages)
      .where(and(isNull(discordMessages.guildId), sql`${discordMessages.authorId} NOT IN (${sql.join(Array.from(dcMyIds).map((id) => sql`${id}`), sql`, `)})`))
      .groupBy(discordMessages.authorId)
      .all();

    for (const row of dcDmGroups) {
      if (!row.authorId) continue;
      for (let i = 0; i < row.count; i++) merge('discord', row.authorId, 3, row.lastTs);
    }

    // Shared-channel messages — weight 1 each, only in channels where we also posted
    if (dcMyChannels.size > 0) {
      const dcChGroups = db.select({
        authorId: discordMessages.authorId,
        count: sql<number>`count(*)`,
        lastTs: sql<string>`max(${discordMessages.timestamp})`,
      }).from(discordMessages)
        .where(and(
          sql`${discordMessages.guildId} IS NOT NULL`,
          sql`${discordMessages.channelId} IN (${sql.join(Array.from(dcMyChannels).map((id) => sql`${id}`), sql`, `)})`,
          sql`${discordMessages.authorId} NOT IN (${sql.join(Array.from(dcMyIds).map((id) => sql`${id}`), sql`, `)})`,
        ))
        .groupBy(discordMessages.authorId)
        .all();

      for (const row of dcChGroups) {
        if (!row.authorId) continue;
        for (let i = 0; i < row.count; i++) merge('discord', row.authorId, 1, row.lastTs);
      }
    }
  }

  // ── Slack ──────────────────────────────────────────────────────────────────
  const slMyIds = new Set(
    db.select({ accountId: accounts.accountId }).from(accounts)
      .where(eq(accounts.source, 'slack')).all()
      .map((a) => a.accountId).filter(Boolean) as string[],
  );

  if (slMyIds.size > 0) {
    const slMyChannelRows = db.select({ channelId: slackMessages.channelId })
      .from(slackMessages)
      .where(sql`${slackMessages.userId} IN (${sql.join(Array.from(slMyIds).map((id) => sql`${id}`), sql`, `)})`)
      .groupBy(slackMessages.channelId)
      .all();
    const slMyChannels = new Set(slMyChannelRows.map((r) => r.channelId));

    // DMs start with 'D', group DMs with 'G'
    const slDmGroups = db.select({
      userId: slackMessages.userId,
      count: sql<number>`count(*)`,
      lastTs: sql<string>`max(${slackMessages.timestamp})`,
    }).from(slackMessages)
      .where(and(
        sql`(${slackMessages.channelId} LIKE 'D%' OR ${slackMessages.channelId} LIKE 'G%')`,
        sql`${slackMessages.userId} NOT IN (${sql.join(Array.from(slMyIds).map((id) => sql`${id}`), sql`, `)})`,
      ))
      .groupBy(slackMessages.userId)
      .all();

    for (const row of slDmGroups) {
      if (!row.userId) continue;
      for (let i = 0; i < row.count; i++) merge('slack', row.userId, 3, row.lastTs);
    }

    if (slMyChannels.size > 0) {
      const slChGroups = db.select({
        userId: slackMessages.userId,
        count: sql<number>`count(*)`,
        lastTs: sql<string>`max(${slackMessages.timestamp})`,
      }).from(slackMessages)
        .where(and(
          sql`${slackMessages.channelId} NOT LIKE 'D%' AND ${slackMessages.channelId} NOT LIKE 'G%'`,
          sql`${slackMessages.channelId} IN (${sql.join(Array.from(slMyChannels).map((id) => sql`${id}`), sql`, `)})`,
          sql`${slackMessages.userId} NOT IN (${sql.join(Array.from(slMyIds).map((id) => sql`${id}`), sql`, `)})`,
        ))
        .groupBy(slackMessages.userId)
        .all();

      for (const row of slChGroups) {
        if (!row.userId) continue;
        for (let i = 0; i < row.count; i++) merge('slack', row.userId, 1, row.lastTs);
      }
    }
  }

  // ── Telegram ──────────────────────────────────────────────────────────────
  const tgMyIds = new Set(
    db.select({ accountId: accounts.accountId }).from(accounts)
      .where(eq(accounts.source, 'telegram')).all()
      .map((a) => a.accountId).filter(Boolean) as string[],
  );

  if (tgMyIds.size > 0) {
    const tgMyChats = new Set(
      db.select({ chatId: telegramMessages.chatId }).from(telegramMessages)
        .where(sql`CAST(${telegramMessages.senderId} AS TEXT) IN (${sql.join(Array.from(tgMyIds).map((id) => sql`${id}`), sql`, `)})`)
        .groupBy(telegramMessages.chatId)
        .all()
        .map((r) => r.chatId),
    );

    // Private chats (chatType = 'private'/'user', or positive chatId < 1e12)
    const tgDmGroups = db.select({
      senderId: telegramMessages.senderId,
      count: sql<number>`count(*)`,
      lastTs: sql<string>`max(${telegramMessages.timestamp})`,
    }).from(telegramMessages)
      .where(and(
        sql`(lower(${telegramMessages.chatType}) IN ('private', 'user') OR (${telegramMessages.chatType} IS NULL AND ${telegramMessages.chatId} > 0 AND ${telegramMessages.chatId} < 1000000000000))`,
        sql`CAST(${telegramMessages.senderId} AS TEXT) NOT IN (${sql.join(Array.from(tgMyIds).map((id) => sql`${id}`), sql`, `)})`,
      ))
      .groupBy(telegramMessages.senderId)
      .all();

    for (const row of tgDmGroups) {
      if (!row.senderId) continue;
      for (let i = 0; i < row.count; i++) merge('telegram', String(row.senderId), 3, row.lastTs);
    }

    if (tgMyChats.size > 0) {
      const tgChGroups = db.select({
        senderId: telegramMessages.senderId,
        count: sql<number>`count(*)`,
        lastTs: sql<string>`max(${telegramMessages.timestamp})`,
      }).from(telegramMessages)
        .where(and(
          sql`lower(${telegramMessages.chatType}) NOT IN ('private', 'user')`,
          sql`${telegramMessages.chatId} IN (${sql.join(Array.from(tgMyChats).map((id) => sql`${id}`), sql`, `)})`,
          sql`CAST(${telegramMessages.senderId} AS TEXT) NOT IN (${sql.join(Array.from(tgMyIds).map((id) => sql`${id}`), sql`, `)})`,
        ))
        .groupBy(telegramMessages.senderId)
        .all();

      for (const row of tgChGroups) {
        if (!row.senderId) continue;
        for (let i = 0; i < row.count; i++) merge('telegram', String(row.senderId), 1, row.lastTs);
      }
    }
  }

  // ── Twitter DMs ───────────────────────────────────────────────────────────
  const twMyIds = new Set(
    db.select({ accountId: accounts.accountId }).from(accounts)
      .where(eq(accounts.source, 'twitter')).all()
      .map((a) => a.accountId).filter(Boolean) as string[],
  );

  if (twMyIds.size > 0) {
    const twGroups = db.select({
      senderId: twitterDms.senderId,
      count: sql<number>`count(*)`,
      lastTs: sql<string>`max(${twitterDms.createdAt})`,
    }).from(twitterDms)
      .where(sql`${twitterDms.senderId} NOT IN (${sql.join(Array.from(twMyIds).map((id) => sql`${id}`), sql`, `)})`)
      .groupBy(twitterDms.senderId)
      .all();

    for (const row of twGroups) {
      if (!row.senderId) continue;
      for (let i = 0; i < row.count; i++) merge('twitter', row.senderId, 3, row.lastTs);
    }
  }

  return scores;
}

// ─── GET /api/contacts ────────────────────────────────────────────────────────

router.get('/', optionalAuth, (req, res) => {
  const {
    source, q, criteria: criteriaFilter,
    limit = '50', offset = '0',
  } = req.query as Record<string, string>;

  const db = getDb();
  const lim = Math.min(parseInt(limit) || 50, 500);
  const off = parseInt(offset) || 0;

  // Compute activity scores once for all contacts
  const activityScores = computeActivityScores(db);

  let rows = db.select().from(contacts).all();

  // Filter by source
  if (source) rows = rows.filter((c) => c.source === source);

  // Text search — display name, username, first name, last name
  if (q) {
    const term = q.toLowerCase();
    rows = rows.filter((c) =>
      [c.displayName, c.username, c.firstName, c.lastName]
        .some((f) => f?.toLowerCase().includes(term)),
    );
  }

  // Filter by criteria flag
  if (criteriaFilter) {
    switch (criteriaFilter) {
      case 'dm':      rows = rows.filter((c) => c.hasDm);            break;
      case 'owned':   rows = rows.filter((c) => c.isFromOwnedGroup); break;
      case 'small':   rows = rows.filter((c) => c.isFromSmallGroup); break;
      case 'native':  rows = rows.filter((c) => c.isNativeContact);  break;
    }
  }

  // Sort by activity score descending, then by lastMessageAt as tiebreaker
  rows.sort((a, b) => {
    const scoreA = activityScores.get(`${a.source}:${a.platformId}`)?.score ?? 0;
    const scoreB = activityScores.get(`${b.source}:${b.platformId}`)?.score ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    // Tiebreaker: most recently active
    return (b.lastMessageAt || '').localeCompare(a.lastMessageAt || '');
  });

  const total = rows.length;
  const page  = rows.slice(off, off + lim);

  // Attach activity score to each contact for transparency
  const enriched = page.map((c) => {
    const activity = activityScores.get(`${c.source}:${c.platformId}`);
    return {
      ...formatContact(c),
      activityScore: activity?.score ?? 0,
      messageCount: activity?.messageCount ?? 0,
    };
  });

  res.json({ contacts: enriched, total, limit: lim, offset: off });
});

// ─── Criteria routes ──────────────────────────────────────────────────────────

router.get('/criteria/:service', optionalAuth, (req, res) => {
  const service = req.params['service'] as string;
  res.json(getContactCriteria(service));
});

router.put('/criteria/:service', optionalAuth, (req, res) => {
  const service = req.params['service'] as string;
  const updates = req.body as Partial<ContactCriteria>;
  setContactCriteria(service, updates);
  res.json(getContactCriteria(service));
});

// ─── GET /api/contacts/:source/:platformId ─────────────────────────────────────

// POST /api/contacts/rebuild
// Re-scans existing message DB and upserts contacts based on current criteria.
// Does NOT call any platform APIs — applies criteria changes in real-time from stored data.
router.post('/rebuild', optionalAuth, async (req, res) => {
  const { source } = req.query as Record<string, string>;
  const sources = source ? [source] : ['slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar'];

  const db = getDb();
  let total = 0;

  // Message-based rebuild (no API calls) for chat sources
  const messageSources = sources.filter((s) => ['slack', 'discord', 'telegram', 'twitter'].includes(s));
  if (messageSources.length > 0) {
    total += rebuildContactsFromMessages(messageSources);
  }

  // Twitter following list — needs live API
  if (sources.includes('twitter')) {
    const criteria = getContactCriteria('twitter');
    if (criteria.nativeContacts || criteria.enabled) {
      const manager = getConnectionManager();
      const twitter = manager.getTwitter();
      if (twitter) {
        try {
          const followingCount = await twitter.syncFollowingContacts();
          total += followingCount;
        } catch (e) {
          console.error('[contacts] Twitter following sync failed during rebuild:', e);
        }
      }
    }
  }

  // Gmail contacts
  if (sources.includes('gmail')) {
    const criteria = getContactCriteria('gmail');
    if (criteria.enabled) {
      const gmailAccounts = db.select({ accountId: accounts.accountId })
        .from(accounts).where(eq(accounts.source, 'gmail')).all();
      const ownEmail = gmailAccounts[0]?.accountId ?? undefined;
      total += syncGmailContactsFromDb(ownEmail);
    }
  }

  // Calendar contacts
  if (sources.includes('calendar')) {
    const criteria = getContactCriteria('calendar');
    if (criteria.enabled) {
      const calAccounts = db.select({ accountId: accounts.accountId })
        .from(accounts).where(eq(accounts.source, 'gmail')).all();
      const ownEmail = calAccounts[0]?.accountId ?? undefined;
      total += syncCalendarContactsFromDb(ownEmail);
    }
  }

  // ── Post-process: write lastMessageAt and mutualGroupIds from message tables ──
  // This runs after the upsert loop so all contacts exist.
  const activityScores = computeActivityScores(db);

  for (const [key, score] of activityScores) {
    if (!score.lastMsgAt) continue;
    const colonIdx = key.indexOf(':');
    const scoreSource = key.slice(0, colonIdx);
    const scorePlatformId = key.slice(colonIdx + 1);
    if (sources.includes(scoreSource)) {
      db.update(contacts)
        .set({ lastMessageAt: score.lastMsgAt })
        .where(and(
          eq(contacts.source, scoreSource),
          eq(contacts.platformId, scorePlatformId),
          sql`(last_message_at IS NULL OR last_message_at < ${score.lastMsgAt})`,
        ))
        .run();
    }
  }

  // Compute mutualGroupIds: channels/groups where BOTH our account AND the contact sent messages
  for (const src of sources) {
    const myAccounts = db.select({ accountId: accounts.accountId })
      .from(accounts).where(eq(accounts.source, src)).all();
    const myIds = new Set(myAccounts.map((a) => a.accountId).filter(Boolean) as string[]);

    if (src === 'discord') {
      // For each contact, find guild channels where they sent messages AND we also sent messages
      const contactMessages = db.select({
        authorId: discordMessages.authorId,
        channelId: discordMessages.channelId,
      }).from(discordMessages)
        .where(sql`guild_id IS NOT NULL`)
        .all();

      // Build maps: authorId → Set<channelId> (their channels) and our channels
      const myChannels = new Set<string>();
      const contactChannels = new Map<string, Set<string>>();
      for (const row of contactMessages) {
        if (!row.authorId) continue;
        if (myIds.has(row.authorId)) { myChannels.add(row.channelId); continue; }
        if (!contactChannels.has(row.authorId)) contactChannels.set(row.authorId, new Set());
        contactChannels.get(row.authorId)!.add(row.channelId);
      }

      for (const [authorId, theirChannels] of contactChannels) {
        const mutual = [...theirChannels].filter((c) => myChannels.has(c));
        if (mutual.length === 0) continue;
        db.update(contacts)
          .set({ mutualGroupIds: JSON.stringify(mutual) })
          .where(and(eq(contacts.source, 'discord'), eq(contacts.platformId, authorId)))
          .run();
      }
    }

    if (src === 'slack') {
      const slackMsgs = db.select({
        userId: slackMessages.userId,
        channelId: slackMessages.channelId,
      }).from(slackMessages).all();

      const mySlackChannels = new Set<string>();
      const contactSlackChannels = new Map<string, Set<string>>();
      for (const row of slackMsgs) {
        if (!row.userId) continue;
        const isDm = row.channelId.startsWith('D') || row.channelId.startsWith('G');
        if (isDm) continue; // only track group channels
        if (myIds.has(row.userId)) { mySlackChannels.add(row.channelId); continue; }
        if (!contactSlackChannels.has(row.userId)) contactSlackChannels.set(row.userId, new Set());
        contactSlackChannels.get(row.userId)!.add(row.channelId);
      }

      for (const [userId, theirChannels] of contactSlackChannels) {
        const mutual = [...theirChannels].filter((c) => mySlackChannels.has(c));
        if (mutual.length === 0) continue;
        db.update(contacts)
          .set({ mutualGroupIds: JSON.stringify(mutual) })
          .where(and(eq(contacts.source, 'slack'), eq(contacts.platformId, userId)))
          .run();
      }
    }

    if (src === 'telegram') {
      const tgMsgs = db.select({
        senderId: telegramMessages.senderId,
        chatId: telegramMessages.chatId,
        chatType: telegramMessages.chatType,
      }).from(telegramMessages).all();

      const myTgChats = new Set<number>();
      const contactTgChats = new Map<string, Set<number>>();
      for (const row of tgMsgs) {
        if (!row.senderId) continue;
        const type = row.chatType?.toLowerCase() || '';
        // Only group/channel chats — skip private DMs
        const isGroup = type === 'group' || type === 'supergroup' || type === 'channel' ||
          (!type && (row.chatId < 0 || row.chatId > 1_000_000_000_000));
        if (!isGroup) continue;
        if (myIds.has(String(row.senderId))) { myTgChats.add(row.chatId); continue; }
        const id = String(row.senderId);
        if (!contactTgChats.has(id)) contactTgChats.set(id, new Set());
        contactTgChats.get(id)!.add(row.chatId);
      }

      for (const [senderId, theirChats] of contactTgChats) {
        const mutual = [...theirChats].filter((c) => myTgChats.has(c)).map(String);
        if (mutual.length === 0) continue;
        db.update(contacts)
          .set({ mutualGroupIds: JSON.stringify(mutual) })
          .where(and(eq(contacts.source, 'telegram'), eq(contacts.platformId, senderId)))
          .run();
      }
    }
  }

  res.json({ success: true, upserted: total, sources });
});

router.get('/:source/:platformId', optionalAuth, (req, res) => {
  const { source, platformId } = req.params as { source: string; platformId: string };
  const db = getDb();
  const contact = db.select().from(contacts)
    .where(and(eq(contacts.source, source), eq(contacts.platformId, platformId)))
    .get();
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json(formatContact(contact));
});

// ─── GET /api/contacts/:source/:platformId/history ────────────────────────────

router.get('/:source/:platformId/history', optionalAuth, (req, res) => {
  const { source, platformId } = req.params as { source: string; platformId: string };
  const { limit = '100', before, after } = req.query as Record<string, string>;
  const lim = Math.min(parseInt(limit) || 100, 500);
  const db = getDb();

  type HistoryMessage = {
    id: number;
    source: string;
    messageId: string;
    chatId: string;
    chatName: string | null;
    senderId: string;
    senderName: string;
    content: string;
    timestamp: string;
    context: 'dm' | 'group';
  };

  const messages: HistoryMessage[] = [];

  if (source === 'slack') {
    // Slack: messages where userId = platformId
    const rows = db.select().from(slackMessages)
      .where(
        and(
          eq(slackMessages.userId, platformId),
          before ? lt(slackMessages.timestamp, before) : undefined,
          after  ? gte(slackMessages.timestamp, after)  : undefined,
        ),
      )
      .orderBy(desc(slackMessages.timestamp))
      .limit(lim)
      .all();

    for (const r of rows) {
      messages.push({
        id: r.id, source: 'slack',
        messageId: r.messageId, chatId: r.channelId, chatName: r.channelName,
        senderId: r.userId || platformId, senderName: r.userName || platformId,
        content: r.content || '', timestamp: r.timestamp,
        context: r.channelName?.startsWith('dm:') ? 'dm' : 'group',
      });
    }
  } else if (source === 'discord') {
    const rows = db.select().from(discordMessages)
      .where(
        and(
          eq(discordMessages.authorId, platformId),
          before ? lt(discordMessages.timestamp, before) : undefined,
          after  ? gte(discordMessages.timestamp, after)  : undefined,
        ),
      )
      .orderBy(desc(discordMessages.timestamp))
      .limit(lim)
      .all();

    for (const r of rows) {
      messages.push({
        id: r.id, source: 'discord',
        messageId: r.messageId, chatId: r.channelId, chatName: r.channelName,
        senderId: r.authorId || platformId, senderName: r.authorName || platformId,
        content: r.content || '', timestamp: r.timestamp,
        context: r.guildId ? 'group' : 'dm',
      });
    }
  } else if (source === 'telegram') {
    const numId = parseInt(platformId);
    const rows = db.select().from(telegramMessages)
      .where(
        and(
          eq(telegramMessages.senderId, numId),
          before ? lt(telegramMessages.timestamp, before) : undefined,
          after  ? gte(telegramMessages.timestamp, after)  : undefined,
        ),
      )
      .orderBy(desc(telegramMessages.timestamp))
      .limit(lim)
      .all();

    for (const r of rows) {
      messages.push({
        id: r.id, source: 'telegram',
        messageId: String(r.messageId), chatId: String(r.chatId), chatName: r.chatName,
        senderId: String(r.senderId ?? platformId), senderName: r.senderName || platformId,
        content: r.content || '', timestamp: r.timestamp,
        context: r.chatType === 'private' ? 'dm' : 'group',
      });
    }
  } else if (source === 'twitter') {
    // Twitter: messages from this sender in any conversation
    const rows = db.select().from(twitterDms)
      .where(
        and(
          eq(twitterDms.senderId, platformId),
          before ? lt(twitterDms.createdAt, before) : undefined,
          after  ? gte(twitterDms.createdAt, after)  : undefined,
        ),
      )
      .orderBy(desc(twitterDms.createdAt))
      .limit(lim)
      .all();

    for (const r of rows) {
      messages.push({
        id: r.id, source: 'twitter',
        messageId: r.messageId, chatId: r.conversationId, chatName: r.senderHandle || r.conversationId,
        senderId: r.senderId, senderName: r.senderHandle || r.senderId,
        content: r.text || '', timestamp: r.createdAt,
        context: 'dm' as const,
      });
    }
  } else if (source === 'gmail') {
    // Gmail: messages from this sender address (platformId = email address)
    const rows = db.select().from(gmailMessages)
      .where(
        and(
          eq(gmailMessages.fromAddress, platformId),
          before ? lt(gmailMessages.internalDate, before) : undefined,
          after  ? gte(gmailMessages.internalDate, after)  : undefined,
        ),
      )
      .orderBy(desc(gmailMessages.internalDate))
      .limit(lim)
      .all();

    for (const r of rows) {
      messages.push({
        id: r.id, source: 'gmail',
        messageId: r.gmailId, chatId: r.threadId, chatName: r.subject || r.threadId,
        senderId: r.fromAddress || platformId, senderName: r.fromName || r.fromAddress || platformId,
        content: r.snippet || '', timestamp: r.internalDate || r.syncedAt || '',
        context: 'dm' as const,
      });
    }
  }

  writeAuditLog('read', 'ui', { service: source, targetId: platformId });

  res.json({ messages, total: messages.length, source, platformId });
});

// ─── GET /api/contacts/:source/:platformId/dm-channel ─────────────────────────

router.get('/:source/:platformId/dm-channel', optionalAuth, async (req, res) => {
  const { source, platformId } = req.params as { source: string; platformId: string };
  const manager = getConnectionManager();

  try {
    if (source === 'slack') {
      const slack = manager.getSlack();
      if (!slack) return res.status(503).json({ error: 'Slack not connected' });
      // Open or retrieve DM channel
      const channels = await slack.getChannels();
      const dm = channels.find((c) => c.type === 'im' && c.name === platformId);
      if (!dm) return res.status(404).json({ error: 'DM channel not found' });
      return res.json({ channelId: dm.id, channelName: dm.name });
    }

    if (source === 'discord') {
      // Discord DM channels are their own channel ID in the messages table
      const db = getDb();
      const row = db.select().from(discordMessages)
        .where(and(eq(discordMessages.authorId, platformId), sql`guild_id IS NULL`))
        .orderBy(desc(discordMessages.timestamp))
        .limit(1).get();
      if (!row) return res.status(404).json({ error: 'No DM channel found' });
      return res.json({ channelId: row.channelId, channelName: row.channelName || `DM-${platformId}` });
    }

    if (source === 'telegram') {
      // For Telegram, the DM channel ID is the user's platform ID
      return res.json({ channelId: platformId, channelName: platformId });
    }

    return res.status(400).json({ error: 'Unknown source' });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── POST /api/contacts/:source/:platformId/message ───────────────────────────

router.post('/:source/:platformId/message', optionalAuth, async (req, res) => {
  const { source, platformId } = req.params as { source: string; platformId: string };
  const { content } = req.body as { content?: string };
  if (!content?.trim()) return res.status(400).json({ error: 'content is required' });

  const db = getDb();
  const perm = db.select().from(permissions).where(eq(permissions.service, source)).get();

  if (!perm?.sendEnabled) {
    return res.status(403).json({ error: `Sending is disabled for ${source}` });
  }

  // Look up display name for the recipient
  const contact = db.select().from(contacts)
    .where(and(eq(contacts.source, source), eq(contacts.platformId, platformId)))
    .get();

  const recipientName = contact?.displayName || contact?.username || platformId;

  // Direct send if permissions allow, otherwise outbox
  const directSend = perm.directSendFromUi && !perm.requireApproval;

  if (directSend) {
    const manager = getConnectionManager();
    try {
      await manager.sendMessage(source as 'slack' | 'discord' | 'telegram', platformId, content.trim());
      const insertResult = db.insert(outbox).values({
        source, recipientId: platformId, recipientName,
        content: content.trim(), status: 'sent', requester: 'ui',
        sentAt: new Date().toISOString(),
      }).run();
      const insertedId = insertResult.lastInsertRowid as number;
      writeAuditLog('send', 'ui', { service: source, targetId: platformId, detail: { content: content.slice(0, 100) } });
      return res.json({ success: true, status: 'sent', outboxItemId: insertedId });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Queue to outbox
  const status = perm.requireApproval ? 'pending' : 'approved';
  const insertResult = db.insert(outbox).values({
    source, recipientId: platformId, recipientName,
    content: content.trim(), status, requester: 'ui',
  }).run();
  const insertedId = insertResult.lastInsertRowid as number;

  writeAuditLog('send_request', 'ui', { service: source, targetId: platformId });
  res.json({ success: true, status, outboxItemId: insertedId });
});

// ─── POST /api/contacts/:source/:platformId/sync ──────────────────────────────

router.post('/:source/:platformId/sync', optionalAuth, async (req, res) => {
  const { source, platformId } = req.params as { source: string; platformId: string };
  // Triggers a full contact sync for the service — not a targeted per-contact lookup.
  const manager = getConnectionManager();
  manager.triggerSync(source as 'slack' | 'discord' | 'telegram').catch(console.error);
  res.json({ success: true, message: `Contact sync triggered for ${source}` });
});

// ─── DELETE /api/contacts/:source/:platformId ─────────────────────────────────

router.delete('/:source/:platformId', optionalAuth, (req, res) => {
  const { source, platformId } = req.params as { source: string; platformId: string };
  const db = getDb();
  const result = db.delete(contacts)
    .where(and(eq(contacts.source, source), eq(contacts.platformId, platformId)))
    .run();
  if (result.changes === 0) return res.status(404).json({ error: 'Contact not found' });
  res.json({ success: true });
});

export default router;
