/**
 * Agent-facing Slack primitives — the surface Meridian's Merlin agent speaks
 * through. All four endpoints are thin wrappers over the live Slack
 * connection; Meridian holds no Slack token.
 *
 * POST /agent/slack/post       — direct post (thread-aware, optional files),
 *                                NO outbox approval. Same trust model as
 *                                /notify/internal: this is our own workspace,
 *                                not outreach. Recorded as a sent outbox row.
 *                                Targets must be conversation ids (C/G/D) —
 *                                bare user ids are rejected so the endpoint
 *                                cannot auto-open DMs to arbitrary people.
 * POST /agent/slack/reactions  — add/remove an emoji reaction.
 * GET  /agent/slack/thread     — live read of one thread (root + newest
 *                                replies).
 * GET  /agent/slack/directory  — self identity + synced channels + member
 *                                uid↔email map.
 *
 * Gates: sends/reactions need the effective (per-key override aware) slack
 * sendEnabled permission plus the per-key fine-grained write allowlist;
 * reads need readEnabled plus the per-key fine-grained READ allowlist — the
 * live Slack token must never answer what the stored-message routes refuse.
 */

import { Router } from 'express';
import { and, eq, isNull, or } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { contacts, outbox } from '../db/schema.js';
import { optionalAuth, trackAiCall, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import { isChannelInSyncScope } from '../sync/source-filters.js';
import { validateAttachments, MAX_ATTACHMENTS, decodedSize } from '../util/attachments.js';
import {
  z, requiredString, bodyOf, queryOf, validateBody, validateQuery, limitSchema,
} from './validate.js';
import { documentRoute } from './openapi-registry.js';
import { checkWriteAllowlist } from './outbox.js';
import { requireRead, isSendEnabled, isReadPermitted, filterReadIds } from './permissions-utils.js';

const router = Router();

const AttachmentItem = z.object({
  filename: requiredString('filename'),
  mime: requiredString('mime').openapi({ description: 'MIME type, e.g. application/pdf.' }),
  data: requiredString('data').openapi({ description: 'Base64-encoded file bytes.' }),
});

const PostBody = z.object({
  channel_id: requiredString('channel_id')
    .openapi({ description: 'Conversation id (C…/G…/D…). Bare user ids are rejected.' }),
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

/**
 * Shared write gate: effective per-key sendEnabled + fine-grained write
 * allowlist. Returns the 403 message or null.
 */
function slackSendGate(channelId: string, apiKeyId: number | undefined): string | null {
  if (!isSendEnabled('slack', apiKeyId)) {
    return 'Sending is not enabled for slack';
  }
  return checkWriteAllowlist('slack', channelId, apiKeyId);
}

/**
 * Slack client errors that retrying can never fix map to 400 so agents stop
 * retrying them; everything else stays 502 (transient/transport).
 */
const PERMANENT_SLACK_ERRORS = new Set([
  'channel_not_found', 'not_in_channel', 'thread_not_found', 'invalid_name',
  'is_archived', 'msg_too_long', 'no_text', 'restricted_action', 'message_not_found',
]);

function slackErrorStatus(e: unknown): number {
  const code = (e as { data?: { error?: string } })?.data?.error;
  return code && PERMANENT_SLACK_ERRORS.has(code) ? 400 : 502;
}

documentRoute({
  method: 'post',
  path: '/agent/slack/post',
  body: PostBody,
  summary: 'Post to Slack as the agent (no approval queue)',
  description:
    'Direct thread-aware delivery to the team\'s own workspace, recorded as a sent ' +
    'outbox row. For agent conversation only — outreach to third parties must use POST /outbox. ' +
    'Targets must be existing conversation ids (C…/G…/D…); user ids are rejected.',
});

router.post('/post', optionalAuth, validateBody(PostBody), async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const body = bodyOf(PostBody, req);

  if (!/^[CGD]/.test(body.channel_id)) {
    res.status(400).json({
      error: 'channel_id must be a conversation id (C…/G…/D…) — pass the DM channel id, not a user id',
    });
    return;
  }
  const gateErr = slackSendGate(body.channel_id, authedReq.apiKey?.id);
  if (gateErr) {
    res.status(403).json({ error: gateErr });
    return;
  }
  const attachErr = validateAttachments('slack', body.attachments);
  if (attachErr) {
    res.status(400).json({ error: attachErr });
    return;
  }

  // History row: full text for the audit trail, attachment metas only (the
  // bytes were delivered immediately — no reason to retain base64 blobs).
  // NOT retryable through the outbox (metadata.agentSend guards the retry
  // route): dispatch there has no thread_ts and no stored attachment bytes.
  const baseMetadata = {
    agentSend: true,
    ...(body.thread_ts ? { threadTs: body.thread_ts } : {}),
    ...(body.attachments?.length
      ? { attachments: body.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: decodedSize(a.data) })) }
      : {}),
  };
  const record = (status: 'sent' | 'failed', extra: { ts?: string; errorMessage?: string } = {}) =>
    db.insert(outbox).values({
      source: 'slack',
      recipientId: body.channel_id,
      recipientName: body.channel_id,
      content: body.text,
      status,
      requester: authedReq.actor,
      apiKeyId: authedReq.apiKey?.id || null,
      errorMessage: extra.errorMessage ?? null,
      approvedAt: new Date().toISOString(),
      sentAt: status === 'sent' ? new Date().toISOString() : null,
      metadata: JSON.stringify({ ...baseMetadata, ...(extra.ts ? { ts: extra.ts } : {}) }),
    }).returning().get();

  // The irreversible part runs alone: a bookkeeping failure after Slack
  // accepted the message must NOT read as a failed delivery (the caller
  // would retry and double-post).
  let sent: { channel: string; ts?: string };
  try {
    const slack = getConnectionManager().getSlack();
    if (!slack) throw new Error('Slack not connected');
    sent = await slack.sendMessage(
      body.channel_id, body.text, body.attachments ?? [], { threadTs: body.thread_ts },
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    try {
      const item = record('failed', { errorMessage: errMsg });
      broadcast({ type: 'outbox:new', data: item });
      res.status(slackErrorStatus(e)).json({ error: errMsg, id: item.id });
    } catch {
      res.status(slackErrorStatus(e)).json({ error: errMsg });
    }
    return;
  }

  try {
    const item = record('sent', { ts: sent.ts });
    writeAuditLog('agent_slack_post', authedReq.actor, {
      service: 'slack',
      apiKeyId: authedReq.apiKey?.id,
      targetId: String(item.id),
      detail: { channelId: body.channel_id, threadTs: body.thread_ts, message: body.text.slice(0, 100) },
    });
    broadcast({ type: 'outbox:new', data: item });
    res.json({ success: true, id: item.id, channel: sent.channel, ts: sent.ts ?? null });
  } catch (e) {
    console.error('[agent-slack] Post delivered but bookkeeping failed:', e);
    res.json({ success: true, id: null, channel: sent.channel, ts: sent.ts ?? null });
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
  const body = bodyOf(ReactionBody, req);

  const gateErr = slackSendGate(body.channel_id, authedReq.apiKey?.id);
  if (gateErr) {
    res.status(403).json({ error: gateErr });
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
    res.status(slackErrorStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

documentRoute({
  method: 'get',
  path: '/agent/slack/thread',
  query: ThreadQuery,
  summary: 'Read one Slack thread live (root message + the newest replies, oldest first)',
  description:
    'Returns the thread root plus the newest limit-1 replies. Reads are gated by the ' +
    'same per-key channel allowlist as GET /messages.',
});

router.get('/thread', optionalAuth, trackAiCall, requireRead('slack'), validateQuery(ThreadQuery), async (req, res) => {
  const authedReq = req as AuthedRequest;
  const { channel_id, thread_ts, limit } = queryOf(ThreadQuery, req);
  // The live token sees everything — enforce the same boundaries the stored
  // routes do: per-key fine-grained read allowlist AND the sync scope.
  if (!isReadPermitted('slack', channel_id, authedReq.apiKey?.id)) {
    res.status(403).json({ error: 'Read access to this channel is not permitted for this API key' });
    return;
  }
  if (!isChannelInSyncScope('slack', channel_id)) {
    res.status(403).json({ error: 'Channel is outside the configured sync scope' });
    return;
  }
  try {
    const slack = getConnectionManager().getSlack();
    if (!slack) throw new Error('Slack not connected');
    const messages = await slack.fetchThread(channel_id, thread_ts, limit);
    res.json({ messages });
  } catch (e) {
    res.status(slackErrorStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

documentRoute({
  method: 'get',
  path: '/agent/slack/directory',
  summary: 'Slack identity map: self account, synced channels, member uid↔email',
  description:
    'Channels reflect the sync allowlist and the key\'s fine-grained read allowlist. ' +
    'Member emails require the users:read.email scope and a contact sync since it was ' +
    'granted. self.botId/teamId/teamName are absent on user-token connections.',
});

router.get('/directory', optionalAuth, trackAiCall, requireRead('slack'), async (_req, res) => {
  const authedReq = _req as AuthedRequest;
  try {
    const slack = getConnectionManager().getSlack();
    if (!slack || !slack.accountInfo) throw new Error('Slack not connected');
    const accountId = slack.accountInfo.userId;

    const inScope = (await slack.getChannels())
      .filter((ch) => isChannelInSyncScope('slack', ch.id, ch.type === 'im'));
    const permitted = new Set(
      filterReadIds('slack', inScope.map((ch) => ch.id), authedReq.apiKey?.id),
    );
    const channels = inScope
      .filter((ch) => permitted.has(ch.id))
      .map((ch) => ({ id: ch.id, name: ch.name, type: ch.type, isMember: ch.isMember ?? null }));

    const db = getDb();
    const members = db.select({
      userId: contacts.platformId,
      displayName: contacts.displayName,
      username: contacts.username,
      email: contacts.email,
    }).from(contacts)
      // accountId scoping keeps a second synced workspace's roster out;
      // legacy rows predating accountId stamping pass through.
      .where(and(
        eq(contacts.source, 'slack'),
        or(eq(contacts.accountId, accountId), isNull(contacts.accountId)),
      ))
      .all();

    res.json({ self: slack.accountInfo, channels, members });
  } catch (e) {
    res.status(slackErrorStatus(e)).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
