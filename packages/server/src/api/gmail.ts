/**
 * Gmail API routes.
 * All write actions (reply, archive, trash, etc.) create outbox items for approval.
 * Full email bodies are fetched live from Gmail API — never stored locally.
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { gmailMessages, outbox } from '../db/schema.js';
import { desc, eq, and, or, like, sql, type SQL } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, trackAiCall, type AuthedRequest } from '../auth/middleware.js';
import { requireRead, isSendEnabled, isApprovalRequired, filterGmailByLabels } from './permissions-utils.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import type { GmailAction } from '../sync/gmail.js';

const router = Router();

type GmailRow = typeof gmailMessages.$inferSelect;

function rowLabels(m: GmailRow): string[] {
  try { return JSON.parse(m.labels || '[]') as string[]; } catch { return []; }
}

/** Per-key label allowlist check for a single message row. */
function canReadMessage(row: GmailRow, apiKeyId: number | null | undefined): boolean {
  return filterGmailByLabels([row], rowLabels, apiKeyId).length > 0;
}

// GET /api/gmail/status
router.get('/status', optionalAuth, requireRead('gmail'), (req, res) => {
  const manager = getConnectionManager();
  const status = manager.getStatus('gmail');
  const db = getDb();
  const count = db.select({ count: sql<number>`count(*)` }).from(gmailMessages).get();
  const unreadCount = db.select({ count: sql<number>`count(*)` }).from(gmailMessages)
    .where(eq(gmailMessages.isRead, false)).get();
  res.json({
    connected: status.status === 'connected',
    status: status.status,
    email: status.displayName,
    messageCount: count?.count || 0,
    unreadCount: unreadCount?.count || 0,
  });
});

// GET /api/gmail/messages
router.get('/messages', optionalAuth, requireRead('gmail'), trackAiCall, (req, res) => {
  const {
    q, label, unread, starred,
    limit = '50', offset = '0', thread_id,
  } = req.query as Record<string, string>;

  const db = getDb();
  const apiKeyId = (req as AuthedRequest).apiKey?.id ?? null;

  // Push filters into SQL — the previous implementation materialised the whole
  // table into JS on every request (and better-sqlite3 is synchronous, so that
  // stalled the entire server).
  const conds: SQL[] = [];
  if (thread_id) conds.push(eq(gmailMessages.threadId, thread_id));
  if (unread === 'true') conds.push(eq(gmailMessages.isRead, false));
  if (starred === 'true') conds.push(eq(gmailMessages.isStarred, true));
  if (label) conds.push(like(gmailMessages.labels, `%"${label.replace(/[%_"]/g, '')}"%`));
  if (q) {
    const term = `%${q.replace(/[%_]/g, '')}%`;
    const c = or(
      like(gmailMessages.subject, term),
      like(gmailMessages.fromName, term),
      like(gmailMessages.fromAddress, term),
      like(gmailMessages.snippet, term),
    );
    if (c) conds.push(c);
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  const lim = Math.min(parseInt(limit) || 50, 200);
  const off = parseInt(offset) || 0;

  let baseQuery = db.select().from(gmailMessages).orderBy(desc(gmailMessages.internalDate)).$dynamic();
  if (where) baseQuery = baseQuery.where(where);

  let page: GmailRow[];
  let total: number;
  if (apiKeyId) {
    // Label-allowlisted keys need post-filtering; page after the filter so
    // restricted keys still get correct pagination.
    const rows = filterGmailByLabels(baseQuery.all(), rowLabels, apiKeyId);
    total = rows.length;
    page = rows.slice(off, off + lim);
  } else {
    const countRow = (() => {
      let cq = db.select({ count: sql<number>`count(*)` }).from(gmailMessages).$dynamic();
      if (where) cq = cq.where(where);
      return cq.get();
    })();
    total = countRow?.count ?? 0;
    page = baseQuery.limit(lim).offset(off).all();
  }

  res.json({ messages: page, total, limit: lim, offset: off });
});

// GET /api/gmail/messages/:id
router.get('/messages/:id', optionalAuth, requireRead('gmail'), trackAiCall, (req, res) => {
  const db = getDb();
  const msg = db.select().from(gmailMessages)
    .where(eq(gmailMessages.gmailId, req.params['id'] as string))
    .get();
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!canReadMessage(msg, (req as AuthedRequest).apiKey?.id)) {
    return res.status(403).json({ error: 'Reading this message is not permitted for this API key' });
  }
  res.json(msg);
});

