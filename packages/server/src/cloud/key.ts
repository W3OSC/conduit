/**
 * Dedicated API key the cloud-agent job executor uses to call back into this
 * same server's own REST API (localhost, over HTTP — see jobs.ts), so `http`
 * jobs ride the existing X-API-Key auth/permission path unchanged.
 */

import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { hashKey } from '../auth/middleware.js';

export const CLOUD_AGENT_KEY_NAME = 'cloud-agent';

/**
 * Mint (or re-mint) the "cloud-agent" API key and return its raw value.
 *
 * api_keys stores only a SHA-256 hash (auth/middleware.ts `hashKey`), by
 * design — there is no column a raw key could be recovered from. So a
 * "cloud-agent" row left over from a previous process start is unusable:
 * nothing in this process remembers its raw value. Any such row is revoked
 * and replaced with a fresh one on every boot; the raw key this function
 * returns lives only in the caller's process memory for the life of the
 * process, exactly like every other minted key before it is first read back.
 */
export function ensureCloudAgentApiKey(): string {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db.select().from(apiKeys).where(eq(apiKeys.name, CLOUD_AGENT_KEY_NAME)).all();
  for (const row of existing) {
    if (!row.revokedAt) {
      db.update(apiKeys).set({ revokedAt: now }).where(eq(apiKeys.id, row.id)).run();
    }
  }

  const rawKey = `sk-arb-${randomBytes(24).toString('hex')}`;
  db.insert(apiKeys)
    .values({
      name: CLOUD_AGENT_KEY_NAME,
      keyHash: hashKey(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      createdAt: now,
    })
    .run();

  return rawKey;
}
