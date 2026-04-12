import { Router } from 'express';
import { getDb } from '../db/client.js';
import { permissions, apiKeyPermissions, apiKeys } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';

const router = Router();

const ALL_SERVICES = ['slack', 'discord', 'telegram', 'gmail', 'calendar', 'twitter', 'notion'] as const;

// ── Global (UI) permissions ───────────────────────────────────────────────────

router.get('/', optionalAuth, (_req, res) => {
  const db = getDb();
  res.json(db.select().from(permissions).all());
});

router.put('/:service', optionalAuth, (req, res) => {
  const db = getDb();
  const service = req.params['service'] as string;
  const { readEnabled, sendEnabled, requireApproval, directSendFromUi, markReadEnabled } = req.body as {
    readEnabled?: boolean; sendEnabled?: boolean;
    requireApproval?: boolean; directSendFromUi?: boolean; markReadEnabled?: boolean;
  };

  const existing = db.select().from(permissions).where(eq(permissions.service, service)).get();
  if (!existing) { res.status(404).json({ error: `Service ${service} not found` }); return; }

  const updates: Partial<typeof permissions.$inferInsert> & { updatedAt: string } = { updatedAt: new Date().toISOString() };
  if (readEnabled       !== undefined) updates.readEnabled       = readEnabled;
  if (sendEnabled       !== undefined) updates.sendEnabled       = sendEnabled;
  if (requireApproval   !== undefined) updates.requireApproval   = requireApproval;
  if (directSendFromUi  !== undefined) updates.directSendFromUi  = directSendFromUi;
  if (markReadEnabled   !== undefined) updates.markReadEnabled   = markReadEnabled;

  db.update(permissions).set(updates).where(eq(permissions.service, service)).run();
  res.json(db.select().from(permissions).where(eq(permissions.service, service)).get());
});

// ── Per-API-key permissions ───────────────────────────────────────────────────
//
// GET  /api/permissions/keys/:keyId
//   Returns the effective permission set for this key — global defaults merged
//   with any key-specific overrides. Also includes the raw overrides so the UI
//   can distinguish "set" from "inherited".
//
// PUT  /api/permissions/keys/:keyId/:service
//   Body: { readEnabled?: boolean|null, sendEnabled?: boolean|null, requireApproval?: boolean|null }
//   null = revert to inheriting from global.

router.get('/keys/:keyId', optionalAuth, (req, res) => {
  const db = getDb();
  const keyId = parseInt(req.params['keyId'] as string);

  const key = db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (!key || key.revokedAt) return res.status(404).json({ error: 'Key not found' });

  const globals = db.select().from(permissions).all();
  const overrides = db.select().from(apiKeyPermissions).where(eq(apiKeyPermissions.apiKeyId, keyId)).all();

  const result = ALL_SERVICES.map((service) => {
    const global = globals.find((g) => g.service === service);
    const override = overrides.find((o) => o.service === service);
    return {
      service,
      // Effective = override ?? global default
      readEnabled:     override?.readEnabled     ?? global?.readEnabled     ?? true,
      sendEnabled:     override?.sendEnabled     ?? global?.sendEnabled     ?? false,
      requireApproval: override?.requireApproval ?? global?.requireApproval ?? true,
      // Raw override values (null = inheriting)
      overrides: {
        readEnabled:     override?.readEnabled     ?? null,
        sendEnabled:     override?.sendEnabled     ?? null,
        requireApproval: override?.requireApproval ?? null,
      },
    };
  });

  res.json({ keyId, keyName: key.name, keyPrefix: key.keyPrefix, permissions: result });
});

router.put('/keys/:keyId/:service', optionalAuth, (req, res) => {
  const db = getDb();
  const keyId  = parseInt(req.params['keyId']  as string);
  const service = req.params['service'] as string;

  const key = db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (!key || key.revokedAt) return res.status(404).json({ error: 'Key not found' });

  const body = req.body as {
    readEnabled?:     boolean | null;
    sendEnabled?:     boolean | null;
    requireApproval?: boolean | null;
  };

  // Upsert override row
  db.insert(apiKeyPermissions)
    .values({ apiKeyId: keyId, service, readEnabled: null, sendEnabled: null, requireApproval: null })
    .onConflictDoNothing()
    .run();

  const updates: Partial<typeof apiKeyPermissions.$inferInsert> = {};
  if ('readEnabled'     in body) updates.readEnabled     = body.readEnabled     ?? null;
  if ('sendEnabled'     in body) updates.sendEnabled     = body.sendEnabled     ?? null;
  if ('requireApproval' in body) updates.requireApproval = body.requireApproval ?? null;

  db.update(apiKeyPermissions)
    .set(updates)
    .where(and(eq(apiKeyPermissions.apiKeyId, keyId), eq(apiKeyPermissions.service, service)))
    .run();

  res.json({ success: true });
});

export default router;
