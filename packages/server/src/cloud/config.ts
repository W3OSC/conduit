/**
 * Config for the Meridian cloud-agent WebSocket bridge (M5 home-agent
 * protocol — see auditware-crm docs/m5-home-agent.md for the wire spec).
 *
 * Read once at startup (from startCloudAgent()) so a misconfigured
 * environment logs a single actionable warning instead of failing silently
 * inside the reconnect loop.
 */

export interface CloudAgentConfig {
  /** wss:// (or ws://, for local testing) URL of the cloud agent endpoint. */
  url: string;
  /** Bearer device token minted by Meridian Settings → Devices. */
  token: string;
  /**
   * Advisory only, sent in `hello` — the device row on the cloud side is the
   * source of truth for ownership. Falls back to '' when unset.
   */
  ownerEmail: string;
}

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
        'the cloud agent will stay OFF until both are set. Mint a device token from Meridian ' +
        'Settings → Devices and set both env vars, or leave both unset.',
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
