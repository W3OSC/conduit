import { Router } from 'express';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';

const router = Router();

router.get('/', optionalAuth, (req, res) => {
  const db = getDb();
  const rows = db.select().from(settings).all();
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
  }
  res.json(result);
});

router.put('/', optionalAuth, (req, res) => {
  const db = getDb();
  const updates = req.body as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    db.insert(settings)
      .values({ key, value: JSON.stringify(value), updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: new Date().toISOString() } })
      .run();
  }
  const rows = db.select().from(settings).all();
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
  }
  res.json(result);
});

export default router;
