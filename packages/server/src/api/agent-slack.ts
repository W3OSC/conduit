/**
 * Agent-facing Slack primitives — the surface Meridian's Merlin agent speaks
 * through. All four endpoints are thin wrappers over the live Slack
 * connection; Meridian holds no Slack token of its own.
 *
 * POST /agent/slack/post       — direct post (thread-aware, optional files),
 *                                NO outbox approval. Same trust model as
 *                                /notify/internal: this is our own workspace,
 *                                not outreach. Recorded as a sent outbox row.
 * POST /agent/slack/reactions  — add/remove an emoji reaction.
 * GET  /agent/slack/thread     — live read of one thread (root + replies).
 * GET  /agent/slack/directory  — self identity + synced channels + member
 *                                uid↔email map.
 *
 * Gates: sends/reactions need the slack sendEnabled permission plus the
 * per-key fine-grained write allowlist; reads need readEnabled.
 */

import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { contacts, outbox, permissions } from '../db/schema.js';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import { getSourceAllowlist } from '../sync/source-filters.js';
import { validateAttachments, MAX_ATTACHMENTS, decodedSize } from '../util/attachments.js';
import {
  z, requiredString, bodyOf, queryOf, validateBody, validateQuery, limitSchema,
} from './validate.js';
import { documentRoute } from './openapi-registry.js';
import { checkWriteAllowlist } from './outbox.js';
import { requireRead } from './permissions-utils.js';

const router = Router();

const AttachmentItem = z.object({
  filename: requiredString('filename'),
  mime: requiredString('mime').openapi({ description: 'MIME type, e.g. application/pdf.' }),
  data: requiredString('data').openapi({ description: 'Base64-encoded file bytes.' }),
});

const PostBody = z.object({
  channel_id: requiredString('channel_id')
    .openapi({ description: 'Channel id (C…/G…/D…) or user id (U…/W… opens a DM).' }),
  text: requiredString('text'),
  thread_ts: z.string().optional()
    .openapi({ description: 'Parent message ts — reply inside that thread.' }),
  attachments: z.array(AttachmentItem).max(MAX_ATTACHMENTS).optional()
    .openapi({ description: `Files to upload alongside the text (max ${MAX_ATTACHMENTS}, 5 MiB decoded total).` }),
});

const ReactionBody = z.object({
  channel_id: requiredString('channel_id'),
  ts: requiredString('ts').openapi({ description: 'Message timestamp to react on.' }),
  emoji: requiredString('emoji').openapi({ description: 'Emoji name without colons, e.g. "white_check_mark".' }),
  remove: z.boolean().optional().openapi({ description: 'Remove the reaction instead of adding it.' }),
});

const ThreadQuery = z.object({
  channel_id: requiredString('channel_id'),
  thread_ts: requiredString('thread_ts'),
  limit: limitSchema(50, 200),
});

documentRoute({
  method: 'post',
  path: '/agent/slack/post',
  body: PostBody,
  summary: 'Post to Slack as the agent (no approval queue)',
  description:
    'Direct thread-aware delivery to the team\'s own workspace, recorded as a sent ' +
    'outbox row. For agent conversation only — outreach to third parties must use POST /outbox.',
});

