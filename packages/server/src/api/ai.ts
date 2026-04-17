import { Router } from 'express';
import { randomBytes } from 'crypto';
import { eq, desc, asc } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { aiSessions, aiMessages, settings } from '../db/schema.js';
import { optionalAuth, apiKeyAuth, type AuthedRequest } from '../auth/middleware.js';
import { broadcast, onNextBroadcast, collectBroadcast } from '../websocket/hub.js';
import { validateWebhookUrl } from '../auth/ssrf.js';
import { getConnectionManager } from '../connections/manager.js';

const router = Router();

// ── Settings keys ─────────────────────────────────────────────────────────────
const KEY_WEBHOOK_URL       = 'ai.webhookUrl';
const KEY_PERMISSIONS       = 'ai.permissions';
const KEY_VERIFIED          = 'ai.verified'; // '1' once a connection test has passed
const KEY_CALLBACK_BASE_URL = 'ai.callbackBaseUrl'; // override for streamUrl/conduitBaseUrl sent to the AI agent
const KEY_GATEWAY_TOKEN     = 'ai.gatewayToken'; // optional Bearer token sent as Authorization header to the webhook

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
  // Only trust x-forwarded-* headers when TRUST_PROXY env var is set.
  // Without this guard, a caller could spoof the base URL by sending
  // arbitrary x-forwarded-proto/host headers, causing the AI callback
  // URL in the system prompt to point to an attacker-controlled host.
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const proto = trustProxy
    ? (req.headers['x-forwarded-proto'] || req.protocol)
    : req.protocol;
  const host = trustProxy
    ? (req.headers['x-forwarded-host'] || req.get('host'))
    : req.get('host');
  return `${proto}://${host}`;
}

/**
 * Returns the base URL that external services (e.g. OpenClaw running in a
 * separate Docker container) should use to reach Conduit's API.
 *
 * When the `ai.callbackBaseUrl` setting is configured it takes priority over
 * the request-derived host, because `localhost` is unreachable from another
 * container or machine.
 */
function getCallbackBase(req: import('express').Request): string {
  const saved = getSetting(KEY_CALLBACK_BASE_URL);
  if (saved) return saved.replace(/\/$/, '');
  return getBaseUrl(req);
}

