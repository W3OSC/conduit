/**
 * Gmail API routes.
 * All write actions (reply, archive, trash, etc.) create outbox items for approval.
 * Full email bodies are fetched live from Gmail API — never stored locally.
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { gmailMessages, outbox, permissions } from '../db/schema.js';
import { desc, eq, and, like, inArray, sql } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import type { GmailAction } from '../sync/gmail.js';

const router = Router();

// GET /api/gmail/status
router.get('/status', optionalAuth, (req, res) => {
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
router.get('/messages', optionalAuth, (req, res) => {
  const {
    q, label, unread, starred,
    limit = '50', offset = '0', thread_id,
  } = req.query as Record<string, string>;

  const db = getDb();
  let rows = db.select().from(gmailMessages)
    .orderBy(desc(gmailMessages.internalDate))
    .all();

  // Filters
  if (thread_id) rows = rows.filter((m) => m.threadId === thread_id);
  if (unread === 'true') rows = rows.filter((m) => !m.isRead);
  if (starred === 'true') rows = rows.filter((m) => m.isStarred);
  if (label) rows = rows.filter((m) => {
    try { return (JSON.parse(m.labels || '[]') as string[]).includes(label); } catch { return false; }
  });
  if (q) {
    const term = q.toLowerCase();
    rows = rows.filter((m) =>
      [m.subject, m.fromName, m.fromAddress, m.snippet]
        .some((f) => f?.toLowerCase().includes(term)),
    );
  }

  const total = rows.length;
  const lim = Math.min(parseInt(limit) || 50, 200);
  const off = parseInt(offset) || 0;
  const page = rows.slice(off, off + lim);

  res.json({ messages: page, total, limit: lim, offset: off });
});

// GET /api/gmail/messages/:id
router.get('/messages/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const msg = db.select().from(gmailMessages)
    .where(eq(gmailMessages.gmailId, req.params['id'] as string))
    .get();
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  res.json(msg);
});

// GET /api/gmail/messages/:id/body — live fetch from Gmail API
router.get('/messages/:id/body', optionalAuth, async (req, res) => {
  const manager = getConnectionManager();
  const gmail = manager.getGmail();
  if (!gmail) return res.status(503).json({ error: 'Gmail not connected' });

  try {
    const body = await gmail.fetchBody(req.params['id'] as string);
    res.json(body);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /api/gmail/threads/:threadId
router.get('/threads/:threadId', optionalAuth, (req, res) => {
  const db = getDb();
  const messages = db.select().from(gmailMessages)
    .where(eq(gmailMessages.threadId, req.params['threadId'] as string))
    .orderBy(gmailMessages.internalDate)
    .all();
  res.json({ messages, threadId: req.params['threadId'] });
});

// GET /api/gmail/labels — live from Gmail API
router.get('/labels', optionalAuth, async (req, res) => {
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
  const perm = db.select().from(permissions).where(eq(permissions.service, 'gmail')).get();
  if (!perm?.sendEnabled) {
    return res.status(403).json({ error: 'Gmail actions are not enabled' });
  }

  const status = perm.requireApproval ? 'pending' : 'approved';

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
router.post('/sync', optionalAuth, async (req, res) => {
  const manager = getConnectionManager();
  manager.triggerSync('gmail').catch(console.error);
  res.json({ success: true, message: 'Gmail sync started' });
});

export default router;
