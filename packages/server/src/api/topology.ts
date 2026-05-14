/**
 * GET /api/topology            — full cross-service resource hierarchy
 * GET /api/topology/:service   — single-service topology slice
 *
 * Requires X-API-Key authentication (responses contain user data).
 *
 * Cached for 5 minutes with ETag support.  Invalidated automatically
 * when syncs complete (via invalidateTopologyCache()).
 *
 * Implementation strategy:
 *  - Shallow structures (Slack, Discord, Telegram, Twitter): return everything
 *    in one pass, pulling channel lists from in-memory sync instances.
 *  - Deep hierarchies (Google Drive, Obsidian): use existing DB caches / file
 *    system walks; Drive tree is limited to 2 levels deep inline — agents can
 *    drill deeper via GET /api/gdrive/folders/:id/files.
 *  - SMB: top-level directories only (listing is slow over the network).
 *  - Gmail/Calendar: aggregate counts from local DB; no live API calls.
 */

import { createHash } from 'crypto';
import { Router } from 'express';
import { eq, sql, and, desc } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  syncState,
  slackMessages,
  discordMessages,
  telegramMessages,
  gmailMessages,
  calendarEvents,
  twitterDms,
  googleDriveFolderConfig,
  googleDriveFileCache,
  obsidianVaultConfig,
  smbShareConfig,
} from '../db/schema.js';
import { apiKeyAuth } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import type { DriveFileNode } from '../sync/gdrive.js';

