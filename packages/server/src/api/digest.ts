/**
 * GET /api/digest — the one-call agent briefing.
 *
 * Answers "what needs my attention?" in a single bounded response (~2k tokens)
 * instead of the 6-20 raw-list round trips agents previously needed:
 *
 *   needsReply      — chats whose LAST message is from someone else and is
 *                     newer than the chat's read cursor (max 15)
 *   unreadEmail     — count + top senders + latest unread subjects (max 5)
 *   upcomingEvents  — next 7 days (max 10)
 *   recentMeetings  — meet-notes in the window, excerpted (max 10)
 *   pendingOutbox   — actions awaiting human approval (max 10)
 *   unreadBySource  — per-service unread totals
 *
 * Fine-grained permissions apply: API keys see only sources/chats/labels their
 * key can read. Query params: since (ISO, default 24h ago — bounds needsReply),
 * meetings_days (default 14).
 */

import { Router } from 'express';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  gmailMessages, calendarEvents, meetNotes, outbox, settings,
  type GmailFineGrained, type CalendarFineGrained,
} from '../db/schema.js';
import { optionalAuth, trackAiCall, type AuthedRequest } from '../auth/middleware.js';
import {
  filterEnabledSources, filterReadIds, resolveTwitterReadPerms,
  resolveEffectiveFineGrained, isReadEnabled,
} from './permissions-utils.js';
import { sourceFilterPredicate, type FilterableService } from '../sync/source-filters.js';
import { z, boundedInt, isoDateTime, queryOf, validateQuery } from './validate.js';
import { documentRoute } from './openapi-registry.js';

const router = Router();

const DigestQuery = z.object({
  since: isoDateTime.optional().openapi({
    description: 'Only chats with activity after this instant are considered for needsReply. Defaults to 24 hours ago.',
  }),
  meetings_days: boundedInt({
    default: 14,
    max: 60,
    description: 'How many days back to include meeting notes for (default 14, max 60).',
  }),
});

documentRoute({
  method: 'get',
  path: '/digest',
  query: DigestQuery,
});

const EXCERPT_LEN = 200;

function excerpt(text: string | null | undefined, len = EXCERPT_LEN): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > len ? `${clean.slice(0, len)}…` : clean;
}

interface NeedsReplyItem {
  source: string;
  chatId: string;
  chatName: string;
  lastMessage: { senderName: string; excerpt: string; timestamp: string };
  unread: number;
}

/**
 * Per chat: the latest message row + unread count, keeping only chats where
 * that latest message is (a) not ours and (b) newer than the read cursor.
 */
