/**
 * Service data management routes.
 *
 * POST /api/service/:service/reset
 *   Deletes all synced messages, sync state, and sync runs for the service,
 *   then triggers a fresh full sync + re-establishes the live listener.
 *   Credentials and session data are NOT touched.
 *
 * GET  /api/discord/guilds
 *   Returns the list of guilds (with channels) visible to the connected Discord client.
 *
 * POST /api/discord/sync-guilds
 *   Body: { guildIds: string[] }
 *   Saves the guild allowlist to settings, then kicks off an incremental sync
 *   for newly-added guilds.
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import {
  telegramMessages, discordMessages, slackMessages,
  gmailMessages, calendarEvents, twitterDms,
  syncState, syncRuns, settings, contacts, meetNotes,
  chatReadState, chatMuteState,
  aiSessions, aiMessages, aiToolCalls,
  auditLog, outbox, errorLog,
  discordChannelMuteState,
} from '../db/schema.js';
import { eq, and, like } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';
import { getConnectionManager, type ServiceName } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import { getSqlite } from '../db/client.js';

const router = Router();

// ── Reset + resync ─────────────────────────────────────────────────────────────

router.post('/service/:service/reset', optionalAuth, async (req, res) => {
  const service = req.params['service'] as ServiceName;
  if (!['slack', 'discord', 'telegram', 'gmail', 'calendar', 'twitter'].includes(service)) {
    return res.status(400).json({ error: 'Unknown service' });
  }

  const db = getDb();

  // 1. Wipe all messages for this service
  if (service === 'telegram') db.delete(telegramMessages).run();
  else if (service === 'discord') db.delete(discordMessages).run();
  else if (service === 'slack') db.delete(slackMessages).run();
  else if (service === 'gmail') db.delete(gmailMessages).run();
  else if (service === 'calendar') db.delete(calendarEvents).run();
  else if (service === 'twitter') db.delete(twitterDms).run();

  // 2. Wipe sync state, sync run history, and contacts for this service
  db.delete(syncState).where(eq(syncState.source, service)).run();
  db.delete(syncRuns).where(eq(syncRuns.source, service)).run();
  db.delete(contacts).where(eq(contacts.source, service)).run();

  // 3. Wipe read/mute cursors for this service so unread counts reset cleanly
  db.delete(chatReadState).where(eq(chatReadState.source, service)).run();
  db.delete(chatMuteState).where(eq(chatMuteState.source, service)).run();

  // 4. For Gmail/calendar: also clear persisted incremental-sync tokens from settings
  if (service === 'gmail' || service === 'calendar') {
    db.delete(settings).where(like(settings.key, 'gmail.historyId.%')).run();
    db.delete(settings).where(like(settings.key, 'calendar.syncToken.%')).run();
    db.delete(meetNotes).run();
  }

  broadcast({ type: 'sync:progress', data: { service, status: 'idle' } });

  // 5. Re-connect first (registers the live listener), THEN trigger sync.
  //    Order matters: listener must be active before the sync loop starts so
  //    that any message arriving mid-sync is captured by the listener and the
  //    DB unique constraint prevents duplicates from both paths.
  const manager = getConnectionManager();
  try {
    if (service === 'slack') await manager.connectSlack();
    else if (service === 'discord') await manager.connectDiscord();
    else if (service === 'telegram') await manager.connectTelegram();
    else if (service === 'gmail' || service === 'calendar') await manager.connectGmail();
    else if (service === 'twitter') {
      // Clear Twitter in-memory state so feed/DM dedup sets don't carry over
      manager.getTwitter()?.resetInMemoryState();
      // Twitter just re-syncs DMs — no listener reconnect needed
      await manager.triggerSync('twitter');
      return res.json({ success: true, message: 'Twitter data cleared — resync started' });
    }

    if (manager.getStatus(service).status !== 'connected') {
      return res.status(503).json({ error: `${service} failed to connect — check credentials` });
    }

    // Listener is now active. Safe to start the sync.
    manager.triggerSync(service, true).catch(console.error);

    res.json({ success: true, message: `${service} data cleared — full resync started` });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Per-account Gmail reset + resync ──────────────────────────────────────────

router.post('/service/gmail/reset/:email', optionalAuth, async (req, res) => {
  const email = decodeURIComponent(req.params['email'] as string);
  const db = getDb();

  // 1. Wipe messages for this account only
  db.delete(gmailMessages).where(eq(gmailMessages.accountId, email)).run();
  db.delete(calendarEvents).where(eq(calendarEvents.accountId, email)).run();

  // 2. Wipe syncRuns for this account (source tagged with email)
  db.delete(syncRuns).where(and(eq(syncRuns.source, 'gmail'), like(syncRuns.syncType, `%${email}%`))).run();

  // 3. Clear persisted historyId + syncTokens for this account
  db.delete(settings).where(eq(settings.key, `gmail.historyId.${email}`)).run();
  db.delete(settings).where(like(settings.key, `calendar.syncToken.${email}.%`)).run();

  // 4. Clear syncState for this account
  db.delete(syncState).where(and(eq(syncState.source, 'gmail'), eq(syncState.accountId, email))).run();

  // 5. Clear contacts sourced from this Gmail account
  db.delete(contacts).where(and(eq(contacts.source, 'gmail'), eq(contacts.accountId, email))).run();

  // 6. Clear meet notes for this account
  db.delete(meetNotes).where(eq(meetNotes.accountId, email)).run();

  broadcast({ type: 'sync:progress', data: { service: 'gmail', status: 'idle' } });

  // 7. Reconnect this specific account and trigger full sync
  const manager = getConnectionManager();
  try {
    const { getGmailCredsByEmail } = await import('./google-auth.js');
    const creds = getGmailCredsByEmail(email);
    if (!creds) return res.status(400).json({ error: `No credentials found for ${email}` });

    // Disconnect first to force a clean reconnect
    manager.disconnectGmailAccount(email);
    await manager.connectGmailAccount(creds);

    res.json({ success: true, message: `${email} data cleared — full resync started` });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Reset all app data ────────────────────────────────────────────────────────
// Wipes all synced/generated data while preserving credentials and configuration.
// Preserved: settings, accounts, permissions, api_keys, api_key_permissions,
//            obsidian_vault_config, smb_share_config, passkey_credentials,
//            __drizzle_migrations
// Wiped: all messages, contacts, AI sessions, audit log, outbox, sync state, etc.

router.post('/reset-app-data', optionalAuth, (req, res) => {
  const db = getDb();
  const sqlite = getSqlite();

  const wipeAll = sqlite.transaction(() => {
    // Messages
    db.delete(telegramMessages).run();
    db.delete(discordMessages).run();
    db.delete(slackMessages).run();
    db.delete(gmailMessages).run();
    db.delete(calendarEvents).run();
    db.delete(twitterDms).run();
    db.delete(meetNotes).run();

    // Contacts, read/mute state
    db.delete(contacts).run();
    db.delete(chatReadState).run();
    db.delete(chatMuteState).run();
    db.delete(discordChannelMuteState).run();

    // Sync history
    db.delete(syncState).run();
    db.delete(syncRuns).run();

    // AI
    db.delete(aiSessions).run();
    db.delete(aiMessages).run();
    db.delete(aiToolCalls).run();

    // Operational
    db.delete(auditLog).run();
    db.delete(outbox).run();
    db.delete(errorLog).run();

    // Incremental sync tokens stored in settings (gmail historyId, calendar syncToken)
    db.delete(settings).where(like(settings.key, 'gmail.historyId.%')).run();
    db.delete(settings).where(like(settings.key, 'calendar.syncToken.%')).run();
  });

  wipeAll();

  // Notify all connected clients to refresh
  broadcast({ type: 'sync:progress', data: { service: 'all', status: 'idle' } });

  console.log('[reset] All app data wiped');
  res.json({ success: true, message: 'All app data cleared. Credentials and configuration preserved.' });
});

// ── Discord guild management ───────────────────────────────────────────────────

router.get('/discord/guilds', optionalAuth, (_req, res) => {
  const manager = getConnectionManager();
  const discord = manager.getDiscord();
  if (!discord) {
    return res.status(503).json({ error: 'Discord not connected' });
  }

  const guilds = discord.getGuilds();

  // Attach which guilds are currently in the allowlist
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, 'discord.syncGuilds')).get();
  let syncedIds: string[] = [];
  if (row) {
    try { syncedIds = JSON.parse(row.value) as string[]; } catch { /* ignore */ }
  }

  const result = guilds.map((g) => ({ ...g, synced: syncedIds.includes(g.id) }));
  res.json(result);
});

