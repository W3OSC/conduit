/**
 * In-process rate limiting for the Telegram auth flow.
 *
 * Telegram enforces a resend window per phone number (auth.SentCode.timeout)
 * and answers abuse with FLOOD_WAIT_N. We mirror both locally so repeated
 * "Send Code" clicks never reach Telegram's API — they get an immediate 429
 * with a retryAfter the UI can count down from.
 *
 * Kept separate from the router so the logic is unit-testable without
 * mocking GramJS.
 */

export type CooldownReason = 'resend' | 'flood';

interface Cooldown {
  phone: string;
  until: number; // epoch ms
  reason: CooldownReason;
}

let cooldown: Cooldown | null = null;

/** Seconds to wait before `phone` may request another code, or 0 if clear. */
export function cooldownRemaining(phone: string, now = Date.now()): { seconds: number; reason: CooldownReason | null } {
  if (!cooldown || cooldown.phone !== phone || now >= cooldown.until) {
    return { seconds: 0, reason: null };
  }
  return { seconds: Math.ceil((cooldown.until - now) / 1000), reason: cooldown.reason };
}

/** Record that a code was sent (or that Telegram flood-limited us). */
export function noteCooldown(phone: string, seconds: number, reason: CooldownReason, now = Date.now()): void {
  cooldown = { phone, until: now + seconds * 1000, reason };
}

export function clearCooldown(): void {
  cooldown = null;
}

/**
 * Extract the wait from a GramJS FloodWaitError (or any error carrying a
 * FLOOD_WAIT). Returns null when the error is not flood-related.
 */
export function floodWaitSeconds(e: unknown): number | null {
  const direct = (e as { seconds?: unknown })?.seconds;
  if (typeof direct === 'number' && direct > 0) return direct;
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/FLOOD_WAIT_(\d+)/) ?? msg.match(/wait of (\d+) seconds/i);
  return m ? Number(m[1]) : null;
}

/** User-facing message for a 429 response. */
export function cooldownMessage(reason: CooldownReason, seconds: number): string {
  return reason === 'flood'
    ? `Telegram is rate limiting code requests for this number. Try again in ${seconds}s.`
    : `A code was already sent. You can request another in ${seconds}s.`;
}
