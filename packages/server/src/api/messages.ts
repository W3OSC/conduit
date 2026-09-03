import { Router } from 'express';
import { getDb } from '../db/client.js';
import {
  telegramMessages, discordMessages, slackMessages, twitterDms, gmailMessages,
  syncState, syncRuns, errorLog, contacts, accounts, settings, chatReadState,
} from '../db/schema.js';
import { eq, and, desc, like, gte, lte, sql, isNull, inArray } from 'drizzle-orm';
import { optionalAuth, uiOnlyAuth, writeAuditLog, trackAiCall, type AuthedRequest } from '../auth/middleware.js';
import { broadcast } from '../websocket/hub.js';
import {
  filterReadIds, filterGmailByLabels, resolveTwitterReadPerms, resolveEffectiveFineGrained,
  isReadPermitted, filterEnabledSources,
} from './permissions-utils.js';
import type { DiscordFineGrained } from '../db/schema.js';
import { sourceFilterPredicate } from '../sync/source-filters.js';
import {
  z, booleanFlag, isoDateTime, limitSchema, messageSourceSchema, optionalMessageSource,
  requiredString, MESSAGE_SOURCES, bodyOf, paramsOf, queryOf, validateBody, validateParams, validateQuery,
} from './validate.js';
import { documentRoute } from './openapi-registry.js';

// ── Request schemas ───────────────────────────────────────────────────────────

const MessagesQuery = z.object({
  source: optionalMessageSource,
  chat_id: z.string().optional().openapi({ description: 'Restrict to a single conversation/channel/thread.' }),
  limit: limitSchema(50, 500),
  before: isoDateTime.optional().openapi({ description: 'Only messages at or before this instant.' }),
  after: isoDateTime.optional().openapi({ description: 'Only messages at or after this instant.' }),
  around: isoDateTime.optional().openapi({ description: 'Centre the window on this instant (half before, half after).' }),
  include_meta: booleanFlag.openapi({ description: 'Include conversationMeta (requires chat_id and source).' }),
});

const SearchQuery = z.object({
  q: requiredString('q')
    .openapi({ description: 'Substring to search message content for.' }),
  source: optionalMessageSource,
  limit: limitSchema(50, 200),
});

/**
 * `sources` stays permissive on purpose: unknown entries are dropped rather
 * than rejected, exactly as `filterEnabledSources` did before.
 */
const ActivityQuery = z.object({
  since: isoDateTime.optional().openapi({ description: 'Start of the window (default: 24 hours ago).' }),
  until: isoDateTime.optional().openapi({ description: 'End of the window (default: now).' }),
  limit: limitSchema(50, 200),
  sources: z.string().optional()
    .transform((v) => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean)))
    .openapi({ type: 'string', description: `Comma-separated subset of ${MESSAGE_SOURCES.join(', ')}. Unknown entries are ignored.` }),
});

const ChatReadParams = z.object({
  source: messageSourceSchema,
  chatId: z.string().min(1),
});

const ChatReadBody = z.object({
  at: isoDateTime.optional().openapi({ description: 'Read cursor to set (default: now).' }),
});

const ReadAllBody = z.object({
  source: messageSourceSchema.optional().openapi({ description: 'Limit the sweep to one source (default: all chat sources).' }),
});

documentRoute({ method: 'get', path: '/messages', query: MessagesQuery });
documentRoute({ method: 'get', path: '/search', query: SearchQuery });
documentRoute({ method: 'get', path: '/activity', query: ActivityQuery });
documentRoute({
  method: 'post',
  path: '/chats/{source}/{chatId}/read',
  params: ChatReadParams,
  body: ChatReadBody,
  bodyRequired: false,
});
documentRoute({ method: 'post', path: '/chats/read-all', body: ReadAllBody, bodyRequired: false });

// ── Contact enrichment cache (per request) ────────────────────────────────────
// Build a map of (source + platformId) → { displayName, avatarUrl } from the
// contacts table, used to enrich messages with profile data and the `isMe` flag.

function buildContactCache(db: ReturnType<typeof getDb>, source: string): {
  contacts: Map<string, { displayName: string | null; avatarUrl: string | null }>;
  myAccountIds: Set<string>;
} {
  const allContacts = db.select({
    platformId: contacts.platformId,
    displayName: contacts.displayName,
    avatarUrl: contacts.avatarUrl,
  }).from(contacts).where(eq(contacts.source, source)).all();

  const contactMap = new Map<string, { displayName: string | null; avatarUrl: string | null }>();
  for (const c of allContacts) {
    contactMap.set(c.platformId, { displayName: c.displayName, avatarUrl: c.avatarUrl });
  }

  // Get our own account IDs so we can set isMe
  const myAccounts = db.select({ accountId: accounts.accountId })
    .from(accounts).where(eq(accounts.source, source)).all();
  const myAccountIds = new Set(myAccounts.map((a) => a.accountId));

  // For Twitter, also seed from the stored credentials (userId field) since the
  // accounts table may be empty when only cookie-based auth is used.
  if (source === 'twitter') {
    try {
      const credRow = db.select({ value: settings.value })
        .from(settings).where(eq(settings.key, 'credentials.twitter')).get();
      if (credRow?.value) {
        const creds = JSON.parse(credRow.value) as { userId?: string };
        if (creds.userId) myAccountIds.add(String(creds.userId));
      }
    } catch {
      // ignore malformed credentials
    }
  }

  return { contacts: contactMap, myAccountIds };
}

function enrichSender(
  platformId: string | null | undefined,
  rawName: string | null | undefined,
  cache: ReturnType<typeof buildContactCache>,
  source?: string,
): { senderName: string; avatarUrl: string | null; isMe: boolean } {
  const id = platformId ?? '';
  const contact = id ? cache.contacts.get(id) : null;

  // For Discord: construct a default avatar URL from the user's discriminator / snowflake
  // even when no contact record exists, so the UI shows a real Discord avatar.
  let avatarUrl = contact?.avatarUrl ?? null;
  if (!avatarUrl && source === 'discord' && id) {
    // Default Discord avatar based on user ID (works without knowing the hash)
    const defaultIndex = (BigInt(id) >> 22n) % 6n;
    avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }

  return {
    senderName: contact?.displayName || rawName || id || 'Unknown',
    avatarUrl,
    isMe: id ? cache.myAccountIds.has(id) : false,
  };
}

const router = Router();

const MSG_SOURCES = ['telegram', 'discord', 'slack', 'twitter', 'gmail'] as const;

// ── Unread model ──────────────────────────────────────────────────────────────
// Per-chat read cursors live in chat_read_state. Chats without a row count
// unread only from the "unread epoch" (first boot with the unread model), so
// a fresh install doesn't show years of backlog as unread.

let cachedUnreadEpoch: string | null = null;

function getUnreadEpoch(db: ReturnType<typeof getDb>): string {
  if (cachedUnreadEpoch) return cachedUnreadEpoch;
  const row = db.select().from(settings).where(eq(settings.key, 'chat.unreadEpoch')).get();
  if (row) {
    cachedUnreadEpoch = row.value;
  } else {
    cachedUnreadEpoch = new Date().toISOString();
    db.insert(settings)
      .values({ key: 'chat.unreadEpoch', value: cachedUnreadEpoch, updatedAt: cachedUnreadEpoch })
      .onConflictDoNothing()
      .run();
  }
  return cachedUnreadEpoch;
}

// Telegram dialog folders come from a live MTProto RPC — cache them so /chats
// never blocks on the network (5-minute TTL, refreshed opportunistically).
let tgFolderCache: { at: number; map: Map<string, { id: number; title: string }> } | null = null;
const TG_FOLDER_TTL_MS = 5 * 60 * 1000;

