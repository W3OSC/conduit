/**
 * GET /api/context
 *
 * Public (no auth required) self-documentation endpoint.
 * Returns a snapshot of Conduit's version, capabilities, and the current
 * connection state of every configured service so that AI agents can
 * bootstrap themselves without any manual guidance.
 *
 * Cached for 1 hour (ETag + Cache-Control).  The cache is invalidated
 * automatically whenever a service connects or disconnects.
 */

import { createHash } from 'crypto';
import { Router } from 'express';
import { getConnectionManager } from '../connections/manager.js';
import { getAppVersion } from '../update/checker.js';
import { getDb } from '../db/client.js';
import { googleDriveFolderConfig, obsidianVaultConfig, smbShareConfig } from '../db/schema.js';

const router = Router();

// ── In-memory cache ────────────────────────────────────────────────────────────

interface CacheEntry {
  body: string;          // JSON string
  etag: string;          // SHA-256 of body
  expiresAt: number;     // Date.now() ms
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function invalidateContextCache(): void {
  cache = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function baseUrl(req: import('express').Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http';
  const host  = (req.headers['x-forwarded-host'] as string | undefined) ?? req.get('host') ?? 'localhost';
  return `${proto}://${host}`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/context', async (req, res) => {
  try {
    // Serve from cache if still fresh
    if (cache && cache.expiresAt > Date.now()) {
      if (req.headers['if-none-match'] === cache.etag) {
        res.status(304).end();
        return;
      }
      res
        .set('ETag', cache.etag)
        .set('Cache-Control', 'public, max-age=3600')
        .set('Content-Type', 'application/json')
        .send(cache.body);
      return;
    }

    const base = baseUrl(req);
    const version = await getAppVersion();
    const manager = getConnectionManager();
    const statuses = manager.getAllStatuses();
    const gmailAccounts = manager.getGmailAccountStatuses();
    const db = getDb();

    // ── Conduit self-description ─────────────────────────────────────────────

    const conduit = {
      version,
      description:
        'Conduit is a unified personal data hub that aggregates messages, files, documents, ' +
        'and calendar events from 10+ services (Slack, Gmail, Discord, Telegram, Google Drive, ' +
        'Obsidian, Twitter/X, Calendar, SMB, and more) behind a single authenticated REST API.',
      baseUrl: base,
      authMethod: 'X-API-Key header',
      requiredHeaders: ['X-API-Key'],
      optionalHeaders: ['X-Session-Id (AI session tracking)'],
      capabilities: [
        {
          name: 'unified activity feed',
          description: 'Read messages and activity from all connected platforms in one place.',
          examples: [
            'GET /api/messages',
            'GET /api/messages?source=slack&search=bethog',
            'GET /api/messages?source=gmail&unread=true',
          ],
        },
        {
          name: 'outbox / action queue',
          description:
            'Queue write actions (send messages, reply to emails, create calendar events, ' +
            'patch Obsidian files, etc.) for review and approval.',
          examples: [
            'POST /api/outbox',
            'GET /api/outbox',
          ],
        },
        {
          name: 'file and document discovery',
          description: 'Browse folders, documents, and files across Google Drive and Obsidian.',
          examples: [
            'GET /api/topology',
            'GET /api/gdrive/folders/:id/files',
            'GET /api/obsidian/vaults/:id/files',
          ],
        },
        {
          name: 'contacts',
          description: 'Unified address book aggregated from all messaging services.',
          examples: ['GET /api/contacts', 'GET /api/contacts?search=joe'],
        },
        {
          name: 'calendar',
          description: 'Read and manage Google Calendar events.',
          examples: [
            'GET /api/calendar/events',
            'GET /api/calendar/calendars',
          ],
        },
        {
          name: 'AI assistant',
          description: 'Chat with an AI assistant that has tool access to all Conduit data.',
          examples: ['POST /api/ai/chat', 'GET /api/ai/sessions'],
        },
      ],
    };

    // ── Per-service descriptors ──────────────────────────────────────────────

    const slack = statuses['slack'];
    const discord = statuses['discord'];
    const telegram = statuses['telegram'];
    const gmail = statuses['gmail'];
    const calendar = statuses['calendar'];
    const twitter = statuses['twitter'];
    const obsidian = statuses['obsidian'];
    const smb = statuses['smb'];
    const gdrive = statuses['gdrive'];

    // Vault rows for Obsidian instance detail
    const vaultRows = db.select().from(obsidianVaultConfig).all();
    const smbRows   = db.select().from(smbShareConfig).all();
    const driveRows = db.select().from(googleDriveFolderConfig).all();

    const services = [
      {
        id: 'slack',
        name: 'Slack',
        connected: slack.status === 'connected',
        status: slack.status,
        lastSync: slack.lastSync ?? null,
        account: slack.displayName ?? null,
        capabilities: [
          { method: 'GET',  path: '/api/messages?source=slack',      description: 'list Slack messages (supports ?search=, ?chat_id=, ?limit=, ?offset=)' },
          { method: 'GET',  path: '/api/messages?source=slack&unread=true', description: 'list unread Slack messages' },
          { method: 'POST', path: '/api/outbox',                      description: 'queue a message for sending to a Slack channel' },
          { method: 'GET',  path: '/api/topology/slack',              description: 'list workspaces and channels' },
        ],
        authentication: {
          type: 'bot-token + socket-mode',
          configLink: `${base}/settings/integrations/slack`,
        },
      },
      {
        id: 'gmail',
        name: 'Gmail',
        connected: gmail.status === 'connected',
        status: gmail.status,
        accounts: gmailAccounts.map((a) => ({
          email: a.email,
          status: a.gmail.status,
          lastSync: a.gmail.lastSync ?? null,
        })),
        capabilities: [
          { method: 'GET',  path: '/api/gmail/messages',              description: 'list emails (supports ?q=, ?label=, ?unread=, ?starred=, ?thread_id=, ?limit=, ?offset=)' },
          { method: 'GET',  path: '/api/gmail/messages/:id',          description: 'get email metadata' },
          { method: 'GET',  path: '/api/gmail/messages/:id/body',     description: 'fetch full email body from Gmail API' },
          { method: 'GET',  path: '/api/gmail/threads/:threadId',     description: 'list all messages in a thread' },
          { method: 'GET',  path: '/api/gmail/labels',                description: 'list all Gmail labels' },
          { method: 'POST', path: '/api/gmail/actions',               description: 'queue a Gmail action (reply, archive, trash, label, star, send)' },
          { method: 'GET',  path: '/api/topology/gmail',              description: 'list accounts, labels and recent threads' },
        ],
        authentication: {
          type: 'oauth2',
          scopes: 'gmail.readonly, gmail.modify, gmail.send',
          configLink: `${base}/settings/integrations/gmail`,
        },
      },
      {
        id: 'gdrive',
        name: 'Google Drive',
        connected: gdrive.status === 'connected',
        status: gdrive.status,
        accounts: [...new Set(driveRows.map((r) => r.email))].map((email) => ({
          email,
          folders: driveRows.filter((r) => r.email === email).map((r) => ({
            id: r.id,
            name: r.folderName,
            driveType: r.driveType,
            lastSyncedAt: r.lastSyncedAt ?? null,
          })),
        })),
        capabilities: [
          { method: 'GET',  path: '/api/gdrive/folders',              description: 'list all whitelisted Drive folders' },
          { method: 'GET',  path: '/api/gdrive/folders/:id/files',    description: 'get full file tree for a folder' },
          { method: 'GET',  path: '/api/gdrive/folders/:id/files/*',  description: 'read file contents (supports ?format=markdown|text|html)' },
          { method: 'POST', path: '/api/gdrive/folders/:id/upload',   description: 'upload a file' },
          { method: 'POST', path: '/api/outbox',                      description: 'queue a Drive write action (create_file, write_file, patch_file, rename_file, delete_file)' },
          { method: 'GET',  path: '/api/topology/gdrive',             description: 'browse folders and files hierarchically' },
        ],
        authentication: {
          type: 'oauth2',
          scopes: 'drive.readonly, drive.file',
          configLink: `${base}/settings/integrations/gdrive`,
        },
      },
      {
        id: 'discord',
        name: 'Discord',
        connected: discord.status === 'connected',
        status: discord.status,
        lastSync: discord.lastSync ?? null,
        account: discord.displayName ?? null,
        capabilities: [
          { method: 'GET',  path: '/api/messages?source=discord',     description: 'list Discord messages (supports ?search=, ?chat_id=, ?limit=)' },
          { method: 'POST', path: '/api/outbox',                      description: 'queue a message for sending to a Discord channel' },
          { method: 'GET',  path: '/api/topology/discord',            description: 'list servers and channels' },
        ],
        authentication: {
          type: 'bot-token',
          configLink: `${base}/settings/integrations/discord`,
        },
      },
      {
        id: 'calendar',
        name: 'Google Calendar',
        connected: calendar.status === 'connected',
        status: calendar.status,
        accounts: gmailAccounts.map((a) => ({
          email: a.email,
          status: a.calendar.status,
          lastSync: a.calendar.lastSync ?? null,
        })),
        capabilities: [
          { method: 'GET',  path: '/api/calendar/events',             description: 'list calendar events (supports ?from=, ?to=, ?calendarId=, ?limit=)' },
          { method: 'GET',  path: '/api/calendar/events/:id',         description: 'get a single event' },
          { method: 'GET',  path: '/api/calendar/calendars',          description: 'list all calendars' },
          { method: 'POST', path: '/api/calendar/actions',            description: 'queue a calendar action (create_event, update_event, delete_event, rsvp)' },
          { method: 'GET',  path: '/api/topology/calendar',           description: 'list accounts, calendars, and upcoming events' },
        ],
        authentication: {
          type: 'oauth2',
          scopes: 'calendar.readonly, calendar.events',
          configLink: `${base}/settings/integrations/calendar`,
        },
      },
      {
        id: 'telegram',
        name: 'Telegram',
        connected: telegram.status === 'connected',
        status: telegram.status,
        lastSync: telegram.lastSync ?? null,
        account: telegram.displayName ?? null,
        capabilities: [
          { method: 'GET',  path: '/api/messages?source=telegram',    description: 'list Telegram messages (supports ?search=, ?chat_id=, ?limit=)' },
          { method: 'POST', path: '/api/outbox',                      description: 'queue a Telegram message for sending' },
          { method: 'GET',  path: '/api/topology/telegram',           description: 'list chats and channels' },
        ],
        authentication: {
          type: 'mtproto (phone + OTP)',
          configLink: `${base}/settings/integrations/telegram`,
        },
      },
      {
        id: 'twitter',
        name: 'Twitter/X',
        connected: twitter.status === 'connected',
        status: twitter.status,
        lastSync: twitter.lastSync ?? null,
        account: twitter.displayName ?? null,
        capabilities: [
          { method: 'GET',  path: '/api/messages?source=twitter',     description: 'list Twitter DMs (supports ?search=, ?limit=)' },
          { method: 'GET',  path: '/api/twitter/feed',                description: 'get Twitter home feed' },
          { method: 'POST', path: '/api/outbox',                      description: 'queue a Twitter DM or tweet' },
          { method: 'GET',  path: '/api/topology/twitter',            description: 'account info and DM conversations' },
        ],
        authentication: {
          type: 'cookie-auth',
          configLink: `${base}/settings/integrations/twitter`,
        },
      },
      {
        id: 'obsidian',
        name: 'Obsidian Vault',
        connected: obsidian.status === 'connected',
        status: obsidian.status,
        vaults: vaultRows.map((v) => {
          const vs = manager.getObsidianVaultStatus(v.id);
          return {
            id: v.id,
            name: v.name,
            status: vs.status,
            lastSyncedAt: v.lastSyncedAt ?? null,
          };
        }),
        capabilities: [
          { method: 'GET',  path: '/api/obsidian/vaults',             description: 'list all configured vaults' },
          { method: 'GET',  path: '/api/obsidian/vaults/:id/files',   description: 'browse vault file tree' },
          { method: 'GET',  path: '/api/obsidian/vaults/:id/files/*', description: 'read vault file contents' },
          { method: 'POST', path: '/api/outbox',                      description: 'queue vault writes (patch_file, create_file, write_file, rename_file, delete_file)' },
          { method: 'GET',  path: '/api/topology/obsidian',           description: 'full vault file tree' },
        ],
        authentication: {
          type: 'git (https-token or ssh)',
          configLink: `${base}/settings/integrations/obsidian`,
        },
      },
      {
        id: 'smb',
        name: 'SMB Network Shares',
        connected: smb.status === 'connected',
        status: smb.status,
        shares: smbRows.map((s) => {
          const ss = manager.getSmbShareStatus(s.id);
          return {
            id: s.id,
            name: s.name,
            status: ss.status,
            path: `//${s.host}/${s.share}`,
          };
        }),
        capabilities: [
          { method: 'GET',  path: '/api/smb/shares',                  description: 'list configured SMB shares' },
          { method: 'GET',  path: '/api/smb/shares/:id/files',        description: 'list files in share root' },
          { method: 'GET',  path: '/api/smb/shares/:id/files/*',      description: 'read a file from the share' },
          { method: 'GET',  path: '/api/topology/smb',                description: 'list shares and top-level directories' },
        ],
        authentication: {
          type: 'smb2 (username + password)',
          configLink: `${base}/settings/integrations/smb`,
        },
      },
    ];

    // ── Help links ───────────────────────────────────────────────────────────

    const helpfulLinks = {
      settings:     `${base}/settings`,
      integrations: `${base}/settings/integrations`,
      permissions:  `${base}/settings/permissions`,
      apiKeys:      `${base}/settings/api-keys`,
      apiDocs:      `${base}/api/openapi.json`,
      topology:     `${base}/api/topology`,
    };

    const body = JSON.stringify({ conduit, services, helpfulLinks });
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;

    cache = { body, etag, expiresAt: Date.now() + CACHE_TTL_MS };

    res
      .set('ETag', etag)
      .set('Cache-Control', 'public, max-age=3600')
      .set('Content-Type', 'application/json')
      .send(body);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