const router = Router();

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry {
  body: string;
  etag: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>(); // key → cache entry
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateTopologyCache(): void {
  cache.clear();
}

function getCacheKey(service: string): string {
  return service;
}

function fromCache(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry;
  cache.delete(key);
  return null;
}

function toCache(key: string, body: string): CacheEntry {
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
  const entry: CacheEntry = { body, etag, expiresAt: Date.now() + CACHE_TTL_MS };
  cache.set(key, entry);
  return entry;
}

function sendCached(
  res: import('express').Response,
  req: import('express').Request,
  entry: CacheEntry,
): void {
  if (req.headers['if-none-match'] === entry.etag) {
    res.status(304).end();
    return;
  }
  res
    .set('ETag', entry.etag)
    .set('Cache-Control', 'private, max-age=300')
    .set('Content-Type', 'application/json')
    .send(entry.body);
}

// ── Per-service topology builders ─────────────────────────────────────────────

async function buildSlackTopology() {
  const manager = getConnectionManager();
  const status = manager.getStatus('slack');
  const connected = status.status === 'connected';

  if (!connected) {
    return { id: 'slack', connected: false };
  }

  const slack = manager.getSlack();
  const db = getDb();

  // Pull channel list from Slack API (uses in-memory cache inside SlackSync)
  let channels: Array<{ id: string; name: string; type: string }> = [];
  if (slack) {
    try {
      const raw = await slack.getChannels();
      channels = raw.map((c) => ({ id: c.id, name: c.name, type: c.type }));
    } catch {
      // non-fatal — return what we have
    }
  }

  // Message counts from local DB grouped by channelId
  const counts = db
    .select({
      channelId: slackMessages.channelId,
      count: sql<number>`count(*)`,
      lastTs: sql<string>`max(${slackMessages.timestamp})`,
    })
    .from(slackMessages)
    .groupBy(slackMessages.channelId)
    .all();

  const countMap = new Map(counts.map((r) => [r.channelId, { count: r.count, lastTs: r.lastTs }]));

  // Resolve workspace name from Slack API auth info if available
  const workspaceName = (slack as unknown as { teamName?: string } | null)?.teamName
    ?? status.displayName
    ?? 'Workspace';
  const workspaceId = (slack as unknown as { teamId?: string } | null)?.teamId ?? 'unknown';

  return {
    id: 'slack',
    connected: true,
    workspaces: [
      {
        id: workspaceId,
        name: workspaceName,
        channels: channels.map((c) => {
          const stats = countMap.get(c.id);
          // Normalise channel type to human-friendly labels
          let type: string;
          if (c.type === 'im') type = 'direct';
          else if (c.type === 'mpim') type = 'group_dm';
          else if (c.type === 'private_channel') type = 'private';
          else type = 'public';
          return {
            id: c.id,
            name: c.name,
            type,
            messageCount: stats?.count ?? 0,
            lastMessageAt: stats?.lastTs ?? null,
          };
        }),
      },
    ],
  };
}

async function buildDiscordTopology() {
  const manager = getConnectionManager();
  const status = manager.getStatus('discord');
  const connected = status.status === 'connected';

  if (!connected) {
    return { id: 'discord', connected: false };
  }

  const discord = manager.getDiscord();
  const guilds = discord?.getGuilds() ?? [];

  const db = getDb();
  const counts = db
    .select({
      channelId: discordMessages.channelId,
      count: sql<number>`count(*)`,
      lastTs: sql<string>`max(${discordMessages.timestamp})`,
    })
    .from(discordMessages)
    .groupBy(discordMessages.channelId)
    .all();

  const countMap = new Map(counts.map((r) => [r.channelId, { count: r.count, lastTs: r.lastTs }]));

  return {
    id: 'discord',
    connected: true,
    servers: guilds.map((g) => ({
      id: g.id,
      name: g.name,
      channels: g.channels.map((c) => {
        const stats = countMap.get(c.id);
        return {
          id: c.id,
          name: c.name,
          type: 'text',
          messageCount: stats?.count ?? 0,
          lastMessageAt: stats?.lastTs ?? null,
        };
      }),
    })),
  };
}

async function buildTelegramTopology() {
  const manager = getConnectionManager();
  const status = manager.getStatus('telegram');
  const connected = status.status === 'connected';

  const telegram = manager.getTelegram();

  const db = getDb();
  const counts = db
    .select({
      chatId: telegramMessages.chatId,
      chatName: telegramMessages.chatName,
      chatType: telegramMessages.chatType,
      count: sql<number>`count(*)`,
      lastTs: sql<string>`max(${telegramMessages.timestamp})`,
    })
    .from(telegramMessages)
    .groupBy(telegramMessages.chatId)
    .all();

  // Fallback: if not connected, still return what's in the DB
  const chatsFromDb = counts.map((r) => ({
    id: String(r.chatId),
    name: r.chatName ?? String(r.chatId),
    type: r.chatType ?? 'unknown',
    messageCount: r.count,
    lastMessageAt: r.lastTs ?? null,
  }));

  // Supplement with live chat list if connected
  let chats: Array<{ id: string; name: string; type: string; messageCount: number; lastMessageAt: string | null }> = chatsFromDb;
  if (connected && telegram) {
    try {
      const live = await telegram.getChats();
      // Merge live chats with DB counts
      const dbMap = new Map(chatsFromDb.map((c) => [c.id, c]));
      chats = live.map((c) => ({
        id: c.chat_id,
        name: c.name ?? c.chat_id,
        type: c.chat_type ?? 'unknown',
        messageCount: dbMap.get(c.chat_id)?.messageCount ?? 0,
        lastMessageAt: dbMap.get(c.chat_id)?.lastMessageAt ?? null,
      }));
    } catch {
      // fall back to DB
    }
  }

  return {
    id: 'telegram',
    connected,
    account: telegram?.accountInfo?.displayName ?? status.displayName ?? null,
    chats,
  };
}

async function buildTwitterTopology() {
  const manager = getConnectionManager();
  const status = manager.getStatus('twitter');
  const connected = status.status === 'connected';

  const twitter = manager.getTwitter();

  const db = getDb();
  const convCounts = db
    .select({
      conversationId: twitterDms.conversationId,
      count: sql<number>`count(*)`,
      lastTs: sql<string>`max(${twitterDms.createdAt})`,
    })
    .from(twitterDms)
    .groupBy(twitterDms.conversationId)
    .all();

  return {
    id: 'twitter',
    connected,
    account: twitter?.accountInfo
      ? `@${twitter.accountInfo.handle}`
      : (status.displayName ?? null),
    conversations: convCounts.map((r) => ({
      id: r.conversationId,
      messageCount: r.count,
      lastMessageAt: r.lastTs ?? null,
    })),
  };
}

async function buildGmailTopology() {
  const manager = getConnectionManager();
  const status = manager.getStatus('gmail');
  const connected = status.status === 'connected';

  const db = getDb();
  const gmailInstances = manager.getAllGmailInstances();
  const calendarInstances = manager.getAllCalendarInstances();

  const accounts = await Promise.all(
    gmailInstances.map(async (g) => {
      const email = g.accountInfo?.email ?? '';

      // Label counts from local DB
      const labelRows = db
        .select({
          labels: gmailMessages.labels,
          isRead: gmailMessages.isRead,
        })
        .from(gmailMessages)
        .where(eq(gmailMessages.accountId, email))
        .all();

      // Aggregate label counts in JS (labels is a JSON array column)
      const labelCounts = new Map<string, { total: number; unread: number }>();
      for (const row of labelRows) {
        let labels: string[] = [];
        try { labels = JSON.parse(row.labels ?? '[]') as string[]; } catch { /* skip */ }
        for (const lbl of labels) {
          const entry = labelCounts.get(lbl) ?? { total: 0, unread: 0 };
          entry.total++;
          if (!row.isRead) entry.unread++;
          labelCounts.set(lbl, entry);
        }
      }

      const labelList = [...labelCounts.entries()].map(([id, counts]) => ({
        id,
        name: id,            // display name == id for now; enriched below
        messageCount: counts.total,
        unreadCount: counts.unread,
      }));

      // Enrich label display names via Gmail API if connected
      if (g.connected) {
        try {
          const live = await g.getLabels();
          const nameMap = new Map(live.map((l) => [l.id, l.name]));
          for (const lbl of labelList) {
            if (nameMap.has(lbl.id)) lbl.name = nameMap.get(lbl.id)!;
          }
        } catch { /* non-fatal */ }
      }

      // Recent threads from local DB (up to 20)
      const threadRows = db
        .select({
          threadId: gmailMessages.threadId,
          subject: gmailMessages.subject,
          count: sql<number>`count(*)`,
          lastTs: sql<string>`max(${gmailMessages.internalDate})`,
        })
        .from(gmailMessages)
        .where(eq(gmailMessages.accountId, email))
        .groupBy(gmailMessages.threadId)
        .orderBy(desc(sql`max(${gmailMessages.internalDate})`))
        .limit(20)
        .all();

      const threads = threadRows.map((t) => ({
        id: t.threadId,
        subject: t.subject ?? '(no subject)',
        messageCount: t.count,
        lastMessageAt: t.lastTs ?? null,
      }));

      return {
        email,
        connected: g.connected,
        labels: labelList.sort((a, b) => {
          // Put system labels first
          const systemOrder = ['INBOX', 'SENT', 'DRAFTS', 'TRASH', 'SPAM'];
          const ai = systemOrder.indexOf(a.id);
          const bi = systemOrder.indexOf(b.id);
          if (ai !== -1 && bi !== -1) return ai - bi;
          if (ai !== -1) return -1;
          if (bi !== -1) return 1;
          return a.name.localeCompare(b.name);
        }),
        threads,
      };
    }),
  );

  return { id: 'gmail', connected, accounts };
}

async function buildCalendarTopology() {
  const manager = getConnectionManager();
  const status = manager.getStatus('calendar');
  const connected = status.status === 'connected';

  const db = getDb();
  const calendarInstances = manager.getAllCalendarInstances();

  const now = new Date().toISOString();

  const accounts = await Promise.all(
    calendarInstances.map(async (cal) => {
      const email = cal.accountInfo?.email ?? '';

      // Calendar list and event counts from local DB
      const eventRows = db
        .select({
          calendarId: calendarEvents.calendarId,
          count: sql<number>`count(*)`,
          nextStart: sql<string>`min(case when ${calendarEvents.startTime} >= '${now}' then ${calendarEvents.startTime} end)`,
          nextTitle: sql<string>`min(case when ${calendarEvents.startTime} >= '${now}' then ${calendarEvents.title} end)`,
        })
        .from(calendarEvents)
        .where(eq(calendarEvents.accountId, email))
        .groupBy(calendarEvents.calendarId)
        .all();

      let calendarNames: Map<string, string> = new Map();
      if (cal.connected) {
        try {
          const liveCals = await cal.getCalendars();
          calendarNames = new Map(liveCals.map((c) => [c.id, c.summary]));
        } catch { /* non-fatal */ }
      }

      const calendars = eventRows.map((r) => ({
        id: r.calendarId,
        name: calendarNames.get(r.calendarId) ?? r.calendarId,
        eventCount: r.count,
        nextEvent: r.nextStart
          ? { title: r.nextTitle ?? '(untitled)', startsAt: r.nextStart }
          : null,
      }));

      return { email, connected: cal.connected, calendars };
    }),
  );

  return { id: 'calendar', connected, accounts };
}

async function buildGdriveTopology() {
  const manager = getConnectionManager();
  const status = manager.getStatus('gdrive');
  const connected = status.status === 'connected';

  const db = getDb();
  const folderRows = db.select().from(googleDriveFolderConfig).all();

  // Group folders by email
  const byEmail = new Map<string, typeof folderRows>();
  for (const row of folderRows) {
    if (!byEmail.has(row.email)) byEmail.set(row.email, []);
    byEmail.get(row.email)!.push(row);
  }

  const accounts = await Promise.all(
    [...byEmail.entries()].map(async ([email, folders]) => {
      const gdrive = manager.getGdrive(email);

      const rootFolders = await Promise.all(
        folders.map(async (folder) => {
          // Pull tree from DB cache (does NOT trigger a live sync)
          const cached = db
            .select()
            .from(googleDriveFileCache)
            .where(eq(googleDriveFileCache.folderConfigId, folder.id))
            .all();

          // Build shallow tree (max 2 levels deep inline) from cache
          const fullTree: DriveFileNode[] = [];
          if (cached.length > 0 && gdrive) {
            try {
              // Use existing getFileTree which has its own TTL-based caching
              const tree = await gdrive.getFileTree(folder.id, true);
              fullTree.push(...tree);
            } catch { /* non-fatal */ }
          }

          // Truncate to 2 levels: include level-1 children in full, level-2+ summarised
          function shallowNode(node: DriveFileNode, depth: number): unknown {
            if (!node.isFolder || depth >= 2) {
              // Leaf or deep node — return without children
              return {
                id: node.fileId,
                name: node.name,
                type: node.isFolder ? 'folder' : 'file',
                mimeType: node.mimeType,
                webViewLink: node.webViewLink ?? null,
                createdAt: node.createdTime ?? null,
                modifiedAt: node.modifiedTime ?? null,
                ...(node.isFolder
                  ? { itemCount: node.children?.length ?? 0 }
                  : {}),
              };
            }
            // Shallow folder: include children
            return {
              id: node.fileId,
              name: node.name,
              type: 'folder',
              mimeType: node.mimeType,
              webViewLink: node.webViewLink ?? null,
              createdAt: node.createdTime ?? null,
              modifiedAt: node.modifiedTime ?? null,
              itemCount: node.children?.length ?? 0,
              children: (node.children ?? []).map((child) => shallowNode(child, depth + 1)),
            };
          }

          return {
            id: folder.id,
            name: folder.folderName,
            driveType: folder.driveType,
            lastSyncedAt: folder.lastSyncedAt ?? null,
            syncStatus: folder.syncStatus,
            itemCount: fullTree.length,
            children: fullTree.map((node) => shallowNode(node, 0)),
          };
        }),
      );

      return { email, rootFolders };
    }),
  );

  return { id: 'gdrive', connected, accounts };
}

async function buildObsidianTopology() {
  const manager = getConnectionManager();
  const status = manager.getStatus('obsidian');
  const connected = status.status === 'connected';

  const db = getDb();
  const vaultRows = db.select().from(obsidianVaultConfig).all();

  const vaults = await Promise.all(
    vaultRows.map(async (row) => {
      const vault = manager.getObsidian(row.id);
      const vaultStatus = manager.getObsidianVaultStatus(row.id);
      let children: unknown[] = [];

      if (vaultStatus.status === 'connected' && vault) {
        try {
          children = await vault.listFiles();
        } catch { /* non-fatal */ }
      }

      return {
        id: row.id,
        name: row.name,
        localPath: row.localPath,
        remoteUrl: row.remoteUrl,
        status: vaultStatus.status,
        lastSyncedAt: row.lastSyncedAt ?? null,
        children,
      };
    }),
  );

  return { id: 'obsidian', connected, vaults };
}

async function buildSmbTopology() {
  const manager = getConnectionManager();
  const status = manager.getStatus('smb');
  const connected = status.status === 'connected';

  const db = getDb();
  const shareRows = db.select().from(smbShareConfig).all();

  const shares = await Promise.all(
    shareRows.map(async (row) => {
      const shareStatus = manager.getSmbShareStatus(row.id);
      const smbSync = manager.getSmbShare(row.id);
      let children: Array<{ name: string; type: string }> = [];

      if (shareStatus.status === 'connected' && smbSync) {
        try {
          // List only the top-level directory (SMB is slow)
          const files = await smbSync.listDirectory('');
          children = files.map((f) => ({
            name: f.name,
            type: f.type,
          }));
        } catch { /* non-fatal */ }
      }

      return {
        id: row.id,
        name: row.name,
        path: `//${row.host}/${row.share}`,
        status: shareStatus.status,
        children,
      };
    }),
  );

  return { id: 'smb', connected, shares };
}

// ── Service dispatch map ───────────────────────────────────────────────────────

type ServiceId =
  | 'slack' | 'discord' | 'telegram' | 'twitter'
  | 'gmail' | 'calendar' | 'gdrive' | 'obsidian' | 'smb';

const BUILDERS: Record<ServiceId, () => Promise<unknown>> = {
  slack:    buildSlackTopology,
  discord:  buildDiscordTopology,
  telegram: buildTelegramTopology,
  twitter:  buildTwitterTopology,
  gmail:    buildGmailTopology,
  calendar: buildCalendarTopology,
  gdrive:   buildGdriveTopology,
  obsidian: buildObsidianTopology,
  smb:      buildSmbTopology,
};

const SERVICE_IDS = Object.keys(BUILDERS) as ServiceId[];

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/topology — all services
router.get('/topology', apiKeyAuth(), async (req, res) => {
  const cacheKey = getCacheKey('all');
  const hit = fromCache(cacheKey);
  if (hit) { sendCached(res, req, hit); return; }

  try {
    const results = await Promise.allSettled(SERVICE_IDS.map((id) => BUILDERS[id]()));
    const services = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { id: SERVICE_IDS[i], connected: false, error: (r.reason as Error)?.message ?? 'unknown error' },
    );

    const body = JSON.stringify({ services });
    const entry = toCache(cacheKey, body);
    sendCached(res, req, entry);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /api/topology/:service — single service
router.get('/topology/:service', apiKeyAuth(), async (req, res) => {
  const serviceId = req.params['service'] as ServiceId;
  if (!BUILDERS[serviceId]) {
    return res.status(404).json({ error: `Unknown service: ${serviceId}. Valid services: ${SERVICE_IDS.join(', ')}` });
  }

  const cacheKey = getCacheKey(serviceId);
  const hit = fromCache(cacheKey);
  if (hit) { sendCached(res, req, hit); return; }

  try {
    const result = await BUILDERS[serviceId]();
    const body = JSON.stringify(result);
    const entry = toCache(cacheKey, body);
    sendCached(res, req, entry);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