router.get('/status', optionalAuth, (req, res) => {
  const db = getDb();

  // ── Message counts: one UNION ALL query instead of 5 separate COUNTs ──────
  const msgCountRows = db.all<{ source: string; cnt: number }>(sql`
    SELECT 'telegram' AS source, COUNT(*) AS cnt FROM telegram_messages
    UNION ALL
    SELECT 'discord',  COUNT(*) FROM discord_messages
    UNION ALL
    SELECT 'slack',    COUNT(*) FROM slack_messages
    UNION ALL
    SELECT 'twitter',  COUNT(*) FROM twitter_dms
    UNION ALL
    SELECT 'gmail',    COUNT(*) FROM gmail_messages
    UNION ALL
    SELECT '_errors',  COUNT(*) FROM error_log
  `);
  const msgCounts: Record<string, number> = {};
  for (const row of msgCountRows) msgCounts[row.source] = Number(row.cnt);

  // ── Chat counts ───────────────────────────────────────────────────────────
  // telegram/discord/slack: rows in sync_state (one per chat)
  // twitter: distinct conversation_ids in twitter_dms
  // gmail: distinct thread_ids in gmail_messages
  const chatCountRows = db.all<{ source: string; cnt: number }>(sql`
    SELECT source, COUNT(*) AS cnt FROM sync_state
    WHERE source IN ('telegram', 'discord', 'slack')
    GROUP BY source
    UNION ALL
    SELECT 'twitter', COUNT(DISTINCT conversation_id) FROM twitter_dms
    UNION ALL
    SELECT 'gmail',   COUNT(DISTINCT thread_id)       FROM gmail_messages
  `);
  const chatCounts: Record<string, number> = {};
  for (const row of chatCountRows) chatCounts[row.source] = Number(row.cnt);

  // ── Last sync run per source: one query with ROW_NUMBER window function ───
  const lastRunRows = db.all<{
    id: number; source: string; syncType: string; status: string;
    startedAt: string; finishedAt: string | null;
    chatsVisited: number | null; messagesSaved: number | null; error: string | null;
    rn: number;
  }>(sql`
    SELECT id, source, sync_type AS syncType, status, started_at AS startedAt,
           finished_at AS finishedAt, chats_visited AS chatsVisited,
           messages_saved AS messagesSaved, error_message AS error, rn
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC) AS rn
      FROM sync_runs
    ) ranked
    WHERE rn = 1
  `);
  const lastRuns: Record<string, unknown> = {};
  for (const row of lastRunRows) lastRuns[row.source] = row;

  // ── Active syncs ──────────────────────────────────────────────────────────
  const activeRuns = db.select().from(syncRuns)
    .where(and(eq(syncRuns.status, 'running'), isNull(syncRuns.finishedAt)))
    .orderBy(desc(syncRuns.startedAt))
    .all();

  const activeSyncs: Record<string, {
    id: number; source: string; syncType: string;
    chatsVisited: number; messagesSaved: number; startedAt: string;
  }> = {};
  for (const run of activeRuns) {
    if (!activeSyncs[run.source]) {
      activeSyncs[run.source] = {
        id: run.id,
        source: run.source,
        syncType: run.syncType,
        chatsVisited: run.chatsVisited ?? 0,
        messagesSaved: run.messagesSaved ?? 0,
        startedAt: run.startedAt,
      };
    }
  }

  res.json({
    messageCounts: {
      telegram: msgCounts['telegram'] ?? 0,
      discord:  msgCounts['discord']  ?? 0,
      slack:    msgCounts['slack']    ?? 0,
      twitter:  msgCounts['twitter']  ?? 0,
      gmail:    msgCounts['gmail']    ?? 0,
    },
    errorCount: msgCounts['_errors'] ?? 0,
    chatCounts: {
      telegram: chatCounts['telegram'] ?? 0,
      discord:  chatCounts['discord']  ?? 0,
      slack:    chatCounts['slack']    ?? 0,
      twitter:  chatCounts['twitter']  ?? 0,
      gmail:    chatCounts['gmail']    ?? 0,
    },
    lastSync: lastRuns,
    activeSyncs,
  });
});

/**
 * /chats returns a structured tree per service for the chat sidebar.
 *
 * Shape per service:
 *   { sections: ChatSection[] }
 *
 * ChatSection: { id, label, type: 'dms'|'server'|'channel-group'|'flat', chats: ChatEntry[], children?: ChatSection[] }
 * ChatEntry:   { id, name, source, messageCount, lastTs, unread? }
 *
 * Discord:  DMs section + one section per guild → channels inside
 * Slack:    DMs section + Channels section (all #channels)
 * Telegram: DMs section + Groups section + Channels section (by chatType)
 * Twitter:  DMs section only
 * Gmail:    flat thread list
 */