router.post('/post', optionalAuth, validateBody(PostBody), async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const body = bodyOf(PostBody, req);

  const perm = db.select().from(permissions).where(eq(permissions.service, 'slack')).get();
  if (!perm?.sendEnabled) {
    res.status(403).json({ error: 'Sending is not enabled for slack' });
    return;
  }
  const writeErr = checkWriteAllowlist('slack', body.channel_id, authedReq.apiKey?.id);
  if (writeErr) {
    res.status(403).json({ error: writeErr });
    return;
  }
  const attachErr = validateAttachments('slack', body.attachments);
  if (attachErr) {
    res.status(400).json({ error: attachErr });
    return;
  }

  // History row: full text for the audit trail, attachment metas only (the
  // bytes were delivered immediately — no reason to retain base64 blobs).
  const record = (status: 'sent' | 'failed', ts?: string, errorMessage?: string) =>
    db.insert(outbox).values({
      source: 'slack',
      recipientId: body.channel_id,
      recipientName: body.channel_id,
      content: body.text,
      status,
      requester: authedReq.actor,
      apiKeyId: authedReq.apiKey?.id || null,
      errorMessage: errorMessage ?? null,
      approvedAt: new Date().toISOString(),
      sentAt: status === 'sent' ? new Date().toISOString() : null,
      metadata: JSON.stringify({
        agentSend: true,
        ...(body.thread_ts ? { threadTs: body.thread_ts } : {}),
        ...(ts ? { ts } : {}),
        ...(body.attachments?.length
          ? { attachments: body.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: decodedSize(a.data) })) }
          : {}),
      }),
    }).returning().get();

  try {
    const slack = getConnectionManager().getSlack();
    if (!slack) throw new Error('Slack not connected');
    const sent = await slack.sendMessage(
      body.channel_id, body.text, body.attachments ?? [], { threadTs: body.thread_ts },
    );
    const item = record('sent', sent.ts);
    writeAuditLog('agent_slack_post', authedReq.actor, {
      service: 'slack',
      apiKeyId: authedReq.apiKey?.id,
      targetId: String(item.id),
      detail: { channelId: body.channel_id, threadTs: body.thread_ts, message: body.text.slice(0, 100) },
    });
    broadcast({ type: 'outbox:new', data: item });
    res.json({ success: true, id: item.id, channel: sent.channel, ts: sent.ts ?? null });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const item = record('failed', undefined, errMsg);
    broadcast({ type: 'outbox:new', data: item });
    res.status(502).json({ error: errMsg, id: item.id });
  }
});

documentRoute({
  method: 'post',
  path: '/agent/slack/reactions',
  body: ReactionBody,
  summary: 'Add or remove an emoji reaction on a Slack message',
});

router.post('/reactions', optionalAuth, validateBody(ReactionBody), async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const body = bodyOf(ReactionBody, req);

  const perm = db.select().from(permissions).where(eq(permissions.service, 'slack')).get();
  if (!perm?.sendEnabled) {
    res.status(403).json({ error: 'Sending is not enabled for slack' });
    return;
  }
  const writeErr = checkWriteAllowlist('slack', body.channel_id, authedReq.apiKey?.id);
  if (writeErr) {
    res.status(403).json({ error: writeErr });
    return;
  }

  try {
    const slack = getConnectionManager().getSlack();
    if (!slack) throw new Error('Slack not connected');
    await slack.setReaction(body.channel_id, body.ts, body.emoji, body.remove === true);
    writeAuditLog('agent_slack_reaction', authedReq.actor, {
      service: 'slack',
      apiKeyId: authedReq.apiKey?.id,
      detail: { channelId: body.channel_id, ts: body.ts, emoji: body.emoji, remove: body.remove === true },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

documentRoute({
  method: 'get',
  path: '/agent/slack/thread',
  query: ThreadQuery,
  summary: 'Read one Slack thread live (root message + replies, oldest first)',
});

router.get('/thread', optionalAuth, requireRead('slack'), validateQuery(ThreadQuery), async (req, res) => {
  const { channel_id, thread_ts, limit } = queryOf(ThreadQuery, req);
  try {
    const slack = getConnectionManager().getSlack();
    if (!slack) throw new Error('Slack not connected');
    const messages = await slack.fetchThread(channel_id, thread_ts, limit);
    res.json({ messages });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

documentRoute({
  method: 'get',
  path: '/agent/slack/directory',
  summary: 'Slack identity map: self account, synced channels, member uid↔email',
  description:
    'Channels reflect the sync allowlist (what the agent can hear). Member emails ' +
    'require the users:read.email scope and a contact sync since it was granted.',
});

router.get('/directory', optionalAuth, requireRead('slack'), async (req, res) => {
  void req;
  try {
    const slack = getConnectionManager().getSlack();
    if (!slack) throw new Error('Slack not connected');

    const allowed = getSourceAllowlist('slack');
    const channels = (await slack.getChannels())
      .filter((ch) => ch.type === 'im' || !allowed || allowed.has(ch.id))
      .map((ch) => ({ id: ch.id, name: ch.name, type: ch.type, isMember: ch.isMember ?? null }));

    const db = getDb();
    const members = db.select({
      userId: contacts.platformId,
      displayName: contacts.displayName,
      username: contacts.username,
      email: contacts.email,
    }).from(contacts).where(eq(contacts.source, 'slack')).all();

    res.json({ self: slack.accountInfo, channels, members });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