function buildSystemPrompt(baseUrl: string, sessionId: string, perms: AiPermissions): string {
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
**OpenAPI Spec:** ${baseUrl}/api/openapi.json

## What You Can Access
Include the header \`X-API-Key: <your-api-key>\` on every request. Your API key was provisioned for you in Conduit → Settings → Permissions.

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
// Returns the global AI connection status and config.

router.get('/connection', optionalAuth, (req, res) => {
  const webhookUrl      = getSetting(KEY_WEBHOOK_URL);
  const callbackBaseUrl = getSetting(KEY_CALLBACK_BASE_URL);
  const gatewayToken    = getSetting(KEY_GATEWAY_TOKEN);
  const baseUrl         = getBaseUrl(req);
  const configured      = !!webhookUrl;
  const verified        = configured && getSetting(KEY_VERIFIED) === '1';

  res.json({
    configured,
    verified,
    webhookUrl:        webhookUrl      ?? null,
    callbackBaseUrl:   callbackBaseUrl ?? null,
    hasGatewayToken:   !!gatewayToken,   // never return the raw token — use dedicated PATCH to update it
    baseUrl,
    streamUrlTemplate: `${baseUrl}/api/ai/sessions/{sessionId}/stream`,
    openApiUrl: `${baseUrl}/api/openapi.json`,
  });
});

// ── POST /ai/connection ───────────────────────────────────────────────────────
// First-time setup: saves webhook URL and optional gateway token.

router.post('/connection', optionalAuth, (req, res) => {
  const { webhookUrl, callbackBaseUrl, gatewayToken } = req.body as { webhookUrl: string; callbackBaseUrl?: string; gatewayToken?: string };
  if (!webhookUrl?.trim()) {
    res.status(400).json({ error: 'webhookUrl is required' });
    return;
  }

  // SSRF protection: validate the webhook URL before persisting it
  const ssrfCheck = validateWebhookUrl(webhookUrl.trim());
  if (!ssrfCheck.ok) {
    res.status(400).json({ error: ssrfCheck.error });
    return;
  }

  setSetting(KEY_WEBHOOK_URL, webhookUrl.trim());
  if (callbackBaseUrl?.trim()) {
    setSetting(KEY_CALLBACK_BASE_URL, callbackBaseUrl.trim().replace(/\/$/, ''));
  }
  if (gatewayToken?.trim()) {
    setSetting(KEY_GATEWAY_TOKEN, gatewayToken.trim());
  } else {
    deleteSetting(KEY_GATEWAY_TOKEN);
  }
  // Clear any previous verification — the new URL must pass a test before being marked connected
  deleteSetting(KEY_VERIFIED);

  getConnectionManager().checkAiStatus();

  const baseUrl       = getBaseUrl(req);
  const savedCallback = getSetting(KEY_CALLBACK_BASE_URL);
  const savedToken    = getSetting(KEY_GATEWAY_TOKEN);
  res.json({
    configured:        true,
    verified:          false,
    webhookUrl:        webhookUrl.trim(),
    callbackBaseUrl:   savedCallback ?? null,
    hasGatewayToken:   !!savedToken,
    baseUrl,
    streamUrlTemplate: `${baseUrl}/api/ai/sessions/{sessionId}/stream`,
    openApiUrl:        `${baseUrl}/api/openapi.json`,
  });
});

// ── PATCH /ai/connection ──────────────────────────────────────────────────────
// Update mutable connection settings (currently: callbackBaseUrl) without
// re-generating the API key or re-saving the webhook URL.

router.patch('/connection', optionalAuth, (req, res) => {
  const { callbackBaseUrl, gatewayToken } = req.body as { callbackBaseUrl?: string | null; gatewayToken?: string | null };

  if (callbackBaseUrl === null || callbackBaseUrl === '') {
    deleteSetting(KEY_CALLBACK_BASE_URL);
  } else if (callbackBaseUrl !== undefined) {
    setSetting(KEY_CALLBACK_BASE_URL, callbackBaseUrl.trim().replace(/\/$/, ''));
  }

  if (gatewayToken === null || gatewayToken === '') {
    deleteSetting(KEY_GATEWAY_TOKEN);
  } else if (gatewayToken !== undefined) {
    setSetting(KEY_GATEWAY_TOKEN, gatewayToken.trim());
  }

  const webhookUrl    = getSetting(KEY_WEBHOOK_URL);
  const savedCallback = getSetting(KEY_CALLBACK_BASE_URL);
  const savedToken    = getSetting(KEY_GATEWAY_TOKEN);
  const baseUrl       = getBaseUrl(req);
  const configured    = !!webhookUrl;
  const verified      = configured && getSetting(KEY_VERIFIED) === '1';

  res.json({
    configured,
    verified,
    webhookUrl:        webhookUrl    ?? null,
    callbackBaseUrl:   savedCallback ?? null,
    hasGatewayToken:   !!savedToken,
    baseUrl,
    streamUrlTemplate: `${baseUrl}/api/ai/sessions/{sessionId}/stream`,
    openApiUrl:        `${baseUrl}/api/openapi.json`,
  });
});

// ── POST /ai/connection/test ──────────────────────────────────────────────────
// Sends a test ping to the configured webhook, waits for the AI to stream a
// complete response, and validates that the response contains "ack".

router.post('/connection/test', optionalAuth, async (req, res) => {
  const webhookUrl = getSetting(KEY_WEBHOOK_URL);

  if (!webhookUrl) {
    res.status(400).json({ error: 'AI connection is not configured' });
    return;
  }

  const callbackBase = getCallbackBase(req);
  const testSessionId = `test-${nanoid(8)}`;
  const start    = Date.now();

  // Collect all ai:token events for this test session until done:true is received
  const roundTripPromise = collectBroadcast(
    (ev) => ev.type === 'ai:token' && (ev.data as { sessionId?: string }).sessionId === testSessionId,
    (ev) => (ev.data as { done?: boolean }).done === true,
    15000,
  );

  const gatewayToken = getSetting(KEY_GATEWAY_TOKEN);
  const authHeaders: Record<string, string> = gatewayToken
    ? { Authorization: `Bearer ${gatewayToken}` }
    : {};

  try {
    const fetchRes = await fetch(webhookUrl, {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json', ...authHeaders },
      redirect:  'manual',
      body: JSON.stringify({
        sessionId:     testSessionId,
        messageId:     nanoid(),
        role:          'user',
        content:       "Reply with 'ack'",
        conduitBaseUrl: callbackBase,
        streamUrl:     `${callbackBase}/api/ai/sessions/${testSessionId}/stream`,
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

  // Wait for the AI to stream a complete response and validate its content
  try {
    const events = await roundTripPromise;
    const fullResponse = events
      .map((ev) => (ev.data as { delta?: string }).delta ?? '')
      .join('');

    if (!fullResponse.toLowerCase().includes('ack')) {
      res.json({
        success: false,
        error: `AI responded but the response did not contain "ack". Got: "${fullResponse.slice(0, 200)}"`,
      });
      return;
    }

    // Mark the connection as verified so it shows as fully connected
    setSetting(KEY_VERIFIED, '1');
    getConnectionManager().checkAiStatus();
    res.json({ success: true, latencyMs: Date.now() - start });
  } catch {
    res.json({
      success: false,
      error: 'Webhook was reached but the AI did not stream a complete response within 15 seconds. Check that the AI agent is configured to POST back to the stream URL.',
    });
  }
});

// ── DELETE /ai/connection ─────────────────────────────────────────────────────
// Disconnects the AI: clears the webhook URL and related settings.

router.delete('/connection', optionalAuth, (req, res) => {
  deleteSetting(KEY_WEBHOOK_URL);
  deleteSetting(KEY_VERIFIED);
  deleteSetting(KEY_CALLBACK_BASE_URL);
  deleteSetting(KEY_GATEWAY_TOKEN);
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
  const webhookUrl   = getSetting(KEY_WEBHOOK_URL);
  const callbackBase = getCallbackBase(req);

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

  // Build system prompt for first message in this session
  let systemPrompt: string | undefined;

  if (!session.systemPromptSent) {
    systemPrompt = buildSystemPrompt(callbackBase, id, getPermissions());
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
          conduitBaseUrl: callbackBase,
          streamUrl:     `${callbackBase}/api/ai/sessions/${id}/stream`,
        };
        if (systemPrompt) payload['systemPrompt'] = systemPrompt;

        const deliveryGatewayToken = getSetting(KEY_GATEWAY_TOKEN);
        const deliveryAuthHeaders: Record<string, string> = deliveryGatewayToken
          ? { Authorization: `Bearer ${deliveryGatewayToken}` }
          : {};

        const deliveryRes = await fetch(webhookUrl, {
          method:   'POST',
          headers:  { 'Content-Type': 'application/json', ...deliveryAuthHeaders },
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

  const body = req.body as Record<string, unknown>;

  // Defensively coerce all fields to valid SQLite-bindable types.
  // The AI agent (especially third-party gateways) may send unexpected types.
  //
  // delta may be a plain string OR an array of Anthropic-style content blocks
  // e.g. [{"type":"text","text":"hello"}]. Extract and join all text values.
  const rawDelta = body['delta'];
  let delta = '';
  if (typeof rawDelta === 'string') {
    delta = rawDelta;
  } else if (Array.isArray(rawDelta)) {
    delta = rawDelta
      .map((block: unknown) => {
        if (typeof block === 'string') return block;
        if (typeof block === 'object' && block !== null && typeof (block as Record<string, unknown>)['text'] === 'string') {
          return (block as Record<string, unknown>)['text'] as string;
        }
        return '';
      })
      .join('');
  }
  const done         = body['done'] === true;
  const toolCalls    = Array.isArray(body['toolCalls'])        ? body['toolCalls'] : null;
  const existingMsgId = typeof body['messageId'] === 'string' ? body['messageId'] : undefined;

  let msgId = existingMsgId;

  if (session) {
    // Persist to DB only for real sessions (not test pings)
    if (!msgId) {
      msgId = nanoid();
      db.insert(aiMessages).values({
        id:        msgId,
        sessionId: id,
        role:      'assistant',
        content:   delta,
        toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
        streaming: !done,
        createdAt: new Date().toISOString(),
      }).run();
    } else {
      const existing = db.select().from(aiMessages).where(eq(aiMessages.id, msgId)).get();
      if (existing) {
        db.update(aiMessages)
          .set({
            content:   existing.content + delta,
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
    data: { sessionId: id, messageId: msgId, delta, done, toolCalls: toolCalls ?? undefined },
  });

  res.json({ success: true, messageId: msgId });
});

export default router;
