/**
 * Config for the AI runner — the piece of the cloud-agent bridge that serves
 * `kind:"ai"` jobs by shelling out to a local Claude Code CLI (cloud/ai.ts).
 *
 * Mirrors the cloud-agent bridge's settings-over-env model (cloud/config.ts):
 * each field resolves env-first, then the settings DB — so ops/docker installs
 * can keep using env vars while everyone else configures the runner in-app
 * (Settings → AI, /api/ai-runner). Env-managed fields are read-only at
 * runtime.
 *
 *   - bin:   CLOUD_AGENT_CLAUDE_BIN  → aiRunner.claudeBin   → "claude" (PATH)
 *   - token: CLAUDE_CODE_OAUTH_TOKEN → aiRunner.oauthToken  → none (the CLI
 *            rides the host user's own `claude /login` session instead)
 *   - enabled: aiRunner.enabled !== false (settings only — turning the whole
 *            bridge off already has CLOUD_AGENT_ENABLED)
 *
 * aiRunner.oauthToken is on the settings API's sensitive list and never
 * leaves the server; /api/ai-runner reports only `tokenSet`.
 */

import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';

/**
 * Where the self-updating container's build step installs the CLI
 * (docker/selfupdate/build.sh) — auto-discovered as the default bin when
 * DOCKER=true so a container works without any bin config at all.
 */
export const DOCKER_CLI_DEFAULT = '/data/claude-cli/node_modules/.bin/claude';

export const AI_RUNNER_SETTING_KEYS = {
  claudeBin: 'aiRunner.claudeBin',
  oauthToken: 'aiRunner.oauthToken',
  enabled: 'aiRunner.enabled',
} as const;

/** Injectable settings lookup — tests pass a stub, production uses the DB. */
export type SettingReader = (key: string) => unknown;

/**
 * Settings rows are JSON-encoded by the settings layer; tolerate raw strings
 * too. Swallows DB-not-initialized errors (unit tests exercise the resolvers
 * without a database) — an unreadable store just means "nothing stored".
 */
function dbReadSetting(key: string): unknown {
  try {
    const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  } catch {
    return undefined;
  }
}

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export type AiRunnerFieldSource = 'env' | 'settings' | 'default';

export interface ResolvedAiRunnerConfig {
  /** CLI binary to spawn ("claude" means: resolve off PATH). */
  bin: string;
  binSource: AiRunnerFieldSource;
  /** Credential injected as CLAUDE_CODE_OAUTH_TOKEN into spawned CLIs; null = ride the host login. */
  token: string | null;
  tokenSource: AiRunnerFieldSource;
  /** `aiRunner.enabled === false` is the only off state; absent ⇒ enabled. */
  enabled: boolean;
}

export function resolveAiRunnerConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: SettingReader = dbReadSetting,
): ResolvedAiRunnerConfig {
  const envBin = env['CLOUD_AGENT_CLAUDE_BIN']?.trim() || '';
  const storedBin = asTrimmedString(read(AI_RUNNER_SETTING_KEYS.claudeBin));
  const envToken = env['CLAUDE_CODE_OAUTH_TOKEN']?.trim() || '';
  const storedToken = asTrimmedString(read(AI_RUNNER_SETTING_KEYS.oauthToken));
  const dockerDefault =
    env['DOCKER'] === 'true' && fs.existsSync(DOCKER_CLI_DEFAULT) ? DOCKER_CLI_DEFAULT : '';

  return {
    bin: envBin || storedBin || dockerDefault || 'claude',
    binSource: envBin ? 'env' : storedBin ? 'settings' : 'default',
    token: envToken || storedToken || null,
    tokenSource: envToken ? 'env' : storedToken ? 'settings' : 'default',
    enabled: read(AI_RUNNER_SETTING_KEYS.enabled) !== false,
  };
}
