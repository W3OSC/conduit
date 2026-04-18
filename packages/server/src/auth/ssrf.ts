/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * When the server makes outbound HTTP/SSH requests based on user-supplied URLs
 * (AI webhook, Obsidian git remote), an attacker who can control those URLs
 * could reach internal network services.
 *
 * Policy (configurable in Settings → Security):
 *  - `security.blockPrivateIpSsrf` (default: false)
 *    Block URLs that resolve to known private/loopback IP ranges.
 *    Non-IP hostnames (e.g. Docker service names like "openclaw") are allowed
 *    since they're common in legitimate local setups.
 *
 * Note: This provides defence-in-depth, not a complete SSRF firewall — DNS
 * rebinding attacks are not mitigated here. For full protection, run Conduit
 * behind a network egress filter.
 */

import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// ── Private IP range detection ────────────────────────────────────────────────

// IPv4 CIDR ranges that should never be reached via user-supplied URLs
const PRIVATE_V4_PATTERNS: RegExp[] = [
  /^127\./,             // loopback
  /^10\./,              // RFC 1918
  /^192\.168\./,        // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./,  // RFC 1918 172.16–172.31
  /^169\.254\./,        // link-local (APIPA)
  /^0\./,               // this network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT 100.64.0.0/10
];

// Literal hostnames that map to loopback / internal (caught before DNS resolution)
const PRIVATE_HOSTNAMES: Set<string> = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
]);

function isPrivateIp(host: string): boolean {
  // Strip IPv6 brackets
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;

  // IPv6 loopback / unspecified
  if (bare === '::1' || bare === '::' || bare === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped IPv6 (::ffff:10.x.x.x etc.)
  const v4mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return PRIVATE_V4_PATTERNS.some((re) => re.test(v4mapped[1]));

  return PRIVATE_V4_PATTERNS.some((re) => re.test(bare));
}

function isPrivateHostname(host: string): boolean {
  return PRIVATE_HOSTNAMES.has(host.toLowerCase());
}

// ── Settings helper ───────────────────────────────────────────────────────────

function getSetting(key: string): string | null {
  try {
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? row.value : null;
  } catch {
    return null;
  }
}

function isBlockPrivateIpEnabled(): boolean {
  const val = getSetting('security.blockPrivateIpSsrf');
  if (val === null) return false; // default: off
  try { return JSON.parse(val) !== false; } catch { return false; }
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface SsrfCheckResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a user-supplied HTTP(S) URL for potential SSRF.
 *
 * Rules:
 *  1. Must be a valid http:// or https:// URL.
 *  2. If `security.blockPrivateIpSsrf` is true (default), block URLs whose
 *     host is a known private IP address or loopback hostname.
 *  3. Non-IP hostnames (like Docker service names) are allowed through —
 *     the setting only blocks literal private IP addresses and localhost.
 */
export function validateWebhookUrl(rawUrl: string): SsrfCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'Invalid URL — must be a valid http:// or https:// URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use http:// or https://' };
  }

  if (isBlockPrivateIpEnabled()) {
    const host = parsed.hostname;

    if (isPrivateHostname(host)) {
      return {
        ok: false,
        error: `URL hostname "${host}" is a loopback address. Use your machine's network IP, or disable "Block private IP SSRF" in Settings → Security if you need to reach localhost.`,
      };
    }

    // Only block if it looks like a raw IP address (not a hostname)
    const looksLikeIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^\[/.test(host) || /^::/.test(host);
    if (looksLikeIp && isPrivateIp(host)) {
      return {
        ok: false,
        error: `URL resolves to a private IP address (${host}). If this is intentional (e.g. a local service), disable "Block private IP SSRF" in Settings → Security.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Validate a git remote URL (HTTPS or SSH) for potential SSRF.
 * SSH git URLs have a different format (git@host:repo) so we handle those separately.
 */
export function validateGitRemoteUrl(rawUrl: string): SsrfCheckResult {
  const trimmed = rawUrl.trim();

  // SSH git URL: git@github.com:user/repo or ssh://git@host/repo
  const sshGitMatch = trimmed.match(/^(?:ssh:\/\/)?(?:\w+@)?([^:/\s]+)[:/]/);
  if (sshGitMatch && !trimmed.startsWith('http')) {
    if (isBlockPrivateIpEnabled()) {
      const host = sshGitMatch[1];
      if (isPrivateHostname(host)) {
        return {
          ok: false,
          error: `Git remote hostname "${host}" is a loopback address. Disable "Block private IP SSRF" in Settings → Security if this is intentional.`,
        };
      }
      const looksLikeIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
      if (looksLikeIp && isPrivateIp(host)) {
        return {
          ok: false,
          error: `Git remote resolves to a private IP address (${host}). Disable "Block private IP SSRF" in Settings → Security if this is intentional.`,
        };
      }
    }
    return { ok: true };
  }

  // HTTPS git URL — reuse the webhook validator
  return validateWebhookUrl(trimmed);
}
