/**
 * Internal notifications — direct sends to the team's own channels.
 *
 * POST /notify/internal delivers a message through a connected messaging
 * service (slack or telegram) WITHOUT the outbox approval queue. This is for
 * a trusted system (the CRM) telling the team about its own events — lead
 * scored, doc generated, churn risk — not for outreach to third parties,
 * which must go through POST /outbox and human approval.
 *
 * Meridian has posted here (fire-and-forget) since before the endpoint
 * existed, so the body accepts its historical shape: telegram targets may
 * arrive as `chat_id` and the channel rides alongside `message`/`priority`.
 *
 * Gates: the service's sendEnabled permission, plus the per-key fine-grained
 * write allowlist for API-key actors. Every delivery is recorded as an
 * already-sent outbox row so the UI/audit trail shows it.
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { outbox, permissions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import { z, requiredString, bodyOf, validateBody } from './validate.js';
import { documentRoute } from './openapi-registry.js';
import { checkWriteAllowlist } from './outbox.js';

const router = Router();

const NOTIFY_CHANNELS = ['slack', 'telegram'] as const;

const NotifyBody = z.object({
  channel: z.enum(NOTIFY_CHANNELS, { error: 'must be "slack" or "telegram"' })
    .openapi({ description: 'Connected service to deliver through.' }),
  target: z.string().optional()
    .openapi({ description: 'Slack channel id/name or Telegram chat id.' }),
  // Historical Meridian payload shape for telegram.
  chat_id: z.union([z.string(), z.number()]).optional()
    .openapi({ description: 'Legacy alias for target (telegram chat id).' }),
  message: requiredString('message'),
  priority: z.string().optional().openapi({ description: 'Informational only.' }),
});

documentRoute({
  method: 'post',
  path: '/notify/internal',
  body: NotifyBody,
  summary: 'Send an internal team notification (no approval queue)',
  description:
    'Direct delivery to a connected slack/telegram target. For system-to-team ' +
    'notifications only — outreach to third parties must use POST /outbox.',
});

router.post('/internal', optionalAuth, validateBody(NotifyBody), async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const body = bodyOf(NotifyBody, req);

  const target = (body.target ?? (body.chat_id != null ? String(body.chat_id) : '')).trim();
  if (!target) {
    res.status(400).json({ error: 'target (or chat_id) is required' });
    return;
  }

  const perm = db.select().from(permissions).where(eq(permissions.service, body.channel)).get();
  if (!perm?.sendEnabled) {
    res.status(403).json({ error: `Sending is not enabled for ${body.channel}` });
    return;
  }
  const writeErr = checkWriteAllowlist(body.channel, target, authedReq.apiKey?.id);
  if (writeErr) {
    res.status(403).json({ error: writeErr });
    return;
  }

  const record = (status: 'sent' | 'failed', errorMessage?: string) =>
    db.insert(outbox).values({
      source: body.channel,
      recipientId: target,
      recipientName: target,
      content: body.message,
      status,
      requester: authedReq.actor,
      apiKeyId: authedReq.apiKey?.id || null,
      errorMessage: errorMessage ?? null,
      approvedAt: new Date().toISOString(),
      sentAt: status === 'sent' ? new Date().toISOString() : null,
    }).returning().get();

  try {
    const manager = getConnectionManager();
    await manager.sendMessage(body.channel, target, body.message);
    const item = record('sent');
    writeAuditLog('notify_internal', authedReq.actor, {
      service: body.channel,
      apiKeyId: authedReq.apiKey?.id,
      targetId: String(item.id),
      detail: { target, message: body.message.slice(0, 100) },
    });
    broadcast({ type: 'outbox:new', data: item });
    res.json({ success: true, id: item.id });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const item = record('failed', errMsg);
    broadcast({ type: 'outbox:new', data: item });
    res.status(502).json({ error: errMsg, id: item.id });
  }
});

export default router;
