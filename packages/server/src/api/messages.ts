import { Router } from 'express';
import { getDb } from '../db/client.js';
import {
  telegramMessages, discordMessages, slackMessages, twitterDms, gmailMessages,
  syncState, syncRuns, errorLog, contacts, accounts,
} from '../db/schema.js';
import { eq, and, desc, like, gte, lte, sql, isNull } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';

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

router.get('/status', optionalAuth, (req, res) => {
  const db = getDb();

  const tgCount = db.select({ count: sql<number>`count(*)` }).from(telegramMessages).get();
  const dcCount = db.select({ count: sql<number>`count(*)` }).from(discordMessages).get();
  const slCount = db.select({ count: sql<number>`count(*)` }).from(slackMessages).get();
  const twCount = db.select({ count: sql<number>`count(*)` }).from(twitterDms).get();
  const gmCount = db.select({ count: sql<number>`count(*)` }).from(gmailMessages).get();
  const errCount = db.select({ count: sql<number>`count(*)` }).from(errorLog).get();

  const tgStates = db.select().from(syncState).where(eq(syncState.source, 'telegram')).all();
  const dcStates = db.select().from(syncState).where(eq(syncState.source, 'discord')).all();
  const slStates = db.select().from(syncState).where(eq(syncState.source, 'slack')).all();

  // Twitter conversations (distinct by conversation_id)
  const twConvs = db.selectDistinct({ conversationId: twitterDms.conversationId }).from(twitterDms).all();
  // Gmail threads
  const gmThreads = db.selectDistinct({ threadId: gmailMessages.threadId }).from(gmailMessages).all();

  const lastRuns: Record<string, unknown> = {};
  for (const src of [...MSG_SOURCES]) {
    const run = db.select().from(syncRuns)
      .where(eq(syncRuns.source, src))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1)
      .get();
    lastRuns[src] = run || null;
  }

  // Active syncs — runs that have started but not yet finished.
  // Persisted in DB so they survive a browser refresh.
  const activeRuns = db.select().from(syncRuns)
    .where(and(eq(syncRuns.status, 'running'), isNull(syncRuns.finishedAt)))
    .orderBy(desc(syncRuns.startedAt))
    .all();

  // Build a map of source → active run (only the most recent per source)
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
      telegram: tgCount?.count || 0,
      discord:  dcCount?.count || 0,
      slack:    slCount?.count || 0,
      twitter:  twCount?.count || 0,
      gmail:    gmCount?.count || 0,
    },
    errorCount: errCount?.count || 0,
    chatCounts: {
      telegram: tgStates.length,
      discord:  dcStates.length,
      slack:    slStates.length,
      twitter:  twConvs.length,
      gmail:    gmThreads.length,
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
router.get('/chats', optionalAuth, async (req, res) => {
  const db = getDb();

  interface ChatEntry {
    id: string; name: string; source: string;
    messageCount: number; lastTs?: string;
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

  // ── Discord ─────────────────────────────────────────────────────────────────
  {
    const dcCache = buildContactCache(db, 'discord');
    // Get all distinct channels with their latest message info
    const channels = db.selectDistinct({
      channelId: discordMessages.channelId,
      channelName: discordMessages.channelName,
      guildId: discordMessages.guildId,
      guildName: discordMessages.guildName,
    }).from(discordMessages).all();

    const dmChats: ChatEntry[] = [];
    const guilds = new Map<string, { name: string; channels: ChatEntry[] }>();

    for (const ch of channels) {
      const countRow = db.select({ count: sql<number>`count(*)` })
        .from(discordMessages).where(eq(discordMessages.channelId, ch.channelId)).get();
      const latestRow = db.select({ ts: discordMessages.timestamp })
        .from(discordMessages).where(eq(discordMessages.channelId, ch.channelId))
        .orderBy(desc(discordMessages.timestamp)).limit(1).get();

      const entry: ChatEntry = {
        id: ch.channelId,
        name: ch.channelName || ch.channelId,
        source: 'discord',
        messageCount: countRow?.count || 0,
        lastTs: latestRow?.ts || undefined,
        guildId: ch.guildId || null,
      };

      if (!ch.guildId) {
        // DM — enrich with contact display name and avatar.
        // Fall back to the authorName stored in messages when no contact exists.
        const sample = db.select({
          authorId: discordMessages.authorId,
          authorName: discordMessages.authorName,
        })
          .from(discordMessages)
          .where(and(eq(discordMessages.channelId, ch.channelId), isNull(discordMessages.guildId)))
          .limit(5).all();

        for (const row of sample) {
          if (!row.authorId || dcCache.myAccountIds.has(row.authorId)) continue;
          const contact = dcCache.contacts.get(row.authorId);
          if (contact?.displayName) {
            entry.name = contact.displayName;
            entry.avatarUrl = contact.avatarUrl ?? null;
          } else if (row.authorName && row.authorName !== 'Unknown') {
            // No contact yet — use name stored in message, avatar will be initial fallback
            entry.name = row.authorName;
            entry.avatarUrl = null;
          }
          // Stop at the first non-self participant regardless of whether we found a contact
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
  {
    const slackCache = buildContactCache(db, 'slack');
    const channels = db.selectDistinct({
      channelId: slackMessages.channelId,
      channelName: slackMessages.channelName,
    }).from(slackMessages).all();

    // Build a map of channelId → { messageCount, latestTs } directly from messages
    // so sort order reflects actual message activity, not sync time
    const slackStats = db.select({
      channelId: slackMessages.channelId,
      count: sql<number>`count(*)`,
      latestTs: sql<string>`max(timestamp)`,
    }).from(slackMessages).groupBy(slackMessages.channelId).all();
    const statsMap = new Map(slackStats.map((s) => [s.channelId, s]));

    const dmChats: ChatEntry[] = [];
    const channelChats: ChatEntry[] = [];

    for (const ch of channels) {
      const stats = statsMap.get(ch.channelId);
      const entry: ChatEntry = {
        id: ch.channelId,
        name: ch.channelName || ch.channelId,
        source: 'slack',
        messageCount: stats?.count || 0,
        lastTs: stats?.latestTs || undefined,
      };

      // Slack channel ID conventions:
      //   D... = direct message (1:1 DM)
      //   G... = group DM / private channel (MPIM)
      //   C... = public channel
      //   W... = Slack Connect channel
      const isDm = ch.channelId.startsWith('D') || ch.channelId.startsWith('G');

      if (isDm) {
        // Try to find a contact whose userId matches a message sender in this channel
        const senderRow = db.selectDistinct({ userId: slackMessages.userId })
          .from(slackMessages)
          .where(and(eq(slackMessages.channelId, ch.channelId)))
          .limit(5).all();

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
        // If we have multiple participants (group DM), keep the channel name
        if (!resolved) entry.name = ch.channelName || ch.channelId;
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
  {
    // Single query: per-chat stats (count, latest timestamp, latest chatName/chatType)
    // Uses MAX(timestamp) for correct recency ordering — avoids N+1 queries.
    const tgStatsRows = db.select({
      chatId:        telegramMessages.chatId,
      count:         sql<number>`count(*)`,
      latestTs:      sql<string>`max(timestamp)`,
      lastMessageId: sql<number>`max(message_id)`,
    }).from(telegramMessages)
      .groupBy(telegramMessages.chatId)
      .all();

    // Build a map of chatId → stats for O(1) lookup
    const tgStatsMap = new Map(tgStatsRows.map((r) => [r.chatId, r]));

    // Separate query for chatName + chatType: pick the most recent non-null
    // chatType per chat (needed for DM/group/channel classification)
    const tgMetaRows = db.select({
      chatId:   telegramMessages.chatId,
      chatName: telegramMessages.chatName,
      chatType: telegramMessages.chatType,
    }).from(telegramMessages)
      .orderBy(desc(telegramMessages.id))
      .all();

    // Deduplicate: keep best (most recent + non-null chatType) per chatId
    const tgChatMap = new Map<number, { chatName: string | null; chatType: string | null }>();
    for (const row of tgMetaRows) {
      if (!tgChatMap.has(row.chatId)) {
        tgChatMap.set(row.chatId, { chatName: row.chatName, chatType: row.chatType });
      } else if (!tgChatMap.get(row.chatId)!.chatType && row.chatType) {
        tgChatMap.get(row.chatId)!.chatType = row.chatType;
      }
    }

    const tgCache = buildContactCache(db, 'telegram');

    // Fetch dialog folders from the live Telegram client if connected
    const { getConnectionManager } = await import('../connections/manager.js');
    const manager = getConnectionManager();
    const tgBridge = manager.getTelegram();
    let folderMap = new Map<string, { id: number; title: string }>(); // chatId → folder

    if (tgBridge?.connected) {
      try {
        const folders = await tgBridge.getDialogFolders();
        for (const folder of folders) {
          for (const chatId of folder.chatIds) {
            // A chat can only be in one folder — last write wins (Telegram allows multiple)
            if (!folderMap.has(chatId)) {
              folderMap.set(chatId, { id: folder.id, title: folder.title });
            }
          }
        }
      } catch { /* folders optional — fall back to type-based grouping */ }
    }

    // Build per-folder and type-based buckets
    const dmChats: ChatEntry[] = [];
    const groupChats: ChatEntry[] = [];
    const channelChats: ChatEntry[] = [];
    const folderBuckets = new Map<string, { label: string; chats: ChatEntry[] }>();

    for (const [chatIdNum, ch] of tgChatMap) {
      const stats = tgStatsMap.get(chatIdNum);

      const contact = tgCache.contacts.get(String(chatIdNum));
      let name = ch.chatName || String(chatIdNum);
      let avatarUrl: string | null = null;
      if (contact?.displayName) { name = contact.displayName; avatarUrl = contact.avatarUrl ?? null; }

      const entry: ChatEntry = {
        id: String(chatIdNum),
        name,
        source: 'telegram',
        messageCount: stats?.count || 0,
        lastTs: stats?.latestTs || undefined,   // MAX(timestamp) — always correct recency
        lastMessageId: stats?.lastMessageId ?? null,
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
  {
    const twCache = buildContactCache(db, 'twitter');
    const twConvs = db.selectDistinct({ conversationId: twitterDms.conversationId }).from(twitterDms).all();
    if (twConvs.length) {
      const dmChats: ChatEntry[] = twConvs.map((c) => {
        const lastMsg = db.select().from(twitterDms)
          .where(eq(twitterDms.conversationId, c.conversationId))
          .orderBy(desc(twitterDms.createdAt)).limit(1).get();
        const otherId = lastMsg?.senderId;
        const contact = otherId ? twCache.contacts.get(otherId) : null;
        return {
          id: c.conversationId,
          name: contact?.displayName || lastMsg?.senderHandle || c.conversationId,
          source: 'twitter',
          messageCount: 0,
          lastTs: lastMsg?.createdAt || undefined,
        };
      });
      result['twitter'] = {
        source: 'twitter',
        sections: [{ id: 'tw-dms', label: 'Direct Messages', type: 'dms', chats: dmChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')) }],
      };
    }
  }

  // ── Gmail ───────────────────────────────────────────────────────────────────
  {
    const gmThreads = db.selectDistinct({ threadId: gmailMessages.threadId }).from(gmailMessages).all();
    if (gmThreads.length) {
      const flatChats: ChatEntry[] = gmThreads.map((t) => {
        const lastMsg = db.select().from(gmailMessages)
          .where(eq(gmailMessages.threadId, t.threadId))
          .orderBy(desc(gmailMessages.internalDate)).limit(1).get();
        return {
          id: t.threadId,
          name: lastMsg?.subject || t.threadId,
          source: 'gmail',
          messageCount: 1,
          lastTs: lastMsg?.internalDate || undefined,
        };
      });
      result['gmail'] = {
        source: 'gmail',
        sections: [{ id: 'gmail-threads', label: 'Inbox', type: 'flat', chats: flatChats.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || '')) }],
      };
    }
  }

  res.json(result);
});

router.get('/messages', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { source, chat_id, limit = '50', before, after, around, include_meta } = req.query as Record<string, string>;
  const lim = Math.min(parseInt(limit) || 50, 500);
  const half = Math.floor(lim / 2);

  const results: unknown[] = [];

  function queryMsgs(table: typeof telegramMessages | typeof discordMessages | typeof slackMessages, src: string) {
    // When `around` is specified, fetch half before + half after the target timestamp
    // to produce a window centred on that point (for scroll-to-message navigation).
    if (around) {
      const beforeRows = (() => {
        let q = db.select().from(table as typeof telegramMessages);
        if (chat_id) {
          // @ts-ignore
          if (src === 'telegram') q = q.where(eq(table.chatId, parseInt(chat_id)));
          // @ts-ignore
          else q = q.where(eq(table.channelId, chat_id));
        }
        // @ts-ignore
        q = q.where(lte(table.timestamp, around));
        // @ts-ignore
        return q.orderBy(desc(table.timestamp)).limit(half + 1).all();
      })();
      const afterRows = (() => {
        let q = db.select().from(table as typeof telegramMessages);
        if (chat_id) {
          // @ts-ignore
          if (src === 'telegram') q = q.where(eq(table.chatId, parseInt(chat_id)));
          // @ts-ignore
          else q = q.where(eq(table.channelId, chat_id));
        }
        // @ts-ignore
        q = q.where(sql`timestamp > ${around}`);
        // @ts-ignore
        return q.orderBy(table.timestamp).limit(lim - half).all();
      })();
      // Combine: beforeRows are desc, reverse them, then append afterRows
      return [...beforeRows.reverse(), ...afterRows];
    }

    let q = db.select().from(table as typeof telegramMessages);
    if (chat_id) {
      // @ts-ignore
      if (src === 'telegram') q = q.where(eq(table.chatId, parseInt(chat_id)));
      // @ts-ignore
      else q = q.where(eq(table.channelId, chat_id));
    }
    // @ts-ignore
    if (after)  q = q.where(gte(table.timestamp, after));
    // @ts-ignore
    if (before) q = q.where(lte(table.timestamp, before));
    // @ts-ignore
    return q.orderBy(desc(table.timestamp)).limit(lim).all();
  }

  const sources = source ? [source] : [...MSG_SOURCES];

  for (const src of sources) {
    // Build contact cache once per source
    const cache = buildContactCache(db, src);

    if (src === 'telegram') {
      const rows = queryMsgs(telegramMessages, src);
      results.push(...rows.map((m) => {
        const raw = m as typeof telegramMessages.$inferSelect;
        const { senderName, avatarUrl, isMe } = enrichSender(
          raw.senderId ? String(raw.senderId) : null,
          raw.senderName,
          cache,
          src,
        );
        return { source: src, ...raw, senderName, avatarUrl, isMe };
      }));
    } else if (src === 'discord') {
      const rows = queryMsgs(discordMessages, src);
      results.push(...rows.map((m) => {
        const raw = m as unknown as typeof discordMessages.$inferSelect;
        const { senderName, avatarUrl, isMe } = enrichSender(raw.authorId, raw.authorName, cache, src);
        return { source: src, ...raw, senderName, avatarUrl, isMe };
      }));
    } else if (src === 'slack') {
      const rows = queryMsgs(slackMessages, src);
      results.push(...rows.map((m) => {
        const raw = m as unknown as typeof slackMessages.$inferSelect;
        const { senderName, avatarUrl, isMe } = enrichSender(raw.userId, raw.userName, cache, src);
        return { source: src, ...raw, senderName, avatarUrl, isMe };
      }));
    } else if (src === 'twitter') {
      let q = db.select().from(twitterDms);
      if (chat_id) q = q.where(eq(twitterDms.conversationId, chat_id)) as typeof q;
      if (after)   q = q.where(gte(twitterDms.createdAt, after)) as typeof q;
      if (before)  q = q.where(lte(twitterDms.createdAt, before)) as typeof q;
      const msgs = q.orderBy(desc(twitterDms.createdAt)).limit(lim).all();
      results.push(...msgs.map((m) => {
        const { senderName, avatarUrl, isMe } = enrichSender(m.senderId, m.senderHandle, cache);
        return {
          source: 'twitter', messageId: m.messageId,
          chatId: m.conversationId, chatName: m.conversationId,
          senderId: m.senderId, senderName, avatarUrl, isMe,
          content: m.text || '', timestamp: m.createdAt,
        };
      }));
    } else if (src === 'gmail') {
      let q = db.select().from(gmailMessages);
      if (chat_id) q = q.where(eq(gmailMessages.threadId, chat_id)) as typeof q;
      if (after)   q = q.where(gte(gmailMessages.internalDate, after)) as typeof q;
      if (before)  q = q.where(lte(gmailMessages.internalDate, before)) as typeof q;
      const msgs = q.orderBy(desc(gmailMessages.internalDate)).limit(lim).all();
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
  if (include_meta === 'true' && chat_id && source) {
    conversationMeta = buildConversationMeta(
      db, source, chat_id,
      page as Array<{ senderName: string; senderAvatarUrl: string | null; isMe: boolean; senderId?: unknown }>,
    ) ?? undefined;
  }

  res.json({ messages: page, total: results.length, ...(conversationMeta ? { conversationMeta } : {}) });
});

router.get('/search', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { q, source, limit = '50' } = req.query as Record<string, string>;
  if (!q) { res.status(400).json({ error: 'q is required' }); return; }

  const lim = Math.min(parseInt(limit) || 50, 200);
  const results: unknown[] = [];
  const sources = source ? [source] : [...MSG_SOURCES];

  if (sources.includes('telegram')) {
    results.push(...db.select().from(telegramMessages)
      .where(like(telegramMessages.content, `%${q}%`))
      .orderBy(desc(telegramMessages.timestamp)).limit(lim).all()
      .map((m) => ({ source: 'telegram', ...m })));
  }
  if (sources.includes('discord')) {
    results.push(...db.select().from(discordMessages)
      .where(like(discordMessages.content, `%${q}%`))
      .orderBy(desc(discordMessages.timestamp)).limit(lim).all()
      .map((m) => ({ source: 'discord', ...m })));
  }
  if (sources.includes('slack')) {
    results.push(...db.select().from(slackMessages)
      .where(like(slackMessages.content, `%${q}%`))
      .orderBy(desc(slackMessages.timestamp)).limit(lim).all()
      .map((m) => ({ source: 'slack', ...m })));
  }
  if (sources.includes('twitter')) {
    results.push(...db.select().from(twitterDms)
      .where(like(twitterDms.text, `%${q}%`))
      .orderBy(desc(twitterDms.createdAt)).limit(lim).all()
      .map((m) => ({ source: 'twitter', messageId: m.messageId, chatId: m.conversationId, content: m.text || '', timestamp: m.createdAt, senderName: m.senderHandle })));
  }
  if (sources.includes('gmail')) {
    results.push(...db.select().from(gmailMessages)
      .where(like(gmailMessages.snippet, `%${q}%`))
      .orderBy(desc(gmailMessages.internalDate)).limit(lim).all()
      .map((m) => ({ source: 'gmail', messageId: m.gmailId, chatId: m.threadId, content: m.snippet || '', timestamp: m.internalDate, senderName: m.fromName })));
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

router.get('/activity', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const now = new Date();
  const defaultSince = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const {
    since = defaultSince,
    until = now.toISOString(),
    limit = '50',
    sources: sourcesParam,
  } = req.query as Record<string, string>;

  const lim = Math.min(parseInt(limit) || 50, 200);
  const requestedSources = sourcesParam
    ? sourcesParam.split(',').map((s) => s.trim())
    : ['telegram', 'discord', 'slack', 'twitter', 'gmail'];

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
      const rows = db.select().from(telegramMessages)
        .where(and(gte(telegramMessages.timestamp, since), lte(telegramMessages.timestamp, until)))
        .orderBy(desc(telegramMessages.timestamp))
        .limit(lim)
        .all();
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
      const rows = db.select().from(discordMessages)
        .where(and(gte(discordMessages.timestamp, since), lte(discordMessages.timestamp, until)))
        .orderBy(desc(discordMessages.timestamp))
        .limit(lim)
        .all();
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
      const rows = db.select().from(slackMessages)
        .where(and(gte(slackMessages.timestamp, since), lte(slackMessages.timestamp, until)))
        .orderBy(desc(slackMessages.timestamp))
        .limit(lim)
        .all();
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
      const rows = db.select().from(twitterDms)
        .where(and(gte(twitterDms.createdAt, since), lte(twitterDms.createdAt, until)))
        .orderBy(desc(twitterDms.createdAt))
        .limit(lim)
        .all();
      for (const r of rows) {
        const { senderName, avatarUrl, isMe } = enrichSender(r.senderId, r.senderHandle, cache, 'twitter');
        items.push({
          type: 'message', source: 'twitter',
          timestamp: r.createdAt,
          messageId: r.messageId,
          chatId: r.conversationId,
          chatName: r.senderHandle || r.conversationId,
          content: r.text || '',
          senderName, senderAvatarUrl: avatarUrl, isMe,
          context: 'dm',
        });
      }
    }
  }

  // Gmail — surfaces as 'email' type items
  if (includeGmail) {
    const rows = db.select().from(gmailMessages)
      .where(and(
        gte(gmailMessages.internalDate, since),
        lte(gmailMessages.internalDate, until),
      ))
      .orderBy(desc(gmailMessages.internalDate))
      .limit(lim)
      .all();
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
