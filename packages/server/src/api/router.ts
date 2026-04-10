import { Router } from 'express';
import { getConnectionManager, type ServiceName } from '../connections/manager.js';
import { getConnectedCount } from '../websocket/hub.js';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { computeAllUnreads, markChatRead } from '../sync/unread.js';
import messagesRouter from './messages.js';
import outboxRouter from './outbox.js';
import permissionsRouter from './permissions.js';
import auditRouter from './audit.js';
import metricsRouter from './metrics.js';
import settingsRouter from './settings.js';
import keysRouter from './keys.js';
import testRouter from './test.js';
import credentialsRouter from './credentials.js';
import telegramAuthRouter from './telegram-auth.js';
import serviceDataRouter from './service-data.js';
import contactsRouter from './contacts.js';
import googleAuthRouter from './google-auth.js';
import gmailRouter from './gmail.js';
import calendarRouter from './calendar.js';
import twitterRouter from './twitter.js';
import meetNotesRouter from './meet-notes.js';
import notionRouter from './notion.js';
import obsidianRouter from './obsidian.js';
import openapiRouter from './openapi.js';
import aiRouter from './ai.js';
import updateRouter from './update.js';

const router = Router();

// Health
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), wsClients: getConnectedCount() });
});

// Connection status
router.get('/connections', optionalAuth, (req, res) => {
  const manager = getConnectionManager();
  res.json(manager.getAllStatuses());
});

// GET per-account Gmail/Calendar statuses
router.get('/connections/gmail/accounts', optionalAuth, (req, res) => {
  const manager = getConnectionManager();
  res.json(manager.getGmailAccountStatuses());
});

