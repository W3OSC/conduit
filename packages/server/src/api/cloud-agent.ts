/**
 * /api/cloud-agent — runtime configuration for the cloud-agent bridge
 * (cloud/agent.ts): the outbound WebSocket that connects this Conduit to a
 * remote orchestrator speaking the agent protocol (e.g. a hosted Meridian).
 *
 * Config precedence lives in cloud/config.ts: when CLOUD_AGENT_URL/TOKEN are
 * set in the environment the bridge is env-managed and writes here are
 * rejected with 409 — the API/UI then act as a read-only status surface.
 *
 * The device token is a credential: writes are uiOnlyAuth (no API-key access,
 * same posture as /credentials), it is stored on the settings sensitive list,
 * and no GET ever returns it — only `tokenSet`.
 */

import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { optionalAuth, uiOnlyAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { CLOUD_AGENT_SETTING_KEYS, isEnvManaged, readCloudAgentSettings } from '../cloud/config.js';
import { getCloudAgentStatus, restartCloudAgent, stopCloudAgent } from '../cloud/agent.js';

const router = Router();

function writeSetting(key: string, value: unknown): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(settings)
    .values({ key, value: JSON.stringify(value), updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: now } })
    .run();
}

function deleteSetting(key: string): void {
  getDb().delete(settings).where(eq(settings.key, key)).run();
}

/**
 * Runtime status + the stored (non-secret) settings fields. While the bridge
 * is off or disabled, getCloudAgentStatus has no runtime to report url/owner
 * from — the stored values fill those in so the UI can render the saved form.
 */
function statusBody(): Record<string, unknown> {
  const status = getCloudAgentStatus();
  if (status.envManaged) {
    // Env-managed instances necessarily hold a token (partial env config
    // keeps the bridge off and logs; the UI just shows read-only status).
    return { ...status, tokenSet: true, enabled: status.configured };
  }
  const stored = readCloudAgentSettings();
  return {
    ...status,
    url: status.url ?? stored.url,
    ownerEmail: status.ownerEmail ?? stored.ownerEmail,
    enabled: stored.enabled,
    // Whether a PUT may omit `token` (keep the stored one).
    tokenSet: Boolean(stored.token),
  };
}

/** Status — never includes the token. */
router.get('/', optionalAuth, (_req, res) => {
  res.json(statusBody());
});

/**
 * Create/update the bridge config and hot-(re)connect. `token` may be omitted
 * on update to keep the stored one. `enabled:false` stores the config but
 * keeps the bridge off (same semantics as CLOUD_AGENT_ENABLED=0).
 */
router.put('/', uiOnlyAuth, (req, res) => {
  if (isEnvManaged()) {
    res.status(409).json({
      error:
        'The cloud agent is managed by environment variables (CLOUD_AGENT_URL/CLOUD_AGENT_TOKEN) — ' +
        'unset them to configure it at runtime.',
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const ownerEmail = typeof body.ownerEmail === 'string' ? body.ownerEmail.trim() : undefined;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;

  if (!url || !/^wss?:\/\//i.test(url)) {
    res.status(400).json({ error: 'url is required and must start with ws:// or wss://' });
    return;
  }
  if (!token && !readCloudAgentSettings().token) {
    res.status(400).json({ error: 'token is required (none is stored yet)' });
    return;
  }

  writeSetting(CLOUD_AGENT_SETTING_KEYS.url, url);
  if (token) writeSetting(CLOUD_AGENT_SETTING_KEYS.token, token);
  if (ownerEmail !== undefined) writeSetting(CLOUD_AGENT_SETTING_KEYS.ownerEmail, ownerEmail);
  if (enabled !== undefined) writeSetting(CLOUD_AGENT_SETTING_KEYS.enabled, enabled);

  writeAuditLog('cloud_agent.configure', (req as AuthedRequest).actor ?? 'ui', {
    detail: { url, ownerEmail: ownerEmail ?? null, enabled: enabled ?? true, tokenReplaced: Boolean(token) },
  });

  restartCloudAgent();
  res.json(statusBody());
});

/** Clear the stored config and disconnect. */
router.delete('/', uiOnlyAuth, (req, res) => {
  if (isEnvManaged()) {
    res.status(409).json({
      error: 'The cloud agent is managed by environment variables — unset them instead.',
    });
    return;
  }

  for (const key of Object.values(CLOUD_AGENT_SETTING_KEYS)) deleteSetting(key);
  stopCloudAgent();

  writeAuditLog('cloud_agent.clear', (req as AuthedRequest).actor ?? 'ui', {});

  res.json(statusBody());
});

export default router;