router.get('/chats', optionalAuth, trackAiCall, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const apiKeyId = authedReq.apiKey?.id ?? null;

  interface ChatEntry {
    id: string; name: string; source: string;
    messageCount: number; lastTs?: string;
    unread?: number;                 // messages newer than the chat's read cursor
    avatarUrl?: string | null;
    guildId?: string | null;         // Discord server channels only
    lastMessageId?: string | number | null; // Telegram: for message-level deep links
  }
  interface ChatSection {
    id: string; label: string;
    type: 'dms' | 'server' | 'channels' | 'flat';
    chats: ChatEntry[];
    children?: ChatSection[]; // for Discord: sections per guild
  }
  interface ServiceTree {
    source: string;
    sections: ChatSection[];
  }

  const result: Record<string, ServiceTree> = {};

  // Service-level read toggles for API keys — a disabled service contributes
  // no tree at all.
  const enabledChatSources = new Set(
    filterEnabledSources(['discord', 'slack', 'telegram', 'twitter', 'gmail'], apiKeyId),
  );

  // ── Discord ─────────────────────────────────────────────────────────────────
  if (enabledChatSources.has('discord')) {
    const dcCache = buildContactCache(db, 'discord');
    const unreadEpoch = getUnreadEpoch(db);
    const dcMyIds = JSON.stringify([...dcCache.myAccountIds]);

    // One pass: latest row per channel (name/guild) + count + unread, instead
    // of 3 queries per channel. Both scans honour the user's guild sync-scope
    // so de-selected servers vanish immediately, stored history included.
    const dcScope = sql.raw(sourceFilterPredicate('discord'));
    const dcScopeM = sql.raw(sourceFilterPredicate('discord', 'm'));
    const dcRows = db.all<{
      channelId: string; channelName: string | null; guildId: string | null;
      guildName: string | null; cnt: number; latestTs: string; unread: number;
    }>(sql`
      WITH latest AS (
        SELECT channel_id, channel_name, guild_id, guild_name,
               ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY timestamp DESC) AS rn
        FROM discord_messages
        WHERE ${dcScope}
      ),
      own AS (
        SELECT channel_id AS ch, MAX(timestamp) AS last_own_ts
        FROM discord_messages
        WHERE author_id IN (SELECT value FROM json_each(${dcMyIds}))
        GROUP BY channel_id
      ),
      stats AS (
        SELECT m.channel_id AS ch,
               COUNT(*) AS cnt,
               MAX(m.timestamp) AS latest_ts,
               SUM(CASE WHEN m.timestamp > MAX(COALESCE(r.last_read_at, ${unreadEpoch}), COALESCE(o.last_own_ts, ''))
                         AND (m.author_id IS NULL OR m.author_id NOT IN (SELECT value FROM json_each(${dcMyIds})))
                        THEN 1 ELSE 0 END) AS unread
        FROM discord_messages m
        LEFT JOIN chat_read_state r ON r.source = 'discord' AND r.chat_id = m.channel_id
        LEFT JOIN own o ON o.ch = m.channel_id
        WHERE ${dcScopeM}
        GROUP BY m.channel_id
      )
      SELECT l.channel_id AS channelId, l.channel_name AS channelName,
             l.guild_id AS guildId, l.guild_name AS guildName,
             s.cnt AS cnt, s.latest_ts AS latestTs, s.unread AS unread
      FROM latest l JOIN stats s ON s.ch = l.channel_id
      WHERE l.rn = 1
    `);

    // Fine-grained read enforcement: filter channels and guilds for API key actors
    const discordFg = apiKeyId
      ? resolveEffectiveFineGrained('discord', apiKeyId) as DiscordFineGrained | null
      : null;
    const allowedDiscordChannels = discordFg?.readChannelIds;
    const allowedDiscordGuilds = discordFg?.readGuildIds;
    const channels = dcRows.filter((ch) => {
      if (!apiKeyId) return true;
      if (allowedDiscordChannels?.length && !allowedDiscordChannels.includes(ch.channelId)) return false;
      if (allowedDiscordGuilds?.length && ch.guildId && !allowedDiscordGuilds.includes(ch.guildId)) return false;
      return true;
    });

    // DM participant names: one query for all DM channels, grouped in JS.
    const dmParticipants = db.all<{ channelId: string; authorId: string | null; authorName: string | null }>(sql`
      SELECT DISTINCT channel_id AS channelId, author_id AS authorId, author_name AS authorName
      FROM discord_messages WHERE guild_id IS NULL
    `);
    const dmParticipantsByChannel = new Map<string, Array<{ authorId: string | null; authorName: string | null }>>();
    for (const p of dmParticipants) {
      const list = dmParticipantsByChannel.get(p.channelId) ?? [];
      list.push(p);
      dmParticipantsByChannel.set(p.channelId, list);
    }

    const dmChats: ChatEntry[] = [];
    const guilds = new Map<string, { name: string; channels: ChatEntry[] }>();

    for (const ch of channels) {
      const entry: ChatEntry = {
        id: ch.channelId,
        name: ch.channelName || ch.channelId,
        source: 'discord',
        messageCount: ch.cnt,
        lastTs: ch.latestTs || undefined,
        unread: ch.unread,
        guildId: ch.guildId || null,
      };

      if (!ch.guildId) {
        // DM — enrich with contact display name and avatar.
        for (const row of dmParticipantsByChannel.get(ch.channelId) ?? []) {
          if (!row.authorId || dcCache.myAccountIds.has(row.authorId)) continue;
          const contact = dcCache.contacts.get(row.authorId);
          if (contact?.displayName) {
            entry.name = contact.displayName;
            entry.avatarUrl = contact.avatarUrl ?? null;
          } else if (row.authorName && row.authorName !== 'Unknown') {
            entry.name = row.authorName;
            entry.avatarUrl = null;
          }
          break;
        }
        dmChats.push(entry);
      } else {
        const guildKey = ch.guildId;
        if (!guilds.has(guildKey)) {
          guilds.set(guildKey, { name: ch.guildName || ch.guildId, channels: [] });
        }
        guilds.get(guildKey)!.channels.push(entry);
      }
    }

    const sections: ChatSection[] = [];
    if (dmChats.length) {
      sections.push({
        id: 'discord-dms', label: 'Direct Messages', type: 'dms',
        chats: dmChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')),
      });
    }
    // Sort guilds by most recent activity across their channels
    const sortedGuilds = [...guilds.entries()].sort(([, a], [, b]) => {
      const aTs = a.channels.reduce((m, c) => c.lastTs && c.lastTs > m ? c.lastTs : m, '');
      const bTs = b.channels.reduce((m, c) => c.lastTs && c.lastTs > m ? c.lastTs : m, '');
      return bTs.localeCompare(aTs);
    });

    for (const [guildId, guild] of sortedGuilds) {
      sections.push({
        id: `discord-guild-${guildId}`, label: guild.name, type: 'server',
        chats: guild.channels.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')),
      });
    }

    if (sections.length) result['discord'] = { source: 'discord', sections };
  }

  // ── Slack ───────────────────────────────────────────────────────────────────
  if (enabledChatSources.has('slack')) {
    const slackCache = buildContactCache(db, 'slack');
    const unreadEpoch = getUnreadEpoch(db);
    const slMyIds = JSON.stringify([...slackCache.myAccountIds]);

    // User sync-scope: non-DM conversations outside slack.syncChannels are
    // hidden, stored history included.
    const slScope = sql.raw(sourceFilterPredicate('slack'));
    const slScopeM = sql.raw(sourceFilterPredicate('slack', 'm'));
    const slRows = db.all<{
      channelId: string; channelName: string | null; cnt: number; latestTs: string; unread: number;
    }>(sql`
      WITH latest AS (
        SELECT channel_id, channel_name,
               ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY timestamp DESC) AS rn
        FROM slack_messages
        WHERE ${slScope}
      ),
      own AS (
        SELECT channel_id AS ch, MAX(timestamp) AS last_own_ts
        FROM slack_messages
        WHERE user_id IN (SELECT value FROM json_each(${slMyIds}))
        GROUP BY channel_id
      ),
      stats AS (
        SELECT m.channel_id AS ch,
               COUNT(*) AS cnt,
               MAX(m.timestamp) AS latest_ts,
               SUM(CASE WHEN m.timestamp > MAX(COALESCE(r.last_read_at, ${unreadEpoch}), COALESCE(o.last_own_ts, ''))
                         AND (m.user_id IS NULL OR m.user_id NOT IN (SELECT value FROM json_each(${slMyIds})))
                        THEN 1 ELSE 0 END) AS unread
        FROM slack_messages m
        LEFT JOIN chat_read_state r ON r.source = 'slack' AND r.chat_id = m.channel_id
        LEFT JOIN own o ON o.ch = m.channel_id
        WHERE ${slScopeM}
        GROUP BY m.channel_id
      )
      SELECT l.channel_id AS channelId, l.channel_name AS channelName,
             s.cnt AS cnt, s.latest_ts AS latestTs, s.unread AS unread
      FROM latest l JOIN stats s ON s.ch = l.channel_id
      WHERE l.rn = 1
    `);

    // Fine-grained read enforcement
    const allowedSlackChannels = apiKeyId
      ? (resolveEffectiveFineGrained('slack', apiKeyId) as import('../db/schema.js').SlackFineGrained | null)?.readChannelIds
      : undefined;
    const channels = allowedSlackChannels?.length
      ? slRows.filter((ch) => allowedSlackChannels.includes(ch.channelId))
      : slRows;

    // DM participants: one query for all D…/G… channels, grouped in JS.
    const slackDmParticipants = db.all<{ channelId: string; userId: string | null }>(sql`
      SELECT DISTINCT channel_id AS channelId, user_id AS userId
      FROM slack_messages WHERE channel_id LIKE 'D%' OR channel_id LIKE 'G%'
    `);
    const slackParticipantsByChannel = new Map<string, Array<{ userId: string | null }>>();
    for (const p of slackDmParticipants) {
      const list = slackParticipantsByChannel.get(p.channelId) ?? [];
      list.push(p);
      slackParticipantsByChannel.set(p.channelId, list);
    }

    const dmChats: ChatEntry[] = [];
    const channelChats: ChatEntry[] = [];

    for (const ch of channels) {
      const entry: ChatEntry = {
        id: ch.channelId,
        name: ch.channelName || ch.channelId,
        source: 'slack',
        messageCount: ch.cnt,
        lastTs: ch.latestTs || undefined,
        unread: ch.unread,
      };

      // Slack channel ID conventions:
      //   D... = direct message (1:1 DM)
      //   G... = group DM / private channel (MPIM)
      //   C... = public channel
      //   W... = Slack Connect channel
      const isDm = ch.channelId.startsWith('D') || ch.channelId.startsWith('G');

      if (isDm) {
        // Try to find contacts whose userId matches message senders in this channel
        const isGroupDm = ch.channelId.startsWith('G');
        const senderRow = slackParticipantsByChannel.get(ch.channelId) ?? [];

        if (isGroupDm) {
          // For MPDM channels, collect all non-self participant names
          const participantNames: string[] = [];
          for (const row of senderRow) {
            if (!row.userId || slackCache.myAccountIds.has(row.userId)) continue;
            const contact = slackCache.contacts.get(row.userId);
            if (contact?.displayName) {
              participantNames.push(contact.displayName);
            }
          }
          if (participantNames.length > 0) {
            entry.name = participantNames.join(', ');
          } else {
            entry.name = ch.channelName || ch.channelId;
          }
        } else {
          // For 1:1 DMs, use the single other participant's name and avatar
          let resolved = false;
          for (const row of senderRow) {
            if (!row.userId) continue;
            const contact = slackCache.contacts.get(row.userId);
            if (contact?.displayName && !slackCache.myAccountIds.has(row.userId)) {
              entry.name = contact.displayName;
              entry.avatarUrl = contact.avatarUrl;
              resolved = true;
              break;
            }
          }
          if (!resolved) entry.name = ch.channelName || ch.channelId;
        }
        dmChats.push(entry);
      } else {
        channelChats.push(entry);
      }
    }

    const sections: ChatSection[] = [];
    if (dmChats.length) {
      sections.push({
        id: 'slack-dms', label: 'Direct Messages', type: 'dms',
        chats: dmChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')),
      });
    }
    if (channelChats.length) {
      sections.push({
        id: 'slack-channels', label: 'Channels', type: 'channels',
        chats: channelChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')),
      });
    }
    if (sections.length) result['slack'] = { source: 'slack', sections };
  }

  // ── Telegram ────────────────────────────────────────────────────────────────
  if (enabledChatSources.has('telegram')) {
    const tgCache = buildContactCache(db, 'telegram');
    const unreadEpoch = getUnreadEpoch(db);
    const tgMyIds = JSON.stringify([...tgCache.myAccountIds]);

    // Single pass: latest row per chat (name) + stats + unread. The previous
    // version materialised EVERY telegram message row just to dedupe names.
    // User sync-scope: groups/channels outside telegram.syncChats are hidden,
    // stored history included (private chats always pass).
    const tgScope = sql.raw(sourceFilterPredicate('telegram'));
    const tgScopeM = sql.raw(sourceFilterPredicate('telegram', 'm'));
    const tgRows = db.all<{
      chatId: number; chatName: string | null; chatType: string | null;
      cnt: number; latestTs: string; lastMessageId: number; unread: number;
    }>(sql`
      WITH latest AS (
        SELECT chat_id, chat_name,
               ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY id DESC) AS rn
        FROM telegram_messages
        WHERE ${tgScope}
      ),
      own AS (
        SELECT chat_id AS ch, MAX(timestamp) AS last_own_ts
        FROM telegram_messages
        WHERE CAST(sender_id AS TEXT) IN (SELECT value FROM json_each(${tgMyIds}))
        GROUP BY chat_id
      ),
      stats AS (
        SELECT m.chat_id AS ch,
               COUNT(*) AS cnt,
               MAX(m.timestamp) AS latest_ts,
               MAX(m.message_id) AS last_message_id,
               MAX(m.chat_type) AS chat_type,
               SUM(CASE WHEN m.timestamp > MAX(COALESCE(r.last_read_at, ${unreadEpoch}), COALESCE(o.last_own_ts, ''))
                         AND (m.sender_id IS NULL OR CAST(m.sender_id AS TEXT) NOT IN (SELECT value FROM json_each(${tgMyIds})))
                        THEN 1 ELSE 0 END) AS unread
        FROM telegram_messages m
        LEFT JOIN chat_read_state r ON r.source = 'telegram' AND r.chat_id = CAST(m.chat_id AS TEXT)
        LEFT JOIN own o ON o.ch = m.chat_id
        WHERE ${tgScopeM}
        GROUP BY m.chat_id
      )
      SELECT l.chat_id AS chatId, l.chat_name AS chatName, s.chat_type AS chatType,
             s.cnt AS cnt, s.latest_ts AS latestTs, s.last_message_id AS lastMessageId,
             s.unread AS unread
      FROM latest l JOIN stats s ON s.ch = l.chat_id
      WHERE l.rn = 1
    `);

    const tgChatMap = new Map<number, typeof tgRows[number]>();
    for (const row of tgRows) tgChatMap.set(row.chatId, row);

    // Dialog folders come from a live MTProto RPC — serve from cache so this
    // endpoint never blocks on the network; refresh in the background.
    const { getConnectionManager } = await import('../connections/manager.js');
    const manager = getConnectionManager();
    const tgBridge = manager.getTelegram();
    let folderMap = new Map<string, { id: number; title: string }>(); // chatId → folder

    if (tgFolderCache && Date.now() - tgFolderCache.at < TG_FOLDER_TTL_MS) {
      folderMap = tgFolderCache.map;
    } else if (tgBridge?.connected) {
      const refresh = tgBridge.getDialogFolders().then((folders) => {
        const map = new Map<string, { id: number; title: string }>();
        for (const folder of folders) {
          for (const chatId of folder.chatIds) {
            if (!map.has(chatId)) map.set(chatId, { id: folder.id, title: folder.title });
          }
        }
        tgFolderCache = { at: Date.now(), map };
        return map;
      }).catch(() => folderMap);
      // First call after boot has no cache — wait briefly; otherwise serve stale.
      if (!tgFolderCache) {
        folderMap = await Promise.race([
          refresh,
          new Promise<typeof folderMap>((r) => setTimeout(() => r(folderMap), 1500)),
        ]);
      } else {
        folderMap = tgFolderCache.map;
      }
    }

    // Build per-folder and type-based buckets
    const dmChats: ChatEntry[] = [];
    const groupChats: ChatEntry[] = [];
    const channelChats: ChatEntry[] = [];
    const folderBuckets = new Map<string, { label: string; chats: ChatEntry[] }>();

    // Fine-grained Telegram read enforcement
    const allowedTgChats = apiKeyId
      ? (resolveEffectiveFineGrained('telegram', apiKeyId) as import('../db/schema.js').TelegramFineGrained | null)?.readChatIds
      : undefined;

    for (const [chatIdNum, ch] of tgChatMap) {
      // Skip chats not in the allowlist
      if (allowedTgChats?.length && !allowedTgChats.includes(String(chatIdNum))) continue;

      const contact = tgCache.contacts.get(String(chatIdNum));
      let name = ch.chatName || String(chatIdNum);
      let avatarUrl: string | null = null;
      if (contact?.displayName) { name = contact.displayName; avatarUrl = contact.avatarUrl ?? null; }

      const entry: ChatEntry = {
        id: String(chatIdNum),
        name,
        source: 'telegram',
        messageCount: ch.cnt,
        lastTs: ch.latestTs || undefined,   // MAX(timestamp) — always correct recency
        lastMessageId: ch.lastMessageId ?? null,
        unread: ch.unread,
        avatarUrl,
      };

      // Classification using stored chatType first, numeric fallback second
      const type = ch.chatType?.toLowerCase() || '';
      const isNegativeId = chatIdNum < 0;
      // GramJS encodes supergroup/channel IDs by adding 1_000_000_000_000 to the raw ID
      const isLargePositive = chatIdNum > 1_000_000_000_000;
      const isDm    = type === 'private' || type === 'user' || (!type && !isNegativeId && !isLargePositive && chatIdNum > 0);
      const isGroup = type === 'group'   || type === 'supergroup' || (!type && isNegativeId);
      const isChan  = type === 'channel' || (!type && isLargePositive);

      // Check if this chat belongs to a user-defined folder
      const folder = folderMap.get(String(chatIdNum));
      if (folder) {
        const key = String(folder.id);
        if (!folderBuckets.has(key)) folderBuckets.set(key, { label: folder.title, chats: [] });
        folderBuckets.get(key)!.chats.push(entry);
      } else if (isDm) {
        dmChats.push(entry);
      } else if (isChan) {
        channelChats.push(entry);
      } else {
        groupChats.push(entry);
      }
    }

    const sections: ChatSection[] = [];
    if (dmChats.length) sections.push({
      id: 'tg-dms', label: 'Direct Messages', type: 'dms',
      chats: dmChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')),
    });
    if (groupChats.length) sections.push({
      id: 'tg-groups', label: 'Groups', type: 'channels',
      chats: groupChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')),
    });
    if (channelChats.length) sections.push({
      id: 'tg-channels', label: 'Channels', type: 'channels',
      chats: channelChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')),
    });
    // User-defined folders appear after the standard sections
    for (const [, bucket] of folderBuckets) {
      sections.push({
        id: `tg-folder-${bucket.label}`, label: bucket.label, type: 'channels',
        chats: bucket.chats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')),
      });
    }

    if (sections.length) result['telegram'] = { source: 'telegram', sections };
  }

  // ── Twitter ─────────────────────────────────────────────────────────────────
  if (enabledChatSources.has('twitter')) {
    const { readDms: twitterReadDms } = resolveTwitterReadPerms(apiKeyId);
    if (twitterReadDms) {
      const twCache = buildContactCache(db, 'twitter');
      const unreadEpoch = getUnreadEpoch(db);
      const twMyIds = JSON.stringify([...twCache.myAccountIds]);

      // Latest message + stats per conversation in one pass, plus one distinct
      // participants query — instead of a full-table scan per conversation.
      const twRows = db.all<{
        conversationId: string; latestTs: string; cnt: number; unread: number;
      }>(sql`
        WITH own AS (
          SELECT conversation_id AS ch, MAX(created_at) AS last_own_ts
          FROM twitter_dms
          WHERE sender_id IN (SELECT value FROM json_each(${twMyIds}))
          GROUP BY conversation_id
        )
        SELECT m.conversation_id AS conversationId,
               MAX(m.created_at) AS latestTs,
               COUNT(*) AS cnt,
               SUM(CASE WHEN m.created_at > MAX(COALESCE(r.last_read_at, ${unreadEpoch}), COALESCE(o.last_own_ts, ''))
                         AND m.sender_id NOT IN (SELECT value FROM json_each(${twMyIds}))
                        THEN 1 ELSE 0 END) AS unread
        FROM twitter_dms m
        LEFT JOIN chat_read_state r ON r.source = 'twitter' AND r.chat_id = m.conversation_id
        LEFT JOIN own o ON o.ch = m.conversation_id
        GROUP BY m.conversation_id
      `);
      const twParticipants = db.all<{
        conversationId: string; senderId: string; senderHandle: string | null;
        senderName: string | null; recipientId: string | null;
      }>(sql`
        SELECT DISTINCT conversation_id AS conversationId, sender_id AS senderId,
               sender_handle AS senderHandle, sender_name AS senderName, recipient_id AS recipientId
        FROM twitter_dms
      `);
      const participantsByConv = new Map<string, typeof twParticipants>();
      for (const p of twParticipants) {
        const list = participantsByConv.get(p.conversationId) ?? [];
        list.push(p);
        participantsByConv.set(p.conversationId, list);
      }

      if (twRows.length) {
        const dmChats: ChatEntry[] = twRows.map((c) => {
          const parts = participantsByConv.get(c.conversationId) ?? [];
          // The other participant: prefer a non-self sender with a handle/name,
          // fall back to a non-self recipient (conversations we started).
          const otherMsg = parts.find((m) => !twCache.myAccountIds.has(m.senderId) && (m.senderHandle || m.senderName));
          const otherIdFallback = parts.find((m) => m.recipientId && !twCache.myAccountIds.has(m.recipientId))?.recipientId
            ?? parts.find((m) => !twCache.myAccountIds.has(m.senderId))?.senderId;
          const otherId = otherMsg?.senderId ?? otherIdFallback;
          const contact = otherId ? twCache.contacts.get(otherId) : null;
          const otherHandle = otherMsg?.senderHandle || '';
          const otherName = otherMsg?.senderName || '';
          const fallbackHandle = parts.find((m) => !twCache.myAccountIds.has(m.senderId))?.senderHandle;
          return {
            id: c.conversationId,
            name: contact?.displayName || otherName || (otherHandle ? `@${otherHandle}` : (fallbackHandle ? `@${fallbackHandle}` : c.conversationId)),
            source: 'twitter',
            messageCount: c.cnt,
            lastTs: c.latestTs || undefined,
            unread: c.unread,
            avatarUrl: contact?.avatarUrl || null,
          };
        });
        result['twitter'] = {
          source: 'twitter',
          sections: [{ id: 'tw-dms', label: 'Direct Messages', type: 'dms', chats: dmChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')) }],
        };
      }
    }
  }

  // ── Gmail ───────────────────────────────────────────────────────────────────
  if (enabledChatSources.has('gmail')) {
    const gmailFg = apiKeyId
      ? resolveEffectiveFineGrained('gmail', apiKeyId) as import('../db/schema.js').GmailFineGrained | null
      : null;
    const allowedGmailLabels = gmailFg?.readLabelIds;

    // Latest message + counts per thread in one pass, capped to the 200 most
    // recent threads (the previous version returned EVERY thread with two
    // queries each — thousands of entries on a real mailbox). Gmail's unread
    // comes from real is_read state, not chat_read_state.
    const gmRows = db.all<{
      threadId: string; subject: string | null; latestTs: string | null;
      labels: string | null; cnt: number; unread: number;
    }>(sql`
      SELECT thread_id AS threadId, subject, internal_date AS latestTs, labels,
             cnt, unread
      FROM (
        SELECT thread_id, subject, internal_date, labels,
               ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY internal_date DESC) AS rn,
               COUNT(*) OVER (PARTITION BY thread_id) AS cnt,
               SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY thread_id) AS unread
        FROM gmail_messages
      )
      WHERE rn = 1
      ORDER BY internal_date DESC
      LIMIT 200
    `);

    const gmThreads = gmRows.filter((t) => {
      if (!apiKeyId || !allowedGmailLabels?.length) return true;
      if (!t.labels) return false;
      try {
        const labelArr = JSON.parse(t.labels) as string[];
        return labelArr.some((l) => allowedGmailLabels.includes(l));
      } catch { return false; }
    });

    if (gmThreads.length) {
      const flatChats: ChatEntry[] = gmThreads.map((t) => ({
        id: t.threadId,
        name: t.subject || t.threadId,
        source: 'gmail',
        messageCount: t.cnt,
        lastTs: t.latestTs || undefined,
        unread: t.unread,
      }));
      result['gmail'] = {
        source: 'gmail',
        sections: [{ id: 'gmail-threads', label: 'Inbox', type: 'flat', chats: flatChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')) }],
      };
    }
  }

  // Audit log for non-AI API key calls (AI calls are tracked via trackAiCall middleware)
  if (authedReq.actor === 'api' && !authedReq.aiSessionId) {
    writeAuditLog('read', 'api', {
      apiKeyId: authedReq.apiKey?.id,
      detail: { endpoint: 'chats' },
    });
  }

  res.json(result);
});

router.get('/messages', optionalAuth, trackAiCall, validateQuery(MessagesQuery), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { source, chat_id, limit: lim, before, after, around, include_meta } = queryOf(MessagesQuery, req);
  const half = Math.floor(lim / 2);
  const apiKeyId = authedReq.apiKey?.id ?? null;

  // Fine-grained read enforcement: if a specific chat_id and source are requested,
  // check that the API key is allowed to read from that chat/channel.
  if (chat_id && source && apiKeyId) {
    if (source === 'twitter') {
      const { readDms } = resolveTwitterReadPerms(apiKeyId);
      if (!readDms) {
        res.status(403).json({ error: 'DM access is not permitted for this API key' });
        return;
      }
    } else if (!isReadPermitted(source, chat_id, apiKeyId)) {
      res.status(403).json({ error: `Reading from "${chat_id}" is not permitted for this API key on ${source}` });
      return;
    }
  }

  const results: unknown[] = [];
  let total = 0;

  // NOTE: drizzle's chained .where() calls REPLACE each other rather than AND
  // — the old implementation silently dropped `after` whenever `before` was
  // also given. Conditions are now collected and combined once.
  type ChatMsgTable = typeof telegramMessages | typeof discordMessages | typeof slackMessages;

  function buildMsgConds(table: ChatMsgTable, src: string) {
    const t = table as typeof telegramMessages;
    const conds = [] as ReturnType<typeof eq>[];
    if (chat_id) {
      if (src === 'telegram') conds.push(eq(t.chatId, parseInt(chat_id)));
      else conds.push(eq((table as typeof discordMessages).channelId, chat_id));
    }
    if (after)  conds.push(gte(t.timestamp, after));
    if (before) conds.push(lte(t.timestamp, before));
    return conds;
  }

  function queryMsgs(table: ChatMsgTable, src: string) {
    const t = table as typeof telegramMessages;
    const conds = buildMsgConds(table, src);
    // When `around` is specified, fetch half before + half after the target
    // timestamp for a window centred on that point (scroll-to-message).
    if (around) {
      const beforeRows = db.select().from(t)
        .where(and(...conds, lte(t.timestamp, around)))
        .orderBy(desc(t.timestamp)).limit(half + 1).all();
      const afterRows = db.select().from(t)
        .where(and(...conds, sql`timestamp > ${around}`))
        .orderBy(t.timestamp).limit(lim - half).all();
      return [...beforeRows.reverse(), ...afterRows];
    }
    return db.select().from(t)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(t.timestamp)).limit(lim).all();
  }

  function countMsgs(table: ChatMsgTable, src: string): number {
    const t = table as typeof telegramMessages;
    const conds = buildMsgConds(table, src);
    const row = db.select({ c: sql<number>`count(*)` }).from(t)
      .where(conds.length ? and(...conds) : undefined).get();
    return row?.c ?? 0;
  }

  // rawJson is the full serialised platform payload — 5-20x the useful tokens;
  // no client feature reads it from list responses. API actors additionally
  // drop attachments/embeds (UI needs them for media rendering).
  function projectRow<T extends { rawJson?: string | null }>(raw: T): Omit<T, 'rawJson'> {
    const { rawJson: _rawJson, ...rest } = raw;
    if (apiKeyId) {
      delete (rest as Record<string, unknown>)['attachments'];
      delete (rest as Record<string, unknown>)['embeds'];
    }
    return rest;
  }

  const sources = filterEnabledSources(source ? [source] : [...MSG_SOURCES], apiKeyId);
  if (source && sources.length === 0) {
    res.status(403).json({ error: `Read access to ${source} is not permitted for this API key` });
    return;
  }

  for (const src of sources) {
    // Build contact cache once per source
    const cache = buildContactCache(db, src);

    if (src === 'telegram') {
      const rows = queryMsgs(telegramMessages, src);
      total += countMsgs(telegramMessages, src);
      results.push(...rows.map((m) => {
        const raw = m as typeof telegramMessages.$inferSelect;
        const { senderName, avatarUrl, isMe } = enrichSender(
          raw.senderId ? String(raw.senderId) : null,
          raw.senderName,
          cache,
          src,
        );
        return { source: src, ...projectRow(raw), senderName, avatarUrl, isMe };
      }));
    } else if (src === 'discord') {
      const rows = queryMsgs(discordMessages, src);
      total += countMsgs(discordMessages, src);
      results.push(...rows.map((m) => {
        const raw = m as unknown as typeof discordMessages.$inferSelect;
        const { senderName, avatarUrl, isMe } = enrichSender(raw.authorId, raw.authorName, cache, src);
        return { source: src, ...projectRow(raw), senderName, avatarUrl, isMe };
      }));
    } else if (src === 'slack') {
      const rows = queryMsgs(slackMessages, src);
      total += countMsgs(slackMessages, src);
      results.push(...rows.map((m) => {
        const raw = m as unknown as typeof slackMessages.$inferSelect;
        const { senderName, avatarUrl, isMe } = enrichSender(raw.userId, raw.userName, cache, src);
        return { source: src, ...projectRow(raw), senderName, avatarUrl, isMe };
      }));
    } else if (src === 'twitter') {
      const conds = [] as ReturnType<typeof eq>[];
      if (chat_id) conds.push(eq(twitterDms.conversationId, chat_id));
      if (after)   conds.push(gte(twitterDms.createdAt, after));
      if (before)  conds.push(lte(twitterDms.createdAt, before));
      const where = conds.length ? and(...conds) : undefined;
      const msgs = db.select().from(twitterDms).where(where)
        .orderBy(desc(twitterDms.createdAt)).limit(lim).all();
      total += db.select({ c: sql<number>`count(*)` }).from(twitterDms).where(where).get()?.c ?? 0;
      results.push(...msgs.map((m) => {
        const { senderName, avatarUrl, isMe } = enrichSender(m.senderId, m.senderName || m.senderHandle, cache);
        return {
          source: 'twitter', messageId: m.messageId,
          chatId: m.conversationId, chatName: m.conversationId,
          senderId: m.senderId, senderName, avatarUrl, isMe,
          content: m.text || '', timestamp: m.createdAt,
        };
      }));
    } else if (src === 'gmail') {
      const conds = [] as ReturnType<typeof eq>[];
      if (chat_id) conds.push(eq(gmailMessages.threadId, chat_id));
      if (after)   conds.push(gte(gmailMessages.internalDate, after));
      if (before)  conds.push(lte(gmailMessages.internalDate, before));
      const where = conds.length ? and(...conds) : undefined;
      const msgs = db.select().from(gmailMessages).where(where)
        .orderBy(desc(gmailMessages.internalDate)).limit(lim).all();
      total += db.select({ c: sql<number>`count(*)` }).from(gmailMessages).where(where).get()?.c ?? 0;
      results.push(...msgs.map((m) => ({
        source: 'gmail', messageId: m.gmailId,
        chatId: m.threadId, chatName: m.subject || m.threadId,
        senderName: m.fromName || m.fromAddress || '',
        avatarUrl: null, isMe: false,
        content: m.snippet || '', timestamp: m.internalDate || m.syncedAt || '',
      })));
    }
  }

  results.sort((a, b) =>
    new Date((b as { timestamp: string }).timestamp || 0).getTime() -
    new Date((a as { timestamp: string }).timestamp || 0).getTime()
  );

  writeAuditLog('read', authedReq.actor, {
    service: source,
    apiKeyId: authedReq.apiKey?.id,
    detail: { source, chat_id, limit: lim },
  });

  const page = results.slice(0, lim);

  // Optional conversationMeta — only when include_meta=true and a specific chat is requested
  let conversationMeta: ReturnType<typeof buildConversationMeta> | undefined;
  if (include_meta && chat_id && source) {
    conversationMeta = buildConversationMeta(
      db, source, chat_id,
      page as Array<{ senderName: string; senderAvatarUrl: string | null; isMe: boolean; senderId?: unknown }>,
    ) ?? undefined;
  }

  // `total` is the true count of matching rows across the queried sources —
  // the old value was capped at min(sources × limit) and useless for paging.
  res.json({ messages: page, total, ...(conversationMeta ? { conversationMeta } : {}) });
});

// ── Read-state (unread model) ─────────────────────────────────────────────────

// POST /chats/:source/:chatId/read — set the chat's read cursor (default: now).
router.post(
  '/chats/:source/:chatId/read',
  uiOnlyAuth,
  validateParams(ChatReadParams),
  validateBody(ChatReadBody),
  (req, res) => {
  const { source, chatId } = paramsOf(ChatReadParams, req);
  const at = bodyOf(ChatReadBody, req).at || new Date().toISOString();
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(chatReadState)
    .values({ source, chatId, lastReadAt: at, updatedAt: now })
    .onConflictDoUpdate({
      target: [chatReadState.source, chatReadState.chatId],
      set: { lastReadAt: at, updatedAt: now },
    }).run();
  broadcast({ type: 'chat:read', data: { source, chatId, lastReadAt: at } });
  res.json({ success: true, source, chatId, lastReadAt: at });
});

// POST /chats/read-all — mark every known chat read (optionally one source).
router.post('/chats/read-all', uiOnlyAuth, validateBody(ReadAllBody), (req, res) => {
  const { source } = bodyOf(ReadAllBody, req);
  const chatSources = source ? [source] : ['telegram', 'discord', 'slack', 'twitter'];
  const db = getDb();
  const now = new Date().toISOString();
  let marked = 0;

  for (const src of chatSources) {
    // Sync-scope aware: chats hidden by a source filter keep their unread
    // state so nothing is silently lost if the source is re-included later.
    let ids: string[] = [];
    if (src === 'telegram') {
      ids = db.selectDistinct({ id: telegramMessages.chatId }).from(telegramMessages)
        .where(sql.raw(sourceFilterPredicate('telegram', 'telegram_messages'))).all().map((r) => String(r.id));
    } else if (src === 'discord') {
      ids = db.selectDistinct({ id: discordMessages.channelId }).from(discordMessages)
        .where(sql.raw(sourceFilterPredicate('discord', 'discord_messages'))).all().map((r) => r.id);
    } else if (src === 'slack') {
      ids = db.selectDistinct({ id: slackMessages.channelId }).from(slackMessages)
        .where(sql.raw(sourceFilterPredicate('slack', 'slack_messages'))).all().map((r) => r.id);
    } else if (src === 'twitter') {
      ids = db.selectDistinct({ id: twitterDms.conversationId }).from(twitterDms).all().map((r) => r.id);
    }
    for (const chatId of ids) {
      db.insert(chatReadState)
        .values({ source: src, chatId, lastReadAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [chatReadState.source, chatReadState.chatId],
          set: { lastReadAt: now, updatedAt: now },
        }).run();
      marked++;
    }
    broadcast({ type: 'chat:read', data: { source: src, chatId: '*', lastReadAt: now } });
  }

  res.json({ success: true, marked });
});

router.get('/search', optionalAuth, trackAiCall, validateQuery(SearchQuery), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { q, source, limit: lim } = queryOf(SearchQuery, req);

  const results: unknown[] = [];
  const apiKeyId = authedReq.apiKey?.id ?? null;

  // Same read enforcement as /messages: service toggles + per-chat allowlists.
  // Search must not be a side door around channel-scoped keys.
  const sources = filterEnabledSources(source ? [source] : [...MSG_SOURCES], apiKeyId);
  if (source && sources.length === 0) {
    res.status(403).json({ error: `Read access to ${source} is not permitted for this API key` });
    return;
  }

  /** Filter rows to chats the key may read (no-op for the UI actor). */
  function permittedRows<T>(svc: string, rows: T[], chatIdOf: (r: T) => string): T[] {
    if (!apiKeyId) return rows;
    const ids = [...new Set(rows.map(chatIdOf))];
    const allowed = new Set(filterReadIds(svc, ids, apiKeyId));
    return rows.filter((r) => allowed.has(chatIdOf(r)));
  }

  if (sources.includes('telegram')) {
    const rows = permittedRows('telegram', db.select().from(telegramMessages)
      .where(and(like(telegramMessages.content, `%${q}%`),
        sql.raw(sourceFilterPredicate('telegram', 'telegram_messages'))))
      .orderBy(desc(telegramMessages.timestamp)).limit(lim).all(), (m) => String(m.chatId));
    results.push(...rows.map((m) => ({ source: 'telegram', ...m })));
  }
  if (sources.includes('discord')) {
    const rows = permittedRows('discord', db.select().from(discordMessages)
      .where(and(like(discordMessages.content, `%${q}%`),
        sql.raw(sourceFilterPredicate('discord', 'discord_messages'))))
      .orderBy(desc(discordMessages.timestamp)).limit(lim).all(), (m) => m.channelId);
    results.push(...rows.map((m) => ({ source: 'discord', ...m })));
  }
  if (sources.includes('slack')) {
    const rows = permittedRows('slack', db.select().from(slackMessages)
      .where(and(like(slackMessages.content, `%${q}%`),
        sql.raw(sourceFilterPredicate('slack', 'slack_messages'))))
      .orderBy(desc(slackMessages.timestamp)).limit(lim).all(), (m) => m.channelId);
    results.push(...rows.map((m) => ({ source: 'slack', ...m })));
  }
  if (sources.includes('twitter') && (!apiKeyId || resolveTwitterReadPerms(apiKeyId).readDms)) {
    results.push(...db.select().from(twitterDms)
      .where(like(twitterDms.text, `%${q}%`))
      .orderBy(desc(twitterDms.createdAt)).limit(lim).all()
      .map((m) => ({ source: 'twitter', messageId: m.messageId, chatId: m.conversationId, content: m.text || '', timestamp: m.createdAt, senderName: m.senderHandle })));
  }
  if (sources.includes('gmail')) {
    const rows = filterGmailByLabels(
      db.select().from(gmailMessages)
        .where(like(gmailMessages.snippet, `%${q}%`))
        .orderBy(desc(gmailMessages.internalDate)).limit(lim).all(),
      (m) => { try { return JSON.parse(m.labels || '[]') as string[]; } catch { return []; } },
      apiKeyId,
    );
    results.push(...rows.map((m) => ({ source: 'gmail', messageId: m.gmailId, chatId: m.threadId, content: m.snippet || '', timestamp: m.internalDate, senderName: m.fromName })));
  }

  results.sort((a, b) =>
    new Date((b as { timestamp: string }).timestamp || 0).getTime() -
    new Date((a as { timestamp: string }).timestamp || 0).getTime()
  );

  writeAuditLog('read', authedReq.actor, {
    apiKeyId: authedReq.apiKey?.id,
    detail: { query: q, source, limit: lim },
  });

  res.json({ results: results.slice(0, lim) });
});

