import { Router } from 'express';
import { getDb } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { eq, and, desc, gte, lte, like, sql } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';

const router = Router();

router.get('/', optionalAuth, (req, res) => {
  const { action, service, actor, from, to, limit = '100', offset = '0' } = req.query as Record<string, string>;
  const db = getDb();
  const lim = Math.min(parseInt(limit) || 100, 1000);
  const off = parseInt(offset) || 0;

  const conditions = [];
  if (action)  conditions.push(eq(auditLog.action, action));
  if (service) conditions.push(eq(auditLog.service, service));
  if (actor)   conditions.push(eq(auditLog.actor, actor));
  if (from)    conditions.push(gte(auditLog.timestamp, from));
  if (to)      conditions.push(lte(auditLog.timestamp, to));

  const where = conditions.length ? and(...conditions) : undefined;

  const total = (db.select({ count: sql<number>`count(*)` }).from(auditLog).where(where).get()?.count) ?? 0;

  const items = db.select().from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.timestamp))
    .limit(lim)
    .offset(off)
    .all();

  res.json({ items, total });
});

router.get('/export', optionalAuth, (req, res) => {
  const db = getDb();
  const items = db.select().from(auditLog).orderBy(desc(auditLog.timestamp)).all();

  const headers = ['id', 'action', 'service', 'actor', 'targetId', 'detail', 'timestamp'];
  const rows = items.map((i) => [
    i.id,
    i.action,
    i.service || '',
    i.actor,
    i.targetId || '',
    i.detail || '',
    i.timestamp || '',
  ]);

  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="conduit-audit-log.csv"');
  res.send(csv);
});

export default router;
