import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/client.js';
import { outbox, permissions } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';

const router = Router();

// ── Shared dispatch helper ────────────────────────────────────────────────────

/**
 * Execute a single outbox item against the appropriate platform connection.
 * Used by both the auto-send path (POST /) and the approval path (PATCH /:id).
 */
async function dispatchOutboxItem(
  source: string,
  recipientId: string,
  content: string,
): Promise<void> {
  const manager = getConnectionManager();
  if (source === 'gmail') {
    await manager.executeGmailAction(JSON.parse(content) as Parameters<typeof manager.executeGmailAction>[0]);
  } else if (source === 'calendar') {
    await manager.executeCalendarAction(JSON.parse(content) as Parameters<typeof manager.executeCalendarAction>[0]);
  } else if (source === 'twitter') {
    await manager.executeTwitterAction(JSON.parse(content) as Parameters<typeof manager.executeTwitterAction>[0]);
  } else if (source === 'notion') {
    await manager.executeNotionAction(JSON.parse(content) as Parameters<typeof manager.executeNotionAction>[0]);
  } else if (source === 'obsidian') {
    await manager.executeObsidianAction(JSON.parse(content) as Parameters<typeof manager.executeObsidianAction>[0]);
  } else {
    await manager.sendMessage(source as 'slack' | 'discord' | 'telegram', recipientId, content);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', optionalAuth, (req, res) => {
  const db = getDb();
  const { status, source } = req.query as Record<string, string>;

  const conditions = [];
  if (status) conditions.push(eq(outbox.status, status));
  if (source) conditions.push(eq(outbox.source, source));

  const items = db.select().from(outbox)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(outbox.createdAt))
    .all();

  const pendingCount = (db.select({ count: sql<number>`count(*)` }).from(outbox)
    .where(eq(outbox.status, 'pending')).get()?.count) ?? 0;

  res.json({ items, pendingCount });
});

router.get('/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const item = db.select().from(outbox).where(eq(outbox.id, parseInt(req.params['id'] as string))).get();
  if (!item) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(item);
});

router.post('/', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { source, recipient_id, recipient_name, content } = req.body as {
    source: string;
    recipient_id: string;
    recipient_name?: string;
    content: string;
  };

  if (!source || !recipient_id || !content) {
    res.status(400).json({ error: 'source, recipient_id, content are required' });
    return;
  }

  const perm = db.select().from(permissions).where(eq(permissions.service, source)).get();
  if (!perm?.sendEnabled) {
    res.status(403).json({ error: `Sending is not enabled for ${source}` });
    return;
  }

  const item = db.insert(outbox).values({
    source,
    recipientId: recipient_id,
    recipientName: recipient_name || recipient_id,
    content,
    status: 'pending',
    requester: authedReq.actor,
    apiKeyId: authedReq.apiKey?.id || null,
  }).returning().get();

  writeAuditLog('send_request', authedReq.actor, {
    service: source,
    apiKeyId: authedReq.apiKey?.id,
    targetId: String(item.id),
    detail: { recipient_id, content: content.slice(0, 100) },
  });

  broadcast({ type: 'outbox:new', data: item });

  if (authedReq.actor === 'ui' && perm.directSendFromUi && !perm.requireApproval) {
    try {
      await dispatchOutboxItem(source, recipient_id, content);
      db.update(outbox).set({
        status: 'sent',
        approvedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
      }).where(eq(outbox.id, item.id)).run();
      writeAuditLog('send', authedReq.actor, {
        service: source,
        apiKeyId: authedReq.apiKey?.id,
        targetId: String(item.id),
        detail: { recipient_id, auto_sent: true },
      });
      broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'sent' } });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      db.update(outbox).set({ status: 'failed', errorMessage: errMsg }).where(eq(outbox.id, item.id)).run();
    }
  }

  res.json(db.select().from(outbox).where(eq(outbox.id, item.id)).get());
});

router.post('/batch', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { source, recipient_ids, content } = req.body as {
    source: string;
    recipient_ids: Array<{ id: string; name?: string }>;
    content: string;
  };

  if (!source || !recipient_ids?.length || !content) {
    res.status(400).json({ error: 'source, recipient_ids, content are required' });
    return;
  }

  const perm = db.select().from(permissions).where(eq(permissions.service, source)).get();
  if (!perm?.sendEnabled) {
    res.status(403).json({ error: `Sending is not enabled for ${source}` });
    return;
  }

  const batchId = randomUUID();
  const items = [];

  for (const recipient of recipient_ids) {
    const item = db.insert(outbox).values({
      batchId,
      source,
      recipientId: recipient.id,
      recipientName: recipient.name || recipient.id,
      content,
      status: 'pending',
      requester: authedReq.actor,
      apiKeyId: authedReq.apiKey?.id || null,
    }).returning().get();
    items.push(item);
  }

  broadcast({ type: 'outbox:new', data: { batchId, count: items.length, items } });

  res.json({ batchId, items });
});

/**
 * POST /api/outbox/batch/multi
 *
 * Queue a heterogeneous batch of outbox operations across any combination of
 * services. All operations share a single batchId so they can be reviewed and
 * acted on as a logical bundle. Per-operation permission checks are applied.
 *
 * Body:
 * {
 *   operations: Array<{
 *     source: string;
 *     recipient_id: string;
 *     recipient_name?: string;
 *     content: string;       // plain text for messaging services; JSON payload for structured services
 *   }>
 * }
 *
 * Response:
 * { batchId: string, items: Array<{ id: number, source: string, status: string }> }
 */