function needsReplyForSource(
  db: ReturnType<typeof getDb>,
  cfg: {
    source: string; table: string; chatIdCol: string; chatNameExpr: string;
    senderIdCol: string; senderNameCol: string; contentCol: string; tsCol: string;
    /** Set for sources with a user-configured sync scope (source filter). */
    filterService?: FilterableService;
  },
  myIdsJson: string,
  unreadEpoch: string,
  limit: number,
): NeedsReplyItem[] {
  // User sync-scope: confine every scan to the configured source selection so
  // de-selected guilds/channels/chats never surface, even for stored history.
  const scope = cfg.filterService ? sourceFilterPredicate(cfg.filterService) : '1=1';
  const scopeM = cfg.filterService ? sourceFilterPredicate(cfg.filterService, 'm') : '1=1';
  const rows = db.all<{
    chatId: string; chatName: string | null; senderName: string | null;
    content: string | null; ts: string; unread: number;
  }>(sql.raw(`
    WITH latest AS (
      SELECT CAST(${cfg.chatIdCol} AS TEXT) AS chat_key,
             ${cfg.chatNameExpr} AS chat_name,
             CAST(${cfg.senderIdCol} AS TEXT) AS sender_id,
             ${cfg.senderNameCol} AS sender_name,
             ${cfg.contentCol} AS content,
             ${cfg.tsCol} AS ts,
             ROW_NUMBER() OVER (PARTITION BY ${cfg.chatIdCol} ORDER BY ${cfg.tsCol} DESC) AS rn
      FROM ${cfg.table}
      WHERE ${scope}
    ),
    own AS (
      -- Sending a message implicitly marks the chat read up to that point.
      SELECT CAST(${cfg.chatIdCol} AS TEXT) AS chat_key, MAX(${cfg.tsCol}) AS last_own_ts
      FROM ${cfg.table}
      WHERE CAST(${cfg.senderIdCol} AS TEXT) IN (SELECT value FROM json_each('${myIdsJson}'))
      GROUP BY ${cfg.chatIdCol}
    ),
    unread AS (
      SELECT CAST(m.${cfg.chatIdCol} AS TEXT) AS chat_key,
             SUM(CASE WHEN m.${cfg.tsCol} > MAX(COALESCE(r.last_read_at, '${unreadEpoch}'), COALESCE(o.last_own_ts, ''))
                       AND (m.${cfg.senderIdCol} IS NULL OR CAST(m.${cfg.senderIdCol} AS TEXT) NOT IN (SELECT value FROM json_each('${myIdsJson}')))
                      THEN 1 ELSE 0 END) AS unread
      FROM ${cfg.table} m
      LEFT JOIN chat_read_state r ON r.source = '${cfg.source}' AND r.chat_id = CAST(m.${cfg.chatIdCol} AS TEXT)
      LEFT JOIN own o ON o.chat_key = CAST(m.${cfg.chatIdCol} AS TEXT)
      WHERE ${scopeM}
      GROUP BY m.${cfg.chatIdCol}
    )
    SELECT l.chat_key AS chatId, l.chat_name AS chatName, l.sender_name AS senderName,
           l.content AS content, l.ts AS ts, u.unread AS unread
    FROM latest l JOIN unread u ON u.chat_key = l.chat_key
    LEFT JOIN chat_read_state r ON r.source = '${cfg.source}' AND r.chat_id = l.chat_key
    LEFT JOIN own o ON o.chat_key = l.chat_key
    WHERE l.rn = 1
      AND (l.sender_id IS NULL OR l.sender_id NOT IN (SELECT value FROM json_each('${myIdsJson}')))
      AND l.ts > MAX(COALESCE(r.last_read_at, '${unreadEpoch}'), COALESCE(o.last_own_ts, ''))
    ORDER BY l.ts DESC
    LIMIT ${limit}
  `));

  return rows.map((r) => ({
    source: cfg.source,
    chatId: r.chatId,
    chatName: r.chatName || r.chatId,
    lastMessage: {
      senderName: r.senderName || 'Unknown',
      excerpt: excerpt(r.content),
      timestamp: r.ts,
    },
    unread: r.unread,
  }));
}