// ── GET /activity — unified chronological activity feed ───────────────────────
// Returns messages and emails interleaved by timestamp across all services.
// Designed for AI agents that need "what has been happening" in a single call.
//
// Query params:
//   since   — ISO timestamp (default: 24 hours ago)
//   until   — ISO timestamp (default: now)
//   limit   — max 200 (default 50)
//   sources — comma-separated filter, e.g. "slack,discord,gmail"
//             (default: all; gmail produces 'email' type items)

router.get('/activity', optionalAuth, trackAiCall, validateQuery(ActivityQuery), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const now = new Date();
  const defaultSince = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const query = queryOf(ActivityQuery, req);
  const since = query.since ?? defaultSince;
  const until = query.until ?? now.toISOString();
  const lim = query.limit;

  const apiKeyId = authedReq.apiKey?.id ?? null;
  // Enforce the same service toggles + per-chat allowlists as /messages —
  // the activity feed must not be a side door around scoped keys.
  const requestedSources = filterEnabledSources(
    query.sources ?? ['telegram', 'discord', 'slack', 'twitter', 'gmail'],
    apiKeyId,
  );

  /** Filter rows to chats the key may read (no-op for the UI actor). */
  function permittedActivityRows<T>(svc: string, rows: T[], chatIdOf: (r: T) => string): T[] {
    if (!apiKeyId) return rows;
    const ids = [...new Set(rows.map(chatIdOf))];
    const allowed = new Set(filterReadIds(svc, ids, apiKeyId));
    return rows.filter((r) => allowed.has(chatIdOf(r)));
  }

  type ActivityItem = {
    type: 'message' | 'email';
    source: string;
    timestamp: string;
    messageId: string;
    chatId: string;
    chatName: string | null;
    content: string;
    senderName: string;
    senderAvatarUrl: string | null;
    isMe: boolean;
    context: 'dm' | 'group' | 'channel';
    // email-specific
    subject?: string | null;
    isRead?: boolean;
    isStarred?: boolean;
    threadId?: string;
  };

  const items: ActivityItem[] = [];

  // Helper: infer conversation context from source + message fields
  function inferContext(
    src: string,
    row: Record<string, unknown>,
  ): 'dm' | 'group' | 'channel' {
    if (src === 'discord') return row.guildId ? 'group' : 'dm';
    if (src === 'slack') {
      const ch = String(row.channelId || '');
      return ch.startsWith('D') ? 'dm' : ch.startsWith('G') ? 'group' : 'channel';
    }
    if (src === 'telegram') {
      const type = String(row.chatType || '').toLowerCase();
      if (type === 'private' || type === 'user') return 'dm';
      if (type === 'channel') return 'channel';
      return 'group';
    }
    return 'dm'; // twitter, gmail — all DM-like
  }

  // Messaging services
  const msgSources = requestedSources.filter((s) => ['telegram', 'discord', 'slack', 'twitter'].includes(s));
  const includeGmail = requestedSources.includes('gmail');

  for (const src of msgSources) {
    const cache = buildContactCache(db, src);

    if (src === 'telegram') {
      const rows = permittedActivityRows('telegram', db.select().from(telegramMessages)
        .where(and(gte(telegramMessages.timestamp, since), lte(telegramMessages.timestamp, until),
          sql.raw(sourceFilterPredicate('telegram', 'telegram_messages'))))
        .orderBy(desc(telegramMessages.timestamp))
        .limit(lim)
        .all(), (r) => String(r.chatId));
      for (const r of rows) {
        const { senderName, avatarUrl, isMe } = enrichSender(
          r.senderId ? String(r.senderId) : null, r.senderName, cache, src,
        );
        items.push({
          type: 'message', source: 'telegram',
          timestamp: r.timestamp,
          messageId: String(r.messageId),
          chatId: String(r.chatId),
          chatName: r.chatName,
          content: r.content || '',
          senderName, senderAvatarUrl: avatarUrl, isMe,
          context: inferContext('telegram', r as unknown as Record<string, unknown>),
        });
      }
    }

    if (src === 'discord') {
      const rows = permittedActivityRows('discord', db.select().from(discordMessages)
        .where(and(gte(discordMessages.timestamp, since), lte(discordMessages.timestamp, until),
          sql.raw(sourceFilterPredicate('discord', 'discord_messages'))))
        .orderBy(desc(discordMessages.timestamp))
        .limit(lim)
        .all(), (r) => r.channelId);
      for (const r of rows) {
        const { senderName, avatarUrl, isMe } = enrichSender(r.authorId, r.authorName, cache, src);
        items.push({
          type: 'message', source: 'discord',
          timestamp: r.timestamp,
          messageId: r.messageId,
          chatId: r.channelId,
          chatName: r.channelName,
          content: r.content || '',
          senderName, senderAvatarUrl: avatarUrl, isMe,
          context: inferContext('discord', r as unknown as Record<string, unknown>),
        });
      }
    }

    if (src === 'slack') {
      const rows = permittedActivityRows('slack', db.select().from(slackMessages)
        .where(and(gte(slackMessages.timestamp, since), lte(slackMessages.timestamp, until),
          sql.raw(sourceFilterPredicate('slack', 'slack_messages'))))
        .orderBy(desc(slackMessages.timestamp))
        .limit(lim)
        .all(), (r) => r.channelId);
      for (const r of rows) {
        const { senderName, avatarUrl, isMe } = enrichSender(r.userId, r.userName, cache, src);
        items.push({
          type: 'message', source: 'slack',
          timestamp: r.timestamp,
          messageId: r.messageId,
          chatId: r.channelId,
          chatName: r.channelName,
          content: r.content || '',
          senderName, senderAvatarUrl: avatarUrl, isMe,
          context: inferContext('slack', r as unknown as Record<string, unknown>),
        });
      }
    }

    if (src === 'twitter') {
      if (apiKeyId && !resolveTwitterReadPerms(apiKeyId).readDms) continue;
      const rows = db.select().from(twitterDms)
        .where(and(gte(twitterDms.createdAt, since), lte(twitterDms.createdAt, until)))
        .orderBy(desc(twitterDms.createdAt))
        .limit(lim)
        .all();
      // Build a per-conversation map of the other participant's handle so chatName
      // is always the person we are chatting with, not ourselves.
      const twConvOtherHandle = new Map<string, string>();
      const convIds = [...new Set(rows.map((r) => r.conversationId))];
      for (const convId of convIds) {
        const convMsgs = db.select().from(twitterDms)
          .where(eq(twitterDms.conversationId, convId)).all();
        const otherMsg = convMsgs.find((m) => !cache.myAccountIds.has(m.senderId) && m.senderHandle);
        const fallback = convMsgs.find((m) => !cache.myAccountIds.has(m.senderId))?.senderId;
        twConvOtherHandle.set(convId, otherMsg?.senderHandle || fallback || convId);
      }
      for (const r of rows) {
        const { senderName, avatarUrl, isMe } = enrichSender(r.senderId, r.senderHandle, cache, 'twitter');
        items.push({
          type: 'message', source: 'twitter',
          timestamp: r.createdAt,
          messageId: r.messageId,
          chatId: r.conversationId,
          chatName: twConvOtherHandle.get(r.conversationId) || r.conversationId,
          content: r.text || '',
          senderName, senderAvatarUrl: avatarUrl, isMe,
          context: 'dm',
        });
      }
    }
  }

  // Gmail — surfaces as 'email' type items
  if (includeGmail) {
    const rows = filterGmailByLabels(
      db.select().from(gmailMessages)
        .where(and(
          gte(gmailMessages.internalDate, since),
          lte(gmailMessages.internalDate, until),
        ))
        .orderBy(desc(gmailMessages.internalDate))
        .limit(lim)
        .all(),
      (m) => { try { return JSON.parse(m.labels || '[]') as string[]; } catch { return []; } },
      apiKeyId,
    );
    for (const r of rows) {
      items.push({
        type: 'email', source: 'gmail',
        timestamp: r.internalDate || r.syncedAt || '',
        messageId: r.gmailId,
        chatId: r.threadId,
        chatName: r.subject || r.threadId,
        content: r.snippet || '',
        senderName: r.fromName || r.fromAddress || '',
        senderAvatarUrl: null,
        isMe: false,
        context: 'dm',
        // email-specific
        subject: r.subject,
        isRead: r.isRead ?? false,
        isStarred: r.isStarred ?? false,
        threadId: r.threadId,
      });
    }
  }

  // Sort all items newest-first, apply limit
  items.sort((a, b) =>
    new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()
  );
  const page = items.slice(0, lim);

  writeAuditLog('read', authedReq.actor, {
    apiKeyId: authedReq.apiKey?.id,
    detail: { type: 'activity', since, until, sources: requestedSources, count: page.length },
  });

  res.json({ items: page, total: items.length, since, until });
});

