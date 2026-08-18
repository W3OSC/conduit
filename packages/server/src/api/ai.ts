/**
 * AI tool-call observability routes.
 *
 * External agents authenticate with an API key and may pass an X-Session-Id
 * header; when they do, every read they make is recorded as a row in
 * ai_tool_calls (see trackAiCall in auth/middleware.ts), and outbox items
 * they create are linked via outbox.ai_tool_call_id.
 *
 * The Outbox UI's "Raw AI request" panel resolves that link here.
 *
 * The former in-app AI chat (sessions, messages, webhook relay) was removed —
 * agents integrate over the plain REST API instead.
 */

import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { aiToolCalls } from '../db/schema.js';
import { optionalAuth } from '../auth/middleware.js';

const router = Router();

// ── GET /ai/tool-calls/:id ────────────────────────────────────────────────────
// Returns a single tool call by its ID (used to surface raw AI request context).

router.get('/tool-calls/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const { id } = req.params as { id: string };
  const call = db.select().from(aiToolCalls).where(eq(aiToolCalls.id, id)).get();
  if (!call) { res.status(404).json({ error: 'Tool call not found' }); return; }

  res.json({
    ...call,
    input: (() => { try { return JSON.parse(call.input); } catch { return call.input; } })(),
  });
});

export default router;