// Per-account Gmail connect/disconnect/sync
router.post('/connections/gmail/accounts/:email/connect', optionalAuth, async (req, res) => {
  const email = decodeURIComponent(req.params['email'] as string);
  const manager = getConnectionManager();
  try {
    const { getGmailCredsByEmail } = await import('./google-auth.js');
    const creds = getGmailCredsByEmail(email);
    if (!creds) return res.status(400).json({ error: `No credentials found for ${email}` });
    await manager.connectGmailAccount(creds);
    res.json({ success: true, statuses: manager.getGmailAccountStatuses() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/connections/gmail/accounts/:email/disconnect', optionalAuth, (req, res) => {
  const email = decodeURIComponent(req.params['email'] as string);
  const manager = getConnectionManager();
  manager.disconnectGmailAccount(email);
  res.json({ success: true });
});

router.post('/connections/gmail/accounts/:email/sync', optionalAuth, async (req, res) => {
  const email = decodeURIComponent(req.params['email'] as string);
  const manager = getConnectionManager();
  try {
    const gmail    = manager.getAllGmailInstances().find((g) => g.accountInfo?.email === email);
    const calendar = manager.getAllCalendarInstances().find((c) => c.accountInfo?.email === email);
    if (!gmail) return res.status(404).json({ error: `${email} not connected` });
    gmail.initialFullSync().catch(console.error);
    calendar?.initialFullSync().catch(console.error);
    res.json({ success: true, message: `Sync started for ${email}` });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/connections/:service/connect', optionalAuth, async (req, res) => {
  const service = (req.params['service'] as string) as ServiceName;
  const manager = getConnectionManager();
  try {
    if (service === 'slack') await manager.connectSlack();
    else if (service === 'discord') await manager.connectDiscord();
    else if (service === 'telegram') await manager.connectTelegram();
    else if (service === 'gmail' || service === 'calendar') await manager.connectGmail();
    else if (service === 'twitter') {
      const { getDb } = await import('../db/client.js');
      const { settings } = await import('../db/schema.js');
      const { eq } = await import('drizzle-orm');
      const row = getDb().select().from(settings).where(eq(settings.key, 'credentials.twitter')).get();
      if (!row) return res.status(400).json({ error: 'Twitter credentials not configured' });
      const creds = JSON.parse(row.value);
      await manager.connectTwitter(creds);
    }
    else if (service === 'notion') {
      await manager.connectNotion();
    }
    res.json({ success: true, status: manager.getStatus(service) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/connections/:service/disconnect', optionalAuth, async (req, res) => {
  const service = (req.params['service'] as string) as ServiceName;
  const manager = getConnectionManager();
  // Cancel any in-progress sync before disconnecting
  manager.cancelSync(service);
  if (service === 'slack') await manager.getSlack()?.disconnect();
  else if (service === 'discord') await manager.getDiscord()?.disconnect();
  else if (service === 'telegram') manager.getTelegram()?.disconnect();
  else if (service === 'gmail' || service === 'calendar') manager.disconnectAllGmailAccounts();
  else if (service === 'twitter') manager.getTwitter()?.disconnect();
  else if (service === 'notion') manager.getNotion()?.disconnect();
  res.json({ success: true });
});

// Sync trigger
router.post('/sync/:service', optionalAuth, async (req, res) => {
  const service = (req.params['service'] as string) as ServiceName;
  const forceFull = req.query.force_full === 'true';
  const manager = getConnectionManager();
  const result = await manager.triggerSync(service, forceFull);
  res.json(result);
});

router.post('/sync/:service/cancel', optionalAuth, (req, res) => {
  const service = (req.params['service'] as string) as ServiceName;
  const manager = getConnectionManager();
  const result = manager.cancelSync(service);
  res.json(result);
});

// ── Unread state ─────────────────────────────────────────────────────────────

// GET /api/unread — returns server-authoritative unread counts + mute state for all chats.
// Called by the client on page load and WS reconnect to seed the unread store.
router.get('/unread', optionalAuth, (_req, res) => {
  try {
    const updates = computeAllUnreads();
    res.json(updates);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /api/unread/:source/:chatId/read — mark a chat as read.
// Always writes chat_read_state (server-side persistence, no permission check needed).
// If markReadEnabled is true for this service, also calls the platform API.
router.post('/unread/:source/:chatId/read', optionalAuth, async (req, res) => {
  const source = req.params['source'] as string;
  const chatId = req.params['chatId'] as string;

  // Always persist read state server-side
  markChatRead(source, chatId);

  // Also mark read on the platform if the permission is enabled
  const db = (await import('../db/client.js')).getDb();
  const { permissions } = await import('../db/schema.js');
  const { eq: eqFn } = await import('drizzle-orm');
  const perm = db.select().from(permissions).where(eqFn(permissions.service, source)).get();

  if (perm?.markReadEnabled) {
    const manager = getConnectionManager();
    try {
      if (source === 'slack') await manager.getSlack()?.markChannelRead(chatId);
      else if (source === 'discord') await manager.getDiscord()?.markChannelRead(chatId);
      else if (source === 'telegram') await manager.getTelegram()?.markChatRead(chatId);
    } catch { /* best-effort platform call */ }
  }

  res.json({ success: true });
});

// Sub-routers
router.use('/', messagesRouter);
router.use('/outbox', outboxRouter);
router.use('/permissions', permissionsRouter);
router.use('/audit-log', auditRouter);
router.use('/metrics', metricsRouter);
router.use('/settings', settingsRouter);
router.use('/keys', keysRouter);
router.use('/test', testRouter);
router.use('/credentials', credentialsRouter);
router.use('/connections/telegram/auth', telegramAuthRouter);
router.use('/contacts', contactsRouter);
router.use('/google', googleAuthRouter);
router.use('/gmail', gmailRouter);
router.use('/calendar', calendarRouter);
router.use('/twitter', twitterRouter);
router.use('/meet-notes', meetNotesRouter);
router.use('/notion', notionRouter);
router.use('/obsidian', obsidianRouter);
router.use('/ai', aiRouter);
router.use('/update', updateRouter);
router.use('/', openapiRouter);
router.use('/', serviceDataRouter);

export default router;
