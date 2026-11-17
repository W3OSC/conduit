/**
 * Reconnect backoff schedule for the cloud-agent socket — same shape as
 * ConnectionManager's reconnect supervisor (connections/manager.ts
 * superviseConnections, ~346-389): exponential, 1 minute base, doubling,
 * capped at 16 minutes.
 */

export const BACKOFF_BASE_MS = 60_000; // 1 minute
export const BACKOFF_MAX_MS = 16 * 60_000; // 16 minutes

/** Uptime a connection needs before a subsequent drop resets backoff to attempt 1. */
export const STABLE_CONNECTION_MS = 60_000;

/**
 * Delay before the Nth reconnect attempt (1-based):
 * 1 → 1min, 2 → 2min, 3 → 4min, 4 → 8min, 5+ → 16min (capped).
 */
export function nextBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
}