router.post('/batch/multi', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();

  const { operations } = req.body as {
    operations: Array<{
      source: string;
      recipient_id: string;
      recipient_name?: string;
      content: string;
    }>;
  };

  if (!Array.isArray(operations) || operations.length === 0) {
    res.status(400).json({ error: 'operations must be a non-empty array' });
    return;
  }

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!op.source || !op.recipient_id || !op.content) {
      res.status(400).json({ error: `operations[${i}] is missing source, recipient_id, or content` });
      return;
    }
    const perm = db.select().from(permissions).where(eq(permissions.service, op.source)).get();
    if (!perm?.sendEnabled) {
      res.status(403).json({ error: `Sending is not enabled for ${op.source} (operations[${i}])` });
      return;
    }
  }

  const batchId = randomUUID();
  const items = [];

  for (const op of operations) {
    const perm = db.select().from(permissions).where(eq(permissions.service, op.source)).get()!;

    const item = db.insert(outbox).values({
      batchId,
      source: op.source,
      recipientId: op.recipient_id,
      recipientName: op.recipient_name || op.recipient_id,
      content: op.content,
      status: 'pending',
      requester: authedReq.actor,
      apiKeyId: authedReq.apiKey?.id || null,
    }).returning().get();

    writeAuditLog('send_request', authedReq.actor, {
      service: op.source,
      apiKeyId: authedReq.apiKey?.id,
      targetId: String(item.id),
      detail: { batch_id: batchId, recipient_id: op.recipient_id, content: op.content.slice(0, 100) },
    });

    if (authedReq.actor === 'ui' && perm.directSendFromUi && !perm.requireApproval) {
      try {
        await dispatchOutboxItem(op.source, op.recipient_id, op.content);
        db.update(outbox).set({
          status: 'sent',
          approvedAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
        }).where(eq(outbox.id, item.id)).run();
        writeAuditLog('send', authedReq.actor, {
          service: op.source,
          apiKeyId: authedReq.apiKey?.id,
          targetId: String(item.id),
          detail: { batch_id: batchId, recipient_id: op.recipient_id, auto_sent: true },
        });
        items.push({ ...item, status: 'sent' });
        broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'sent' } });
        continue;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        db.update(outbox).set({ status: 'failed', errorMessage: errMsg }).where(eq(outbox.id, item.id)).run();
        items.push({ ...item, status: 'failed', errorMessage: errMsg });
        broadcast({ type: 'outbox:updated', data: { id: item.id, status: 'failed', error: errMsg } });
        continue;
      }
    }

    items.push(item);
  }

  broadcast({ type: 'outbox:new', data: { batchId, count: items.length, items } });
  res.json({ batchId, items });
});

router.patch('/:id', optionalAuth, async (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const id = parseInt(req.params['id'] as string);
  const { action, content } = req.body as { action: 'approve' | 'reject' | 'edit'; content?: string };

  const item = db.select().from(outbox).where(eq(outbox.id, id)).get();
  if (!item) { res.status(404).json({ error: 'Not found' }); return; }
  if (item.status !== 'pending' && action !== 'edit') {
    res.status(400).json({ error: 'Item is not pending' });
    return;
  }

  if (action === 'edit') {
    db.update(outbox).set({ editedContent: content || item.content }).where(eq(outbox.id, id)).run();
    res.json(db.select().from(outbox).where(eq(outbox.id, id)).get());
    return;
  }

  if (action === 'reject') {
    db.update(outbox).set({ status: 'rejected' }).where(eq(outbox.id, id)).run();
    writeAuditLog('reject', authedReq.actor, { service: item.source, targetId: String(id) });
    broadcast({ type: 'outbox:updated', data: { id, status: 'rejected' } });
    res.json({ success: true, status: 'rejected' });
    return;
  }

  if (action === 'approve') {
    db.update(outbox).set({ status: 'approved', approvedAt: new Date().toISOString() }).where(eq(outbox.id, id)).run();
    writeAuditLog('approve', authedReq.actor, { service: item.source, targetId: String(id) });

    try {
      const textToSend = item.editedContent || item.content;
      await dispatchOutboxItem(item.source, item.recipientId, textToSend);
      db.update(outbox).set({ status: 'sent', sentAt: new Date().toISOString() }).where(eq(outbox.id, id)).run();
      writeAuditLog('send', authedReq.actor, {
        service: item.source,
        targetId: String(id),
        detail: { recipient_id: item.recipientId },
      });
      broadcast({ type: 'outbox:updated', data: { id, status: 'sent' } });
      res.json({ success: true, status: 'sent' });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      db.update(outbox).set({ status: 'failed', errorMessage: errMsg }).where(eq(outbox.id, id)).run();
      broadcast({ type: 'outbox:updated', data: { id, status: 'failed', error: errMsg } });
      res.status(500).json({ error: errMsg });
    }
  }
});

router.delete('/:id', optionalAuth, (req, res) => {
  const db = getDb();
  db.delete(outbox).where(eq(outbox.id, parseInt(req.params['id'] as string))).run();
  res.json({ success: true });
});

export default router;