router.get('/', optionalAuth, trackAiCall, validateQuery(DigestQuery), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const apiKeyId = authedReq.apiKey?.id ?? null;
  const now = new Date();
  const query = queryOf(DigestQuery, req);

  // `since` feeds sql.raw below. validateQuery has already rejected anything
  // unparseable, but this re-parse + re-serialise is kept deliberately: it
  // guarantees only a canonical ISO string can ever reach raw SQL, whatever
  // upstream does.
  const sinceMs = query.since ? Date.parse(query.since) : now.getTime() - 24 * 60 * 60 * 1000;
  if (!Number.isFinite(sinceMs)) {
    res.status(400).json({ error: 'since must be an ISO-8601 timestamp' });
    return;
  }
  const since = new Date(sinceMs).toISOString();
  const meetingsDays = query.meetings_days ?? 14;

  const epochRow = db.select().from(settings).where(eq(settings.key, 'chat.unreadEpoch')).get();
  const unreadEpoch = epochRow?.value ?? now.toISOString();

  // JSON-encode "my" account ids per source for the NOT IN filters.
  const myIds = (source: string): string => {
    const rows = db.all<{ accountId: string }>(sql`SELECT account_id AS accountId FROM accounts WHERE source = ${source}`);
    return JSON.stringify(rows.map((r) => r.accountId)).replace(/'/g, "''");
  };

  const chatSources = filterEnabledSources(['slack', 'discord', 'telegram', 'twitter'], apiKeyId);

  // ── needsReply ─────────────────────────────────────────────────────────────
  let needsReply: NeedsReplyItem[] = [];
  const boundedEpoch = since > unreadEpoch ? since : unreadEpoch;

  if (chatSources.includes('slack')) {
    needsReply.push(...needsReplyForSource(db, {
      source: 'slack', table: 'slack_messages', chatIdCol: 'channel_id',
      chatNameExpr: 'channel_name', senderIdCol: 'user_id', senderNameCol: 'user_name',
      contentCol: 'content', tsCol: 'timestamp', filterService: 'slack',
    }, myIds('slack'), boundedEpoch, 15));
  }
  if (chatSources.includes('discord')) {
    needsReply.push(...needsReplyForSource(db, {
      source: 'discord', table: 'discord_messages', chatIdCol: 'channel_id',
      chatNameExpr: "COALESCE(guild_name || ' #' || channel_name, channel_name)",
      senderIdCol: 'author_id', senderNameCol: 'author_name',
      contentCol: 'content', tsCol: 'timestamp', filterService: 'discord',
    }, myIds('discord'), boundedEpoch, 15));
  }
  if (chatSources.includes('telegram')) {
    needsReply.push(...needsReplyForSource(db, {
      source: 'telegram', table: 'telegram_messages', chatIdCol: 'chat_id',
      chatNameExpr: 'chat_name', senderIdCol: 'sender_id', senderNameCol: 'sender_name',
      contentCol: 'content', tsCol: 'timestamp', filterService: 'telegram',
    }, myIds('telegram'), boundedEpoch, 15));
  }
  if (chatSources.includes('twitter') && (!apiKeyId || resolveTwitterReadPerms(apiKeyId).readDms)) {
    needsReply.push(...needsReplyForSource(db, {
      source: 'twitter', table: 'twitter_dms', chatIdCol: 'conversation_id',
      chatNameExpr: 'sender_handle', senderIdCol: 'sender_id', senderNameCol: 'sender_name',
      contentCol: 'text', tsCol: 'created_at',
    }, myIds('twitter'), boundedEpoch, 15));
  }

  // Fine-grained chat allowlists for API keys.
  if (apiKeyId) {
    needsReply = needsReply.filter((item) => {
      if (item.source === 'twitter') return true; // handled by readDms above
      return filterReadIds(item.source, [item.chatId], apiKeyId).length > 0;
    });
  }
  needsReply.sort((a, b) => b.lastMessage.timestamp.localeCompare(a.lastMessage.timestamp));
  needsReply = needsReply.slice(0, 15);

  // ── unreadEmail ────────────────────────────────────────────────────────────
  let unreadEmail: {
    count: number;
    topSenders: Array<{ name: string; count: number }>;
    latest: Array<{ gmailId: string; threadId: string; from: string; subject: string | null; receivedAt: string | null }>;
  } | null = null;

  if (isReadEnabled('gmail', apiKeyId)) {
    const gmailFg = apiKeyId
      ? resolveEffectiveFineGrained('gmail', apiKeyId) as GmailFineGrained | null
      : null;
    const labelAllow = gmailFg?.readLabelIds;

    let unreadRows = db.select().from(gmailMessages)
      .where(eq(gmailMessages.isRead, false))
      .orderBy(desc(gmailMessages.internalDate))
      .limit(500)
      .all();
    if (labelAllow?.length) {
      unreadRows = unreadRows.filter((m) => {
        try { return (JSON.parse(m.labels || '[]') as string[]).some((l) => labelAllow.includes(l)); }
        catch { return false; }
      });
    }

    const senderCounts = new Map<string, number>();
    for (const m of unreadRows) {
      const key = m.fromName || m.fromAddress || 'Unknown';
      senderCounts.set(key, (senderCounts.get(key) ?? 0) + 1);
    }

    unreadEmail = {
      count: unreadRows.length,
      topSenders: [...senderCounts.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([name, count]) => ({ name, count })),
      latest: unreadRows.slice(0, 5).map((m) => ({
        gmailId: m.gmailId,
        threadId: m.threadId,
        from: m.fromName || m.fromAddress || '',
        subject: m.subject,
        receivedAt: m.internalDate,
      })),
    };
  }

  // ── upcomingEvents ─────────────────────────────────────────────────────────
  let upcomingEvents: Array<{
    eventId: string; title: string | null; startTime: string; endTime: string | null;
    meetLink: string | null; attendeeCount: number;
  }> = [];

  if (isReadEnabled('calendar', apiKeyId)) {
    const calFg = apiKeyId
      ? resolveEffectiveFineGrained('calendar', apiKeyId) as CalendarFineGrained | null
      : null;
    const calAllow = calFg?.readCalendarIds;

    const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    let events = db.select().from(calendarEvents)
      .where(and(gte(calendarEvents.startTime, now.toISOString()), lte(calendarEvents.startTime, in7days)))
      .orderBy(calendarEvents.startTime)
      .limit(50)
      .all();
    if (calAllow?.length) events = events.filter((e) => calAllow.includes(e.calendarId));

    upcomingEvents = events.slice(0, 10).map((e) => {
      let attendeeCount = 0;
      try { attendeeCount = (JSON.parse(e.attendees || '[]') as unknown[]).length; } catch { /* ignore */ }
      return {
        eventId: e.eventId,
        title: e.title,
        startTime: e.startTime,
        endTime: e.endTime,
        meetLink: e.meetLink ?? null,
        attendeeCount,
      };
    });
  }

  // ── recentMeetings ─────────────────────────────────────────────────────────
  let recentMeetings: Array<{
    id: number; title: string | null; meetingDate: string | null; excerpt: string;
  }> = [];

  if (isReadEnabled('calendar', apiKeyId)) {
    const meetingsSince = new Date(now.getTime() - meetingsDays * 24 * 60 * 60 * 1000).toISOString();
    recentMeetings = db.select().from(meetNotes)
      .where(gte(meetNotes.meetingDate, meetingsSince))
      .orderBy(desc(meetNotes.meetingDate))
      .limit(10)
      .all()
      .map((n) => ({
        id: n.id,
        title: n.title,
        meetingDate: n.meetingDate,
        excerpt: excerpt(n.summary, 280),
      }));
  }

  // ── pendingOutbox ──────────────────────────────────────────────────────────
  const outboxScope = apiKeyId ? and(eq(outbox.status, 'pending'), eq(outbox.apiKeyId, apiKeyId)) : eq(outbox.status, 'pending');
  const pendingItems = db.select().from(outbox)
    .where(outboxScope)
    .orderBy(desc(outbox.createdAt))
    .limit(10)
    .all();
  const pendingCount = db.select({ c: sql<number>`count(*)` }).from(outbox).where(outboxScope).get()?.c ?? 0;

  // ── per-source unread totals ───────────────────────────────────────────────
  const unreadBySource: Record<string, number> = {};
  for (const src of chatSources) {
    if (src === 'twitter' && apiKeyId && !resolveTwitterReadPerms(apiKeyId).readDms) continue;
    const table = { slack: 'slack_messages', discord: 'discord_messages', telegram: 'telegram_messages', twitter: 'twitter_dms' }[src]!;
    const chatCol = { slack: 'channel_id', discord: 'channel_id', telegram: 'chat_id', twitter: 'conversation_id' }[src]!;
    const senderCol = { slack: 'user_id', discord: 'author_id', telegram: 'sender_id', twitter: 'sender_id' }[src]!;
    const tsCol = src === 'twitter' ? 'created_at' : 'timestamp';
    const idsJson = myIds(src);
    // User sync-scope: unread totals must not count de-selected sources.
    const scopeM = src === 'twitter' ? '1=1' : sourceFilterPredicate(src as FilterableService, 'm');
    const row = db.all<{ n: number }>(sql.raw(`
      WITH own AS (
        SELECT CAST(${chatCol} AS TEXT) AS chat_key, MAX(${tsCol}) AS last_own_ts
        FROM ${table}
        WHERE CAST(${senderCol} AS TEXT) IN (SELECT value FROM json_each('${idsJson}'))
        GROUP BY ${chatCol}
      )
      SELECT COALESCE(SUM(CASE WHEN m.${tsCol} > MAX(COALESCE(r.last_read_at, '${unreadEpoch}'), COALESCE(o.last_own_ts, ''))
                    AND (m.${senderCol} IS NULL OR CAST(m.${senderCol} AS TEXT) NOT IN (SELECT value FROM json_each('${idsJson}')))
                   THEN 1 ELSE 0 END), 0) AS n
      FROM ${table} m
      LEFT JOIN chat_read_state r ON r.source = '${src}' AND r.chat_id = CAST(m.${chatCol} AS TEXT)
      LEFT JOIN own o ON o.chat_key = CAST(m.${chatCol} AS TEXT)
      WHERE ${scopeM}
    `));
    unreadBySource[src] = row[0]?.n ?? 0;
  }
  if (unreadEmail) unreadBySource['gmail'] = unreadEmail.count;

  res.json({
    generatedAt: now.toISOString(),
    window: { since, until: now.toISOString() },
    needsReply,
    unreadEmail,
    upcomingEvents,
    recentMeetings,
    pendingOutbox: {
      count: pendingCount,
      items: pendingItems.map((i) => ({
        id: i.id,
        source: i.source,
        recipientName: i.recipientName,
        preview: excerpt(i.content, 140),
        createdAt: i.createdAt,
      })),
    },
    unreadBySource,
  });
});

export default router;
