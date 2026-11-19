/**
 * /api/ai-runner — runtime configuration for the AI runner (cloud/ai.ts):
 * the part of the cloud-agent bridge that serves `kind:"ai"` jobs for a
 * connected orchestrator by shelling out to a local Claude Code CLI.
 *
 * Settings-over-env (cloud/ai-config.ts): each field is env-managed when its
 * env var is set (CLOUD_AGENT_CLAUDE_BIN / CLAUDE_CODE_OAUTH_TOKEN) and the
 * corresponding write here is rejected with 409. The stored token is a
 * credential: writes are uiOnlyAuth, it lives on the settings sensitive
 * list, and no GET ever returns it — only `tokenSet`.
 *
 * Config changes hot-restart the bridge so `hello.capabilities` re-advertises
 * (or stops advertising) `ai` without a process restart.
 */

import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { optionalAuth, uiOnlyAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { AI_RUNNER_SETTING_KEYS, resolveAiRunnerConfig } from '../cloud/ai-config.js';
import { executeAiJob, probeClaudeVersion, type AiJobResultErr } from '../cloud/ai.js';
import { restartCloudAgent } from '../cloud/agent.js';

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
 * Status — never includes the token. `cliVersion` is probed live (2 s budget)
 * so the UI reflects an install/uninstall without a server restart.
 */
async function statusBody(): Promise<Record<string, unknown>> {
  const cfg = resolveAiRunnerConfig();
  const cliVersion = await probeClaudeVersion(cfg.bin);
  return {
    enabled: cfg.enabled,
    bin: cfg.bin,
    binSource: cfg.binSource,
    tokenSet: cfg.token !== null,
    tokenSource: cfg.tokenSource,
    cliAvailable: cliVersion !== null,
    cliVersion,
  };
}

router.get('/', optionalAuth, async (_req, res) => {
  res.json(await statusBody());
});

/**
 * Update any subset of {token, claudeBin, enabled}. Empty-string token or
 * claudeBin clears that stored field (fall back to host login / PATH).
 */
router.put('/', uiOnlyAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body.token === 'string' ? body.token.trim() : undefined;
  const claudeBin = typeof body.claudeBin === 'string' ? body.claudeBin.trim() : undefined;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;

  if (token !== undefined && process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    res.status(409).json({
      error: 'The runner token is managed by the CLAUDE_CODE_OAUTH_TOKEN environment variable — unset it to configure a token at runtime.',
    });
    return;
  }
  if (claudeBin !== undefined && process.env.CLOUD_AGENT_CLAUDE_BIN?.trim()) {
    res.status(409).json({
      error: 'The CLI path is managed by the CLOUD_AGENT_CLAUDE_BIN environment variable — unset it to configure a path at runtime.',
    });
    return;
  }

  if (token !== undefined) {
    if (token) writeSetting(AI_RUNNER_SETTING_KEYS.oauthToken, token);
    else deleteSetting(AI_RUNNER_SETTING_KEYS.oauthToken);
  }
  if (claudeBin !== undefined) {
    if (claudeBin) writeSetting(AI_RUNNER_SETTING_KEYS.claudeBin, claudeBin);
    else deleteSetting(AI_RUNNER_SETTING_KEYS.claudeBin);
  }
  if (enabled !== undefined) writeSetting(AI_RUNNER_SETTING_KEYS.enabled, enabled);

  writeAuditLog('ai_runner.configure', (req as AuthedRequest).actor ?? 'ui', {
    detail: {
      tokenReplaced: Boolean(token),
      tokenCleared: token === '',
      claudeBin: claudeBin || null,
      enabled: enabled ?? null,
    },
  });

  // Re-probe + re-advertise `ai` on the live bridge connection (no-op when
  // the bridge isn't configured).
  restartCloudAgent();
  res.json(await statusBody());
});

/** Clear all stored runner config (env-managed fields are unaffected). */
router.delete('/', uiOnlyAuth, async (req, res) => {
  for (const key of Object.values(AI_RUNNER_SETTING_KEYS)) deleteSetting(key);
  writeAuditLog('ai_runner.clear', (req as AuthedRequest).actor ?? 'ui', {});
  restartCloudAgent();
  res.json(await statusBody());
});

/**
 * End-to-end auth test: run one minimal real CLI call through the exact same
 * path a cloud `ai` job takes (tool-less chat mode, tiny prompt). This is the
 * only reliable way to distinguish "CLI installed" from "CLI can actually
 * serve jobs" — a --version probe can't see login state.
 */
router.post('/test', uiOnlyAuth, async (_req, res) => {
  const cfg = resolveAiRunnerConfig();
  const cliVersion = await probeClaudeVersion(cfg.bin);
  if (cliVersion === null) {
    res.json({ ok: false, errorKind: 'cli_missing', error: `Claude Code CLI not found (${cfg.bin})` });
    return;
  }
  const result = await executeAiJob({
    jobId: 'ui-selftest',
    mode: 'chat',
    model: 'haiku',
    prompt: 'Reply with the single word: ok',
    timeoutSecs: 60,
  });
  if (result.ok) {
    res.json({ ok: true, cliVersion });
    return;
  }
  const err = result as AiJobResultErr;
  res.json({ ok: false, errorKind: err.body.errorKind, error: err.body.error, cliVersion });
});

export default router;
