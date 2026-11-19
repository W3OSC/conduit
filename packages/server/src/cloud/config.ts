/**
 * Config for the cloud-agent WebSocket bridge — the outbound connection that
 * lets a remote orchestrator (any service implementing the agent protocol;
 * Meridian is the reference consumer, see auditware-crm docs/m5-home-agent.md
 * for the wire spec) route work into this Conduit instance.
 *
 * Two sources, resolved by resolveCloudAgentConfig():
 *   1. Environment (CLOUD_AGENT_URL/TOKEN/OWNER_EMAIL/ENABLED) — when any of
 *      URL/token is present in env the bridge is "env-managed": settings rows
 *      are ignored and the runtime API/UI are read-only. Ops/docker installs
 *      keep working exactly as before.
 *   2. Settings DB (cloudAgent.url/token/ownerEmail/enabled) — written by the
 *      dedicated /api/cloud-agent endpoint (api/cloud-agent.ts), hot-applied
 *      without a restart. cloudAgent.token is on the settings API's sensitive
 *      list and never leaves the server.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';

export interface CloudAgentConfig {
  /** wss:// (or ws://, for local testing) URL of the cloud agent endpoint. */
  url: string;
  /** Bearer device token minted by the orchestrator (e.g. Meridian Settings → Devices). */
  token: string;
  /**
   * Advisory only, sent in `hello` — the device row on the cloud side is the
   * source of truth for ownership. Falls back to '' when unset.
   */
  ownerEmail: string;
}

export type CloudAgentSource = 'env' | 'settings';

export interface ResolvedCloudAgentConfig {
  /** Connectable config, or null when the bridge should stay off. */
  config: CloudAgentConfig | null;
  /** Which store produced the decision (null = nothing configured anywhere). */
  source: CloudAgentSource | null;
  /** True when env vars own the config — the runtime API/UI must not write. */
  envManaged: boolean;
}

export const CLOUD_AGENT_SETTING_KEYS = {
  url: 'cloudAgent.url',
  token: 'cloudAgent.token',
  ownerEmail: 'cloudAgent.ownerEmail',
  enabled: 'cloudAgent.enabled',
} as const;

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return undefined;
}

/**
 * Load the cloud-agent config from `env`, or return null when the agent
 * should not start (not configured, or explicitly disabled).
 *
 * CLOUD_AGENT_URL and CLOUD_AGENT_TOKEN are a pair — setting only one is
 * almost always a mistake, so that case logs an error rather than silently
 * leaving the agent off the way "neither set" does.
 */
export function loadCloudAgentConfig(env: NodeJS.ProcessEnv = process.env): CloudAgentConfig | null {
  const url = env['CLOUD_AGENT_URL']?.trim() || '';
  const token = env['CLOUD_AGENT_TOKEN']?.trim() || '';
  const ownerEmail = env['CLOUD_AGENT_OWNER_EMAIL']?.trim() || '';
  const explicitEnabled = parseBool(env['CLOUD_AGENT_ENABLED']);

  const hasUrl = url.length > 0;
  const hasToken = token.length > 0;

  if (hasUrl !== hasToken) {
    console.error(
      `[cloud-agent] Partial configuration: CLOUD_AGENT_URL ${hasUrl ? 'is set' : 'is MISSING'}, ` +
        `CLOUD_AGENT_TOKEN ${hasToken ? 'is set' : 'is MISSING'}. Both are required together — ` +
        'the cloud agent will stay OFF until both are set. Mint a device token from the ' +
        'orchestrator (e.g. Meridian Settings → Devices) and set both env vars, or leave both unset.',
    );
    return null;
  }

  if (!hasUrl || !hasToken) return null; // neither set — quietly off, nothing to warn about

  const enabled = explicitEnabled ?? true; // default: enabled iff url+token present
  if (!enabled) {
    console.log('[cloud-agent] CLOUD_AGENT_ENABLED=0 — URL/token are set but the agent is disabled.');
    return null;
  }

  if (!ownerEmail) {
    console.warn(
      '[cloud-agent] CLOUD_AGENT_OWNER_EMAIL is not set — hello.ownerEmail will be sent as "" ' +
        '(this is advisory only; the cloud-side device row is authoritative for ownership).',
    );
  }

  return { url, token, ownerEmail };
}

/** Injectable settings lookup — tests pass a stub, production uses the DB. */
export type SettingReader = (key: string) => unknown;

/** Settings rows are JSON-encoded by the settings layer; tolerate raw strings too. */
function dbReadSetting(key: string): unknown {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The stored (settings-DB) bridge config, token included — internal to the
 * cloud-agent modules; API responses must go through the token-free status
 * shape in api/cloud-agent.ts instead.
 */
export function readCloudAgentSettings(read: SettingReader = dbReadSetting): {
  url: string | null;
  token: string | null;
  ownerEmail: string | null;
  /** `cloudAgent.enabled === false` is the only off state; absent ⇒ enabled. */
  enabled: boolean;
} {
  return {
    url: asTrimmedString(read(CLOUD_AGENT_SETTING_KEYS.url)) || null,
    token: asTrimmedString(read(CLOUD_AGENT_SETTING_KEYS.token)) || null,
    ownerEmail: asTrimmedString(read(CLOUD_AGENT_SETTING_KEYS.ownerEmail)) || null,
    enabled: read(CLOUD_AGENT_SETTING_KEYS.enabled) !== false,
  };
}

/** True when env owns the bridge config (even partially/disabled — env still wins). */
export function isEnvManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['CLOUD_AGENT_URL']?.trim() || env['CLOUD_AGENT_TOKEN']?.trim());
}

/**
 * Env first (managed, read-only at runtime), settings DB otherwise. Settings
 * mirror the env semantics: url+token required together, `enabled:false` is
 * an explicit off switch. `source:"settings"` is reported whenever any
 * settings config exists, even while disabled/partial — the status surface
 * needs to distinguish "configured but off" from "nothing stored".
 */
export function resolveCloudAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: SettingReader = dbReadSetting,
): ResolvedCloudAgentConfig {
  if (isEnvManaged(env)) {
    return { config: loadCloudAgentConfig(env), source: 'env', envManaged: true };
  }
  const stored = readCloudAgentSettings(read);
  const hasAny = Boolean(stored.url || stored.token);
  const config =
    stored.url && stored.token && stored.enabled
      ? { url: stored.url, token: stored.token, ownerEmail: stored.ownerEmail ?? '' }
      : null;
  return { config, source: hasAny ? 'settings' : null, envManaged: false };
}
