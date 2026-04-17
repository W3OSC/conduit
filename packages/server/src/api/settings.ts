import { Router } from 'express';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';

const router = Router();

/**
 * Keys that are explicitly allowed to be read/written via the generic settings endpoint.
 * All sensitive keys (credentials, auth config, AI secrets) are managed through their
 * own dedicated endpoints and must never be exposed or overwritten here.
 */
const SETTINGS_WHITELIST = new Set([
  'appName',
  'apiPort',
  'uiPort',
  'incrementalIntervalMinutes',
  'security.blockPrivateIpSsrf',
  'security.sshStrictHostKeyChecking',
  'security.knownHosts',
]);

/**
 * Key prefixes that are always excluded from the GET /settings response,
 * regardless of whitelist, to prevent accidental credential exposure.
 */
const SENSITIVE_PREFIXES = ['credentials.', 'ui.auth', 'ai.gatewayToken'];

function isSensitive(key: string): boolean {
  return SENSITIVE_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix));
}

function isAllowed(key: string): boolean {
  return SETTINGS_WHITELIST.has(key);
}

router.get('/', optionalAuth, (req, res) => {
  const db = getDb();
  const rows = db.select().from(settings).all();
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    // Never expose sensitive keys through this endpoint
    if (isSensitive(row.key)) continue;
    try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
  }
  res.json(result);
});

router.put('/', optionalAuth, (req, res) => {
  const db = getDb();
  const updates = req.body as Record<string, unknown>;
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    // Block writes to sensitive keys or keys not on the whitelist
    if (isSensitive(key) || !isAllowed(key)) {
      rejected.push(key);
      continue;
    }
    db.insert(settings)
      .values({ key, value: JSON.stringify(value), updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: new Date().toISOString() } })
      .run();
  }

  // Return updated safe settings (filter sensitive keys from response too)
  const rows = db.select().from(settings).all();
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    if (isSensitive(row.key)) continue;
    try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
  }

  if (rejected.length > 0) {
    return res.status(207).json({ settings: result, rejected, warning: `The following keys are not writable via this endpoint: ${rejected.join(', ')}` });
  }

  res.json(result);
});

export { SETTINGS_WHITELIST, isSensitive };
export default router;
