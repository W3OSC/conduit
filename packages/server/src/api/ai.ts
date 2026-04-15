import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { eq, desc, asc } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { aiSessions, aiMessages, apiKeys, settings } from '../db/schema.js';
import { optionalAuth, apiKeyAuth, type AuthedRequest } from '../auth/middleware.js';
import { broadcast, onNextBroadcast } from '../websocket/hub.js';
import { getConnectionManager } from '../connections/manager.js';

const router = Router();

// ── Settings keys ─────────────────────────────────────────────────────────────
const KEY_WEBHOOK_URL    = 'ai.webhookUrl';
const KEY_API_KEY_ID     = 'ai.apiKeyId';
const KEY_API_KEY_PREFIX = 'ai.apiKeyPrefix';
const KEY_PERMISSIONS    = 'ai.permissions';
const KEY_VERIFIED       = 'ai.verified'; // '1' once a connection test has passed

// ── Permission defaults ───────────────────────────────────────────────────────

export interface AiPermissions {
  readMessages:    boolean; // /api/activity, /api/chats, /api/messages
  readEmails:      boolean; // /api/gmail/*
  readCalendar:    boolean; // /api/calendar/*
  readContacts:    boolean; // /api/contacts
  readVault:       boolean; // /api/obsidian/files (read vault notes)
  writeVault:      boolean; // POST /api/outbox source:obsidian (queue vault writes)
  sendOutbox:      boolean; // POST /api/outbox (queue for approval)
  requireApproval: boolean; // all outbox items require human approval (sub-toggle of sendOutbox)
}

const DEFAULT_PERMISSIONS: AiPermissions = {
  readMessages:    true,
  readEmails:      true,
  readCalendar:    true,
  readContacts:    true,
  readVault:       true,
  writeVault:      true,
  sendOutbox:      true,
  requireApproval: true,
};

function getPermissions(): AiPermissions {
  const raw = getSetting(KEY_PERMISSIONS);
  if (!raw) return { ...DEFAULT_PERMISSIONS };
  try { return { ...DEFAULT_PERMISSIONS, ...JSON.parse(raw) }; } catch { return { ...DEFAULT_PERMISSIONS }; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nanoid(size = 21): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(size);
  let result = '';
  for (let i = 0; i < size; i++) {
    result += chars[bytes[i]! % chars.length];
  }
  return result;
}

function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? row.value : null;
}

function setSetting(key: string, value: string): void {
  const db = getDb();
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) {
    db.update(settings).set({ value, updatedAt: new Date().toISOString() }).where(eq(settings.key, key)).run();
  } else {
    db.insert(settings).values({ key, value }).run();
  }
}

function deleteSetting(key: string): void {
  const db = getDb();
  db.delete(settings).where(eq(settings.key, key)).run();
}

function getBaseUrl(req: import('express').Request): string {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  return `${proto}://${host}`;
}