// ── Slack channel list ─────────────────────────────────────────────────────────
// Returns all channels/DMs/MPDMs the connected Slack user is a member of.
// Used by the fine-grained permissions UI to populate the channel multi-select.

router.get('/slack/channels', optionalAuth, async (_req, res) => {
  const manager = getConnectionManager();
  const slack = manager.getSlack();
  if (!slack) {
    return res.status(503).json({ error: 'Slack not connected' });
  }
  try {
    const channels = await slack.getChannels();
    res.json({ channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type })) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Telegram chat list ────────────────────────────────────────────────────────
// Returns all Telegram dialogs the connected account can see.
// Used by the fine-grained permissions UI to populate the chat multi-select.

router.get('/telegram/chats', optionalAuth, async (_req, res) => {
  const manager = getConnectionManager();
  const telegram = manager.getTelegram();
  if (!telegram) {
    return res.status(503).json({ error: 'Telegram not connected' });
  }
  try {
    const chats = await telegram.getChats();
    res.json({
      chats: chats.map((c) => ({
        id: c.chat_id,
        name: c.name,
        type: c.chat_type,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/discord/sync-guilds', optionalAuth, async (req, res) => {
  const { guildIds } = req.body as { guildIds: string[] };
  if (!Array.isArray(guildIds)) {
    return res.status(400).json({ error: 'guildIds must be an array' });
  }

  const db = getDb();

  // Persist the allowlist
  const value = JSON.stringify(guildIds);
  db.insert(settings)
    .values({ key: 'discord.syncGuilds', value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();

  // Kick off a sync for any newly included guilds
  const manager = getConnectionManager();
  manager.triggerSync('discord').catch(console.error);

  res.json({ success: true, guildIds });
});

export default router;
