import { Router } from 'express';
import { getDb, getSqlite } from '../db/client.js';
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

// Streams the CSV row-by-row via better-sqlite3's .iterate() — never builds the
// full export in memory. Invoked by the UI via window.open with zero query
// params and cookie auth; action/service/actor filters are optional extras.
router.get('/export', optionalAuth, (req, res) => {
  const { action, service, actor } = req.query as Record<string, string>;
  const sqlite = getSqlite();

  const conditions: string[] = [];
  const params: string[] = [];
  if (action)  { conditions.push('action = ?');  params.push(action); }
  if (service) { conditions.push('service = ?'); params.push(service); }
  if (actor)   { conditions.push('actor = ?');   params.push(actor); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="conduit-audit-log.csv"');

  const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

  type AuditRow = {
    id: number;
    action: string;
    service: string | null;
    actor: string;
    target_id: string | null;
    detail: string | null;
    timestamp: string | null;
  };

  const stmt = sqlite.prepare(
    `SELECT id, action, service, actor, target_id, detail, timestamp
     FROM audit_log${where}
     ORDER BY timestamp DESC`,
  );

  const FLUSH_BYTES = 64 * 1024;
  let chunk = '"id","action","service","actor","targetId","detail","timestamp"';
  for (const row of stmt.iterate(...params) as IterableIterator<AuditRow>) {
    chunk += '\n' + [
      row.id,
      row.action,
      row.service || '',
      row.actor,
      row.target_id || '',
      row.detail || '',
      row.timestamp || '',
    ].map(escape).join(',');
    if (chunk.length >= FLUSH_BYTES) {
      res.write(chunk);
      chunk = '';
    }
  }
  if (chunk) res.write(chunk);
  res.end();
});

export default router;