function buildSystemPrompt(baseUrl: string, apiKey: string | undefined, sessionId: string, perms: AiPermissions): string {
  // Build the list of allowed endpoints based on permissions
  const allowed: string[] = [];
  const denied:  string[] = [];

  if (perms.readMessages) {
    allowed.push(
      '- `GET /api/activity` — unified feed of recent messages across all platforms (start here for context)',
      '- `GET /api/chats` — all conversations organised by platform',
      '- `GET /api/messages?source=<platform>&chat_id=<id>` — messages in a specific conversation',
    );
  } else {
    denied.push('reading messages and conversations (not permitted)');
  }

  if (perms.readContacts) {
    allowed.push('- `GET /api/contacts` — the user\'s contacts and relationships');
  } else {
    denied.push('reading contacts (not permitted)');
  }

  if (perms.readEmails) {
    allowed.push('- `GET /api/gmail/messages` — emails');
  } else {
    denied.push('reading emails (not permitted)');
  }

  if (perms.readCalendar) {
    allowed.push('- `GET /api/calendar/events` — calendar events');
  } else {
    denied.push('reading calendar events (not permitted)');
  }

  if (perms.readVault) {
    allowed.push(
      '- `GET /api/obsidian/files` — list all files in the Obsidian vault (returns a file tree)',
      '- `GET /api/obsidian/files/{path}` — read the contents of a specific vault note (path is URL-encoded)',
    );
  } else {
    denied.push('reading Obsidian vault notes (not permitted)');
  }

  if (perms.writeVault) {
    allowed.push(
      perms.requireApproval
        ? '- `POST /api/outbox` with `source: "obsidian"` and JSON content `{ "action": "create_file"|"write_file"|"rename_file"|"delete_file", ... }` — queue a vault write for approval'
        : '- `POST /api/outbox` with `source: "obsidian"` — queue a vault write (approval not required)',
    );
  } else {
    denied.push('writing to the Obsidian vault (not permitted)');
  }

  if (perms.sendOutbox) {
    allowed.push(
      perms.requireApproval
        ? '- `POST /api/outbox` — queue a message for sending (REQUIRES human approval before it is sent — always tell the user what you queued)'
        : '- `POST /api/outbox` — queue a message for sending (approval not required — messages may be sent immediately)',
    );
  } else {
    denied.push('sending messages or creating outbox items (not permitted)');
  }

  allowed.push('- `GET /api/openapi.json` — full OpenAPI 3.0 spec with all available endpoints');

  const deniedSection = denied.length > 0
    ? `\n\n## What You Are NOT Permitted To Do\nThe user has restricted the following — do not attempt these even if asked:\n${denied.map((d) => `- ${d}`).join('\n')}`
    : '';

  const approvalNote = perms.sendOutbox && perms.requireApproval
    ? '\n- When you queue outbox items, always inform the user that their approval is required before anything is sent'
    : '';

  return `You are an AI assistant connected to Conduit — a personal communications hub that aggregates messages, emails, and social media into one unified interface.

## What is Conduit?
Conduit is a self-hosted platform that connects to Slack, Discord, Telegram, Twitter/X, Gmail, and Google Calendar. It acts as your personal communications control centre, giving you a unified view of all incoming messages, communication patterns, and a human-in-the-loop system for taking actions.

## Your Connection
You are connected to this Conduit instance via API. Use the API to read context about the user's communications before responding, and to take permitted actions on their behalf.

**Base URL:** ${baseUrl}
**API Key:** ${apiKey ?? '(not configured — set an API key in Settings → Permissions)'}
**OpenAPI Spec:** ${baseUrl}/api/openapi.json

## What You Can Access
Include the header \`X-API-Key: ${apiKey ?? '<your-api-key>'}\` on every request.

${allowed.join('\n')}${deniedSection}

## Streaming Your Responses
When you have a response ready (or as you generate it), POST token chunks to:
\`POST ${baseUrl}/api/ai/sessions/${sessionId}/stream\`

Request body:
\`\`\`json
{
  "delta": "token text here",
  "done": false,
  "toolCalls": []
}
\`\`\`

Send \`"done": true\` on the final chunk. Always pass the \`messageId\` returned from the first chunk in all subsequent chunks so Conduit can append to the same message.

## Conversation Style
- You are talking directly to the user through the Conduit AI chat interface
- Be conversational but precise
- When you look up context from the API, mention what you found${approvalNote}
- Stay within your permitted scope — if the user asks you to do something you are not permitted to do, explain the restriction clearly and suggest they update permissions in Conduit Settings`;
}

// ── GET /ai/connection ────────────────────────────────────────────────────────
// Returns the global AI connection status and config (no secret key exposed).

router.get('/connection', optionalAuth, (req, res) => {
  const webhookUrl  = getSetting(KEY_WEBHOOK_URL);
  const keyId       = getSetting(KEY_API_KEY_ID);
  const keyPrefix   = getSetting(KEY_API_KEY_PREFIX);
  const baseUrl     = getBaseUrl(req);
  const configured  = !!(webhookUrl && keyId);
  const verified    = configured && getSetting(KEY_VERIFIED) === '1';

  res.json({
    configured,
    verified,
    webhookUrl: webhookUrl ?? null,
    keyPrefix:  keyPrefix  ?? null,
    baseUrl,
    streamUrlTemplate: `${baseUrl}/api/ai/sessions/{sessionId}/stream`,
    openApiUrl: `${baseUrl}/api/openapi.json`,
  });
});

// ── POST /ai/connection ───────────────────────────────────────────────────────
// First-time setup: saves webhook URL and generates the shared API key.
// Returns the raw key ONCE.

