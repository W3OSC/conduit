import { Router } from 'express';
import { getDb } from '../db/client.js';
import { permissions, apiKeyPermissions, apiKeys } from '../db/schema.js';
import type { ServiceFineGrained } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';

const router = Router();

export const ALL_SERVICES = ['slack', 'discord', 'telegram', 'gmail', 'calendar', 'twitter', 'notion', 'obsidian', 'smb'] as const;
export type AllService = typeof ALL_SERVICES[number];

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFineGrained(raw: string | null | undefined): ServiceFineGrained | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as ServiceFineGrained; } catch { return null; }
}

// ── Global (UI) permissions ───────────────────────────────────────────────────

router.get('/', optionalAuth, (_req, res) => {
  const db = getDb();
  const rows = db.select().from(permissions).all();
  const result = rows.map((r) => ({
    ...r,
    fineGrainedConfig: parseFineGrained(r.fineGrainedConfig),
  }));
  res.json(result);
});

router.put('/:service', optionalAuth, (req, res) => {
  const db = getDb();
  const service = req.params['service'] as string;
  const {
    readEnabled, sendEnabled, requireApproval, directSendFromUi, markReadEnabled,
    fineGrainedConfig,
  } = req.body as {
    readEnabled?: boolean; sendEnabled?: boolean;
    requireApproval?: boolean; directSendFromUi?: boolean; markReadEnabled?: boolean;
    fineGrainedConfig?: ServiceFineGrained | null;
  };

  const existing = db.select().from(permissions).where(eq(permissions.service, service)).get();
  if (!existing) { res.status(404).json({ error: `Service ${service} not found` }); return; }

  const updates: Partial<typeof permissions.$inferInsert> & { updatedAt: string } = { updatedAt: new Date().toISOString() };
  if (readEnabled       !== undefined) updates.readEnabled       = readEnabled;
  if (sendEnabled       !== undefined) updates.sendEnabled       = sendEnabled;
  if (requireApproval   !== undefined) updates.requireApproval   = requireApproval;
  if (directSendFromUi  !== undefined) updates.directSendFromUi  = directSendFromUi;
  if (markReadEnabled   !== undefined) updates.markReadEnabled   = markReadEnabled;
  if ('fineGrainedConfig' in req.body) {
    updates.fineGrainedConfig = fineGrainedConfig != null ? JSON.stringify(fineGrainedConfig) : null;
  }

  db.update(permissions).set(updates).where(eq(permissions.service, service)).run();
  const updated = db.select().from(permissions).where(eq(permissions.service, service)).get()!;
  res.json({ ...updated, fineGrainedConfig: parseFineGrained(updated.fineGrainedConfig) });
});

// ── Per-API-key permissions ───────────────────────────────────────────────────
//
// GET  /api/permissions/keys/:keyId
//   Returns the effective permission set for this key — global defaults merged
//   with any key-specific overrides. Also includes the raw overrides so the UI
//   can distinguish "set" from "inherited".
//
// PUT  /api/permissions/keys/:keyId/:service
//   Body: { readEnabled?: boolean|null, sendEnabled?: boolean|null, requireApproval?: boolean|null, fineGrainedConfig?: object|null }
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

    // Resolve fine-grained config: override takes precedence if non-null
    const globalFg = parseFineGrained(global?.fineGrainedConfig);
    const overrideFg = override ? parseFineGrained(override.fineGrainedConfig) : undefined;
    // overrideFg === undefined means no override row or override row has no fg config
    // overrideFg === null means explicitly cleared (inherit from global)
    const effectiveFg = overrideFg !== undefined ? overrideFg : globalFg;

    return {
      service,
      // Effective = override ?? global default
      readEnabled:     override?.readEnabled     ?? global?.readEnabled     ?? true,
      sendEnabled:     override?.sendEnabled     ?? global?.sendEnabled     ?? false,
      requireApproval: override?.requireApproval ?? global?.requireApproval ?? true,
      fineGrainedConfig: effectiveFg,
      // Raw override values (null = inheriting)
      overrides: {
        readEnabled:     override?.readEnabled     ?? null,
        sendEnabled:     override?.sendEnabled     ?? null,
        requireApproval: override?.requireApproval ?? null,
        fineGrainedConfig: override ? overrideFg ?? null : null,
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
    readEnabled?:       boolean | null;
    sendEnabled?:       boolean | null;
    requireApproval?:   boolean | null;
    fineGrainedConfig?: ServiceFineGrained | null;
  };

  // Upsert override row
  db.insert(apiKeyPermissions)
    .values({ apiKeyId: keyId, service, readEnabled: null, sendEnabled: null, requireApproval: null, fineGrainedConfig: null })
    .onConflictDoNothing()
    .run();

  const updates: Partial<typeof apiKeyPermissions.$inferInsert> = {};
  if ('readEnabled'       in body) updates.readEnabled       = body.readEnabled       ?? null;
  if ('sendEnabled'       in body) updates.sendEnabled       = body.sendEnabled       ?? null;
  if ('requireApproval'   in body) updates.requireApproval   = body.requireApproval   ?? null;
  if ('fineGrainedConfig' in body) {
    updates.fineGrainedConfig = body.fineGrainedConfig != null ? JSON.stringify(body.fineGrainedConfig) : null;
  }

  db.update(apiKeyPermissions)
    .set(updates)
    .where(and(eq(apiKeyPermissions.apiKeyId, keyId), eq(apiKeyPermissions.service, service)))
    .run();

  res.json({ success: true });
});

// ── Utility: resolve effective fine-grained config for an actor ───────────────
// Exported so outbox and message routes can use it for enforcement.

export function resolveEffectiveFineGrained(
  service: string,
  apiKeyId: number | null | undefined,
): ServiceFineGrained | null {
  const db = getDb();
  const global = db.select().from(permissions).where(eq(permissions.service, service)).get();
  const globalFg = parseFineGrained(global?.fineGrainedConfig);

  if (!apiKeyId) return globalFg;

  const override = db.select().from(apiKeyPermissions)
    .where(and(eq(apiKeyPermissions.apiKeyId, apiKeyId), eq(apiKeyPermissions.service, service)))
    .get();

  if (!override) return globalFg;

  // If the key has an explicit fine_grained_config (even null stored explicitly via update),
  // check: null in DB after explicit update means "cleared/inherit from global".
  // We distinguish "row exists with null" from "row doesn't exist" only through the row's presence.
  const overrideFg = parseFineGrained(override.fineGrainedConfig);
  return overrideFg ?? globalFg;
}

export default router;
