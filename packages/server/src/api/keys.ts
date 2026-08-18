import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { getDb } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { uiOnlyAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import {
  z, intParam, requiredString, bodyOf, paramsOf, validateBody, validateParams,
} from './validate.js';

const router = Router();

// Admin-only routes: validated, but deliberately NOT added to the public
// OpenAPI document (see the header of openapi.ts — agent-relevant routes only).
const CreateKeyBody = z.object({ name: requiredString('name') });
const KeyIdParam = z.object({ id: intParam('api key') });

router.get('/', uiOnlyAuth, (req, res) => {
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

router.post('/', uiOnlyAuth, validateBody(CreateKeyBody), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { name } = bodyOf(CreateKeyBody, req);

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

router.delete('/:id', uiOnlyAuth, validateParams(KeyIdParam), (req, res) => {
  const authedReq = req as AuthedRequest;
  const db = getDb();
  const { id } = paramsOf(KeyIdParam, req);
  const key = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!key) { res.status(404).json({ error: 'Not found' }); return; }

  db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, id)).run();
  writeAuditLog('key_revoked', authedReq.actor, { targetId: String(id), detail: { name: key.name } });
  res.json({ success: true });
});

export default router;