router.post('/connection', optionalAuth, (req, res) => {
  const db = getDb();
  const { webhookUrl } = req.body as { webhookUrl: string };
  if (!webhookUrl?.trim()) {
    res.status(400).json({ error: 'webhookUrl is required' });
    return;
  }

  // Revoke any previous key
  const prevKeyId = getSetting(KEY_API_KEY_ID);
  if (prevKeyId) {
    db.update(apiKeys)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, parseInt(prevKeyId)))
      .run();
  }

  // Generate new shared key
  const rawKey = `sk-arb-${randomBytes(24).toString('hex')}`;
  const hash   = createHash('sha256').update(rawKey).digest('hex');
  const prefix = rawKey.slice(0, 12);

  const key = db.insert(apiKeys).values({
    name:      'AI Connection',
    keyHash:   hash,
    keyPrefix: prefix,
    createdAt: new Date().toISOString(),
  }).returning().get();

  setSetting(KEY_WEBHOOK_URL,    webhookUrl.trim());
  setSetting(KEY_API_KEY_ID,     String(key.id));
  setSetting(KEY_API_KEY_PREFIX, prefix);
  // Clear any previous verification — the new URL must pass a test before being marked connected
  deleteSetting(KEY_VERIFIED);

  getConnectionManager().checkAiStatus();

  const baseUrl = getBaseUrl(req);
  res.json({
    configured:        true,
    verified:          false,
    webhookUrl:        webhookUrl.trim(),
    keyPrefix:         prefix,
    apiKey:            rawKey,          // returned ONCE
    baseUrl,
    streamUrlTemplate: `${baseUrl}/api/ai/sessions/{sessionId}/stream`,
    openApiUrl:        `${baseUrl}/api/openapi.json`,
  });
});

// ── POST /ai/connection/test ──────────────────────────────────────────────────
// Sends a test ping to the configured webhook and waits for an ai:token event
// to confirm the full round-trip works.