// GET /api/gmail/messages/:id/body — live fetch from Gmail API
router.get('/messages/:id/body', optionalAuth, requireRead('gmail'), trackAiCall, async (req, res) => {
  const manager = getConnectionManager();
  const gmail = manager.getGmail();
  if (!gmail) return res.status(503).json({ error: 'Gmail not connected' });

  // Label-restricted keys may only fetch bodies of messages they can see locally.
  const apiKeyId = (req as AuthedRequest).apiKey?.id;
  if (apiKeyId) {
    const db = getDb();
    const msg = db.select().from(gmailMessages)
      .where(eq(gmailMessages.gmailId, req.params['id'] as string))
      .get();
    if (!msg || !canReadMessage(msg, apiKeyId)) {
      return res.status(403).json({ error: 'Reading this message is not permitted for this API key' });
    }
  }

  try {
    const body = await gmail.fetchBody(req.params['id'] as string);
    res.json(body);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /api/gmail/threads/:threadId
router.get('/threads/:threadId', optionalAuth, requireRead('gmail'), trackAiCall, (req, res) => {
  const db = getDb();
  let messages = db.select().from(gmailMessages)
    .where(eq(gmailMessages.threadId, req.params['threadId'] as string))
    .orderBy(gmailMessages.internalDate)
    .all();
  messages = filterGmailByLabels(messages, rowLabels, (req as AuthedRequest).apiKey?.id);
  res.json({ messages, threadId: req.params['threadId'] });
});

// GET /api/gmail/labels — live from Gmail API
router.get('/labels', optionalAuth, requireRead('gmail'), trackAiCall, async (req, res) => {
  const manager = getConnectionManager();
  const gmail = manager.getGmail();
  if (!gmail) return res.status(503).json({ error: 'Gmail not connected' });

  try {
    const labels = await gmail.getLabels();
    res.json({ labels });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /api/gmail/actions — ALL actions create outbox items for approval
router.post('/actions', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const action = req.body as GmailAction;

  if (!action?.action) return res.status(400).json({ error: 'action is required' });

  const db = getDb();
  const apiKeyId = authedReq.apiKey?.id ?? null;
  if (!isSendEnabled('gmail', apiKeyId)) {
    return res.status(403).json({ error: 'Gmail actions are not enabled' });
  }

  const status = isApprovalRequired('gmail', apiKeyId) ? 'pending' : 'approved';

  const insertResult = db.insert(outbox).values({
    source: 'gmail',
    recipientId: action.messageId || action.threadId || 'gmail',
    recipientName: action.action,
    content: JSON.stringify(action),
    status,
    requester: authedReq.actor,
    apiKeyId: authedReq.apiKey?.id || null,
  }).run();

  const outboxId = insertResult.lastInsertRowid as number;

  writeAuditLog('send_request', authedReq.actor, {
    service: 'gmail',
    targetId: String(outboxId),
    detail: { action: action.action, messageId: action.messageId },
  });

  broadcast({ type: 'outbox:new', data: { id: outboxId, source: 'gmail', status } });

  // Auto-execute if approved immediately (no approval required)
  if (status === 'approved') {
    const manager = getConnectionManager();
    manager.executeGmailAction(action).then(() => {
      db.update(outbox).set({ status: 'sent', sentAt: new Date().toISOString() })
        .where(eq(outbox.id, outboxId)).run();
      broadcast({ type: 'outbox:updated', data: { id: outboxId, status: 'sent' } });
    }).catch((e: Error) => {
      db.update(outbox).set({ status: 'failed', errorMessage: e.message })
        .where(eq(outbox.id, outboxId)).run();
    });
  }

  res.json({ success: true, outboxItemId: outboxId, status });
});

// POST /api/gmail/sync
router.post('/sync', optionalAuth, requireRead('gmail'), async (req, res) => {
  const manager = getConnectionManager();
  manager.triggerSync('gmail').catch(console.error);
  res.json({ success: true, message: 'Gmail sync started' });
});

export default router;