// ── conversationMeta helper ───────────────────────────────────────────────────
// Called when GET /messages?include_meta=true&chat_id=X is requested.
// Returns metadata about the conversation: name, type, participant list.

function buildConversationMeta(
  db: ReturnType<typeof getDb>,
  source: string,
  chatId: string,
  messages: Array<{ senderName: string; senderAvatarUrl: string | null; isMe: boolean; senderId?: unknown }>,
): {
  chatId: string; source: string; chatName: string | null; type: 'dm' | 'group' | 'channel';
  participants: Array<{ platformId: string; displayName: string; avatarUrl: string | null; isMe: boolean; messageCount: number }>;
} | null {
  if (!chatId) return null;

  // Derive chatName and type from the chats tree logic reused here
  let chatName: string | null = null;
  let type: 'dm' | 'group' | 'channel' = 'group';

  if (source === 'discord') {
    const sample = db.select({ channelName: discordMessages.channelName, guildId: discordMessages.guildId })
      .from(discordMessages).where(eq(discordMessages.channelId, chatId)).limit(1).get();
    chatName = sample?.channelName || chatId;
    type = sample?.guildId ? 'channel' : 'dm';
  } else if (source === 'slack') {
    const sample = db.select({ channelName: slackMessages.channelName })
      .from(slackMessages).where(eq(slackMessages.channelId, chatId)).limit(1).get();
    chatName = sample?.channelName || chatId;
    type = chatId.startsWith('D') ? 'dm' : chatId.startsWith('G') ? 'group' : 'channel';
  } else if (source === 'telegram') {
    const sample = db.select({ chatName: telegramMessages.chatName, chatType: telegramMessages.chatType })
      .from(telegramMessages).where(eq(telegramMessages.chatId, parseInt(chatId))).limit(1).get();
    chatName = sample?.chatName || chatId;
    const t = (sample?.chatType || '').toLowerCase();
    type = t === 'private' || t === 'user' ? 'dm' : t === 'channel' ? 'channel' : 'group';
  } else if (source === 'twitter') {
    chatName = chatId;
    type = 'dm';
  } else if (source === 'gmail') {
    const sample = db.select({ subject: gmailMessages.subject })
      .from(gmailMessages).where(eq(gmailMessages.threadId, chatId)).limit(1).get();
    chatName = sample?.subject || chatId;
    type = 'dm';
  }

  // Build participant list from message results (no extra DB query)
  const participantMap = new Map<string, { displayName: string; avatarUrl: string | null; isMe: boolean; messageCount: number }>();
  for (const m of messages) {
    const pid = String(m.senderId || m.senderName || 'unknown');
    const existing = participantMap.get(pid);
    if (existing) {
      existing.messageCount++;
    } else {
      participantMap.set(pid, {
        displayName: m.senderName,
        avatarUrl: m.senderAvatarUrl,
        isMe: m.isMe,
        messageCount: 1,
      });
    }
  }

  const participants = [...participantMap.entries()].map(([platformId, p]) => ({
    platformId, ...p,
  })).sort((a, b) => b.messageCount - a.messageCount);

  return { chatId, source, chatName, type, participants };
}

export default router;