router.post('/connection/test', optionalAuth, async (req, res) => {
  const webhookUrl = getSetting(KEY_WEBHOOK_URL);
  const keyIdStr   = getSetting(KEY_API_KEY_ID);

  if (!webhookUrl || !keyIdStr) {
    res.status(400).json({ error: 'AI connection is not configured' });
    return;
  }

  const baseUrl  = getBaseUrl(req);
  const testSessionId = `test-${nanoid(8)}`;
  const start    = Date.now();

  // Listen for any ai:token event from this test session
  const roundTripPromise = onNextBroadcast(
    (ev) => ev.type === 'ai:token' && (ev.data as { sessionId?: string }).sessionId === testSessionId,
    15000,
  );

  try {
    const fetchRes = await fetch(webhookUrl, {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      redirect:  'manual',
      body: JSON.stringify({
        sessionId:     testSessionId,
        messageId:     nanoid(),
        role:          'user',
        content:       'Conduit connection test — please respond with a single word: "connected"',
        conduitBaseUrl: baseUrl,
        streamUrl:     `${baseUrl}/api/ai/sessions/${testSessionId}/stream`,
        isTest:        true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    // opaqueredirect means the server returned a 3xx redirect. A POST redirected via
    // 301/302 is silently downgraded to GET by browsers/fetch, so we surface this
    // explicitly rather than silently hitting the wrong endpoint.
    if (fetchRes.type === 'opaqueredirect' || (fetchRes.status >= 300 && fetchRes.status < 400)) {
      const location = fetchRes.headers.get('location') ?? '(no location header)';
      res.json({ success: false, error: `Webhook URL redirects to ${location} — update the URL to the final destination` });
      return;
    }

    if (!fetchRes.ok) {
      res.json({ success: false, error: `Webhook returned ${fetchRes.status} ${fetchRes.statusText}` });
      return;
    }
  } catch (err) {
    res.json({ success: false, error: `Could not reach webhook: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  // Wait for the AI to stream a token back
  try {
    await roundTripPromise;
    // Mark the connection as verified so it shows as fully connected
    setSetting(KEY_VERIFIED, '1');
    getConnectionManager().checkAiStatus();
    res.json({ success: true, latencyMs: Date.now() - start });
  } catch {
    res.json({
      success: false,
      error: 'Webhook was reached but the AI did not stream a response within 15 seconds. Check that the AI agent is configured to POST back to the stream URL.',
    });
  }
});

// ── DELETE /ai/connection ─────────────────────────────────────────────────────
// Disconnects the AI: revokes the key and clears settings.

router.delete('/connection', optionalAuth, (req, res) => {
  const db = getDb();
  const keyIdStr = getSetting(KEY_API_KEY_ID);
  if (keyIdStr) {
    db.update(apiKeys)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, parseInt(keyIdStr)))
      .run();
  }
  deleteSetting(KEY_WEBHOOK_URL);
  deleteSetting(KEY_API_KEY_ID);
  deleteSetting(KEY_API_KEY_PREFIX);
  deleteSetting(KEY_VERIFIED);
  getConnectionManager().disconnectAi();
  res.json({ success: true });
});

// ── GET /ai/permissions ───────────────────────────────────────────────────────

router.get('/permissions', optionalAuth, (_req, res) => {
  res.json(getPermissions());
});

// ── PUT /ai/permissions ───────────────────────────────────────────────────────

router.put('/permissions', optionalAuth, (req, res) => {
  const current = getPermissions();
  const body = req.body as Partial<AiPermissions>;

  const updated: AiPermissions = {
    readMessages:    typeof body.readMessages    === 'boolean' ? body.readMessages    : current.readMessages,
    readEmails:      typeof body.readEmails      === 'boolean' ? body.readEmails      : current.readEmails,
    readCalendar:    typeof body.readCalendar    === 'boolean' ? body.readCalendar    : current.readCalendar,
    readContacts:    typeof body.readContacts    === 'boolean' ? body.readContacts    : current.readContacts,
    readVault:       typeof body.readVault       === 'boolean' ? body.readVault       : current.readVault,
    writeVault:      typeof body.writeVault      === 'boolean' ? body.writeVault      : current.writeVault,
    sendOutbox:      typeof body.sendOutbox      === 'boolean' ? body.sendOutbox      : current.sendOutbox,
    requireApproval: typeof body.requireApproval === 'boolean' ? body.requireApproval : current.requireApproval,
  };

  // requireApproval is meaningless if sendOutbox is off — force it true when sendOutbox re-enables
  if (!updated.sendOutbox) updated.requireApproval = true;

  setSetting(KEY_PERMISSIONS, JSON.stringify(updated));
  res.json(updated);
});

// ── GET /ai/sessions ──────────────────────────────────────────────────────────

router.get('/sessions', optionalAuth, (req, res) => {
  const db = getDb();
  const sessions = db
    .select()
    .from(aiSessions)
    .orderBy(desc(aiSessions.createdAt))
    .all();
  res.json(sessions);
});

// ── POST /ai/sessions ─────────────────────────────────────────────────────────

router.post('/sessions', optionalAuth, (req, res) => {
  const db = getDb();
  const { title = 'New Chat' } = req.body as { title?: string };
  const id = nanoid();
  const session = db.insert(aiSessions).values({
    id,
    title,
    systemPromptSent: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).returning().get();
  res.json(session);
});

// ── PATCH /ai/sessions/:id ────────────────────────────────────────────────────

router.patch('/sessions/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params as { id: string };
  const session = db.select().from(aiSessions).where(eq(aiSessions.id, id)).get();
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  const { title } = req.body as { title?: string };
  const patch: Partial<typeof aiSessions.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (title !== undefined) patch.title = title;

  const updated = db.update(aiSessions).set(patch).where(eq(aiSessions.id, id)).returning().get();
  res.json(updated);
});

// ── DELETE /ai/sessions/:id ───────────────────────────────────────────────────

router.delete('/sessions/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params as { id: string };
  const session = db.select().from(aiSessions).where(eq(aiSessions.id, id)).get();
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  db.delete(aiMessages).where(eq(aiMessages.sessionId, id)).run();
  db.delete(aiSessions).where(eq(aiSessions.id, id)).run();
  res.json({ success: true });
});

// ── GET /ai/sessions/:id/messages ─────────────────────────────────────────────

router.get('/sessions/:id/messages', optionalAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params as { id: string };
  const session = db.select().from(aiSessions).where(eq(aiSessions.id, id)).get();
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  const limit = Math.min(parseInt((req.query['limit'] as string) || '100'), 200);
  const messages = db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.sessionId, id))
    .orderBy(asc(aiMessages.createdAt))
    .limit(limit)
    .all();

  res.json({ session, messages });
});

// ── POST /ai/sessions/:id/messages ────────────────────────────────────────────
// User sends a message. Stored, broadcast over WS, forwarded to AI webhook.

router.post('/sessions/:id/messages', optionalAuth, async (req, res) => {
  const db = getDb();
  const { id } = req.params as { id: string };
  const session = db.select().from(aiSessions).where(eq(aiSessions.id, id)).get();
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  const { content } = req.body as { content: string };
  if (!content?.trim()) { res.status(400).json({ error: 'content is required' }); return; }

  // Load global connection config
  const webhookUrl = getSetting(KEY_WEBHOOK_URL);
  const keyIdStr   = getSetting(KEY_API_KEY_ID);
  const baseUrl    = getBaseUrl(req);

  // Store user message
  const msgId = nanoid();
  const userMessage = db.insert(aiMessages).values({
    id: msgId,
    sessionId: id,
    role: 'user',
    content: content.trim(),
    streaming: false,
    createdAt: new Date().toISOString(),
  }).returning().get();

  broadcast({ type: 'ai:message', data: { sessionId: id, message: userMessage } });

  res.json(userMessage);

  // Build system prompt for first message in this session (needs the raw API key)
  // We generate a fresh short-lived key for the system prompt so we can include the raw value.
  // The main connection key (keyIdStr) is the authoritative one for auth on /stream.
  // We pass a *fresh* key in the system prompt that has been pre-registered so auth works.
  let systemPrompt: string | undefined;
  let deliveryApiKey: string | undefined;

  if (!session.systemPromptSent) {
    if (keyIdStr) {
      // Mint a fresh usable key for this bootstrap — caller will authenticate with it on /stream
      const rawKey = `sk-arb-${randomBytes(24).toString('hex')}`;
      const hash   = createHash('sha256').update(rawKey).digest('hex');
      const prefix = rawKey.slice(0, 12);
      db.insert(apiKeys).values({
        name:      `AI Session Key: ${id.slice(0, 8)}`,
        keyHash:   hash,
        keyPrefix: prefix,
        createdAt: new Date().toISOString(),
      }).run();
      deliveryApiKey = rawKey;
    }
    // deliveryApiKey is only set when a keyIdStr is present; undefined is intentional here
    // and will cause buildSystemPrompt to omit the key from the prompt.
    systemPrompt = buildSystemPrompt(baseUrl, deliveryApiKey, id, getPermissions());
    db.update(aiSessions)
      .set({ systemPromptSent: true, updatedAt: new Date().toISOString() })
      .where(eq(aiSessions.id, id))
      .run();
  }

  // Fire-and-forget webhook delivery
  if (webhookUrl) {
    (async () => {
      try {
        const payload: Record<string, unknown> = {
          sessionId:     id,
          messageId:     msgId,
          role:          'user',
          content:       content.trim(),
          conduitBaseUrl: baseUrl,
          streamUrl:     `${baseUrl}/api/ai/sessions/${id}/stream`,
        };
        if (systemPrompt) payload['systemPrompt'] = systemPrompt;

        const deliveryRes = await fetch(webhookUrl, {
          method:   'POST',
          headers:  { 'Content-Type': 'application/json' },
          redirect: 'manual',
          body:     JSON.stringify(payload),
          signal:   AbortSignal.timeout(30000),
        });
        if (deliveryRes.type === 'opaqueredirect' || (deliveryRes.status >= 300 && deliveryRes.status < 400)) {
          const location = deliveryRes.headers.get('location') ?? '(no location header)';
          throw new Error(`Webhook URL redirects to ${location} — update the configured URL to the final destination`);
        }
      } catch (err) {
        console.error(`[ai] Webhook delivery failed for session ${id}:`, err);
        broadcast({
          type: 'ai:error',
          data: { sessionId: id, error: `Failed to reach AI agent: ${err instanceof Error ? err.message : String(err)}` },
        });
      }
    })();
  }
});

// ── POST /ai/sessions/:id/stream ──────────────────────────────────────────────
// AI-facing: AI POSTs token chunks here; Conduit stores + broadcasts over WS.
// Auth via the shared AI connection API key (X-API-Key header).

router.post('/sessions/:id/stream', apiKeyAuth(true), (req, res) => {
  const db = getDb();
  const { id } = req.params as { id: string };

  // Verify session exists (test pings use ephemeral IDs that won't be in DB — that's fine)
  const session = db.select().from(aiSessions).where(eq(aiSessions.id, id)).get();

  const {
    delta,
    done = false,
    toolCalls,
    messageId: existingMsgId,
  } = req.body as {
    delta?: string;
    done?: boolean;
    toolCalls?: Array<{ name: string; input: unknown; output?: unknown }>;
    messageId?: string;
  };

  let msgId = existingMsgId;

  if (session) {
    // Persist to DB only for real sessions (not test pings)
    if (!msgId) {
      msgId = nanoid();
      db.insert(aiMessages).values({
        id: msgId,
        sessionId: id,
        role: 'assistant',
        content: delta || '',
        toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
        streaming: !done,
        createdAt: new Date().toISOString(),
      }).run();
    } else {
      const existing = db.select().from(aiMessages).where(eq(aiMessages.id, msgId)).get();
      if (existing) {
        db.update(aiMessages)
          .set({
            content:   existing.content + (delta || ''),
            toolCalls: toolCalls ? JSON.stringify(toolCalls) : existing.toolCalls,
            streaming: !done,
          })
          .where(eq(aiMessages.id, msgId))
          .run();
      }
    }
  }

  if (!msgId) msgId = nanoid();

  broadcast({
    type: 'ai:token',
    data: { sessionId: id, messageId: msgId, delta: delta || '', done, toolCalls: toolCalls ?? undefined },
  });

  res.json({ success: true, messageId: msgId });
});

export default router;
