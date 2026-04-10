import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { getDb } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';

const router = Router();

router.get('/', optionalAuth, (req, res) => {
  const db = getDb();
  const keys = db.select().from(apiKeys).all().map((k) => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
  }));
  res.json(keys);
});

router.post('/', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { name } = req.body as { name: string };
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const rawKey = `sk-arb-${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(rawKey).digest('hex');
  const prefix = rawKey.slice(0, 12);

  const key = db.insert(apiKeys).values({
    name,
    keyHash: hash,
    keyPrefix: prefix,
    createdAt: new Date().toISOString(),
  }).returning().get();

  writeAuditLog('key_created', authedReq.actor, {
    targetId: String(key.id),
    detail: { name, prefix },
  });

  // Return full key ONCE
  res.json({ id: key.id, name: key.name, keyPrefix: prefix, key: rawKey, createdAt: key.createdAt });
});

router.delete('/:id', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const id = parseInt(req.params['id'] as string);
  const key = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!key) { res.status(404).json({ error: 'Not found' }); return; }

  db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, id)).run();
  writeAuditLog('key_revoked', authedReq.actor, { targetId: String(id), detail: { name: key.name } });
  res.json({ success: true });
});

export default router;
