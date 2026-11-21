/**
 * Telegram OTP + optional 2FA authentication flow.
 *
 * POST /api/connections/telegram/auth/send-code
 *   Body: { apiId, apiHash, phone }
 *
 * POST /api/connections/telegram/auth/sign-in
 *   Body: { code }
 *   Returns { success: true } on full auth, or
 *           { success: false, passwordRequired: true } when 2FA is enabled.
 *
 * POST /api/connections/telegram/auth/check-password
 *   Body: { password }
 *   Completes the 2FA step after sign-in indicated passwordRequired.
 */

import { Router } from 'express';
import { TelegramClient, Api, password as PasswordHelper } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { optionalAuth } from '../auth/middleware.js';
import { getCreds, setCreds, type TelegramCreds } from './credentials.js';
import { getConnectionManager } from '../connections/manager.js';
import {
  cooldownRemaining, noteCooldown, floodWaitSeconds, cooldownMessage,
} from './telegram-auth-rate-limit.js';

const router = Router();

// ── Auth flow state ───────────────────────────────────────────────────────────
// Module-level state for the Telegram multi-step auth flow.
// A simple lock prevents concurrent /send-code requests from corrupting the flow.

interface PendingTelegramAuth {
  client: TelegramClient;
  phoneCodeHash: string;
  phone: string;
  lockedAt: number; // timestamp — auto-expires after 5 minutes
}

let pendingAuth: PendingTelegramAuth | null = null;
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function clearPending(): Promise<void> {
  const prev = pendingAuth;
  // Drop the reference first: a client stuck in GramJS's ping/reconnect loop can
  // make disconnect() hang, and we must never let that block the next request.
  pendingAuth = null;
  if (!prev) return;
  await Promise.race([
    prev.client.disconnect().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function isExpired(): boolean {
  return !!pendingAuth && (Date.now() - pendingAuth.lockedAt) > PENDING_TTL_MS;
}

// ── Send OTP code ─────────────────────────────────────────────────────────────

/** Default resend window when Telegram's SentCode carries no timeout. */
const DEFAULT_RESEND_SECONDS = 60;

/** Map Telegram's SentCodeType class to where the user should look. */
function deliveryTarget(typeName: string): 'app' | 'sms' | 'call' | 'email' | 'unknown' {
  if (typeName.includes('App')) return 'app';
  if (typeName.includes('Sms')) return 'sms';
  if (typeName.includes('Call')) return 'call';
  if (typeName.includes('Email')) return 'email';
  return 'unknown';
}

/**
 * The escalation Telegram offers after the current delivery (auth.SentCode's
 * nextType — what auth.ResendCode will switch to), or null when there is none.
 * The initial channel is always Telegram's choice; third-party apps can only
 * walk this chain, never request SMS/email outright.
 */
function nextDelivery(result: { nextType?: unknown }): 'app' | 'sms' | 'call' | 'email' | null {
  const name = (result.nextType as { className?: string } | undefined)?.className;
  if (!name) return null;
  const via = deliveryTarget(name);
  return via === 'unknown' ? null : via;
}

/**
 * Raw auth.SendCode so the response surfaces the delivery type and resend
 * timeout — the GramJS sendCode helper discards both. AUTH_RESTART is a
 * Telegram-mandated single retry, same as the helper performs internally.
 */
async function invokeSendCode(client: TelegramClient, apiId: number, apiHash: string, phone: string) {
  const makeReq = () => new Api.auth.SendCode({
    phoneNumber: phone,
    apiId,
    apiHash,
    settings: new Api.CodeSettings({}),
  });
  try {
    return await client.invoke(makeReq());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('AUTH_RESTART')) throw e;
    return await client.invoke(makeReq());
  }
}

router.post('/send-code', optionalAuth, async (req, res) => {
  const { apiId, apiHash, phone } = req.body as { apiId?: string; apiHash?: string; phone?: string };

  if (!apiId || !apiHash || !phone) {
    return res.status(400).json({ error: 'apiId, apiHash, and phone are required' });
  }

  // Local cooldown: inside Telegram's resend window (or a FLOOD_WAIT we
  // already hit), answer 429 ourselves instead of spamming their API.
  const cd = cooldownRemaining(phone);
  if (cd.seconds > 0 && cd.reason) {
    return res.status(429).json({ error: cooldownMessage(cd.reason, cd.seconds), retryAfter: cd.seconds });
  }

  // Clear any stale or expired pending session
  if (pendingAuth && isExpired()) await clearPending();
  if (pendingAuth) await clearPending();

  try {
    const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, {
      connectionRetries: 3,
    });
    // The unauthenticated auth client's background ping loop reliably times out on
    // some networks and would otherwise spam `Error: TIMEOUT` to the server console.
    // Silence it — the send-code / sign-in RPCs surface their own errors regardless.
    client.setLogLevel(LogLevel.NONE);
    await client.connect();

    console.log(`[telegram-auth] sending code to ${phone} (apiId=${apiId})`);
    const result = await invokeSendCode(client, Number(apiId), apiHash, phone);
    if (!('phoneCodeHash' in result) || !result.phoneCodeHash) {
      // auth.SentCodeSuccess — only possible with future-auth logout tokens,
      // which a fresh StringSession never carries.
      throw new Error(`Unexpected sendCode response: ${result.className}`);
    }

    const typeName = (result.type as { className?: string } | undefined)?.className ?? 'unknown';
    const sentTo = deliveryTarget(typeName);
    const resendIn = typeof result.timeout === 'number' && result.timeout > 0
      ? result.timeout
      : DEFAULT_RESEND_SECONDS;
    console.log(
      `[telegram-auth] sendCode ok — type=${typeName} ` +
        `nextType=${(result.nextType as { className?: string } | undefined)?.className ?? 'none'} ` +
        `timeout=${result.timeout ?? 'n/a'} hash=set`
    );
    pendingAuth = { client, phoneCodeHash: result.phoneCodeHash, phone, lockedAt: Date.now() };
    noteCooldown(phone, resendIn, 'resend');

    // Persist credentials immediately so the flow survives a page reload
    const existing = (getCreds('telegram') || {}) as TelegramCreds;
    setCreds('telegram', { ...existing, apiId, apiHash, phone });

    res.json({ success: true, sentTo, resendIn, nextVia: nextDelivery(result) });
  } catch (e) {
    console.error('[telegram-auth] sendCode failed:', e);

    const floodSeconds = floodWaitSeconds(e);
    if (floodSeconds) {
      // Remember the flood window so retries 429 locally until it passes.
      noteCooldown(phone, floodSeconds, 'flood');
      return res.status(429).json({ error: cooldownMessage('flood', floodSeconds), retryAfter: floodSeconds });
    }

    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('PHONE_NUMBER_INVALID')) {
      return res.status(400).json({
        error: 'Telegram rejected this phone number. Use full international format, e.g. +15551234567.',
      });
    }

    res.status(500).json({ error: msg });
  }
});

// ── Resend via the next delivery method ───────────────────────────────────────
//
// auth.ResendCode is Telegram's official "Didn't get the code?" escalation: it
// re-delivers the SAME login attempt via the SentCode.nextType channel
// (app → sms → call). It is the only way a third-party app can reach SMS —
// the initial channel is always Telegram's choice. 410 means the flow died
// and the UI must start over from /send-code.

router.post('/resend', optionalAuth, async (req, res) => {
  if (!pendingAuth || isExpired()) {
    await clearPending();
    return res.status(410).json({ error: 'The sign-in attempt expired — send a new code first.' });
  }

  const { client, phoneCodeHash, phone } = pendingAuth;

  const cd = cooldownRemaining(phone);
  if (cd.seconds > 0 && cd.reason) {
    return res.status(429).json({ error: cooldownMessage(cd.reason, cd.seconds), retryAfter: cd.seconds });
  }

  try {
    const result = await client.invoke(
      new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash })
    );
    if (!('phoneCodeHash' in result) || !result.phoneCodeHash) {
      throw new Error(`Unexpected resendCode response: ${result.className}`);
    }

    const typeName = (result.type as { className?: string } | undefined)?.className ?? 'unknown';
    const sentTo = deliveryTarget(typeName);
    const resendIn = typeof result.timeout === 'number' && result.timeout > 0
      ? result.timeout
      : DEFAULT_RESEND_SECONDS;
    console.log(
      `[telegram-auth] resendCode ok — type=${typeName} ` +
        `nextType=${(result.nextType as { className?: string } | undefined)?.className ?? 'none'} ` +
        `timeout=${result.timeout ?? 'n/a'}`
    );

    // Telegram may rotate the hash on resend; sign-in must use the fresh one.
    pendingAuth = { ...pendingAuth, phoneCodeHash: result.phoneCodeHash, lockedAt: Date.now() };
    noteCooldown(phone, resendIn, 'resend');

    res.json({ success: true, sentTo, resendIn, nextVia: nextDelivery(result) });
  } catch (e) {
    console.error('[telegram-auth] resendCode failed:', e);

    const floodSeconds = floodWaitSeconds(e);
    if (floodSeconds) {
      noteCooldown(phone, floodSeconds, 'flood');
      return res.status(429).json({ error: cooldownMessage('flood', floodSeconds), retryAfter: floodSeconds });
    }

    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('SEND_CODE_UNAVAILABLE')) {
      return res.status(400).json({
        error: 'Telegram has no alternative delivery method for this number — the code already sent is still valid.',
      });
    }
    if (msg.includes('PHONE_CODE_EXPIRED') || msg.includes('PHONE_CODE_HASH_EMPTY')) {
      await clearPending();
      return res.status(410).json({ error: 'The sign-in attempt expired — send a new code first.' });
    }

    res.status(500).json({ error: msg });
  }
});

// ── Sign in with OTP ──────────────────────────────────────────────────────────

router.post('/sign-in', optionalAuth, async (req, res) => {
  const { code } = req.body as { code?: string };

  if (!code) return res.status(400).json({ error: 'code is required' });
  if (!pendingAuth || isExpired()) {
    await clearPending();
    return res.status(400).json({ error: 'No pending authentication — call /send-code first' });
  }

  const { client: pendingClient, phoneCodeHash: pendingPhoneCodeHash } = pendingAuth;
  const creds = getCreds('telegram') as TelegramCreds | null;
  if (!creds?.phone) return res.status(400).json({ error: 'Phone not found — call /send-code first' });

  try {
    await pendingClient.invoke(
      new Api.auth.SignIn({
        phoneNumber: creds.phone,
        phoneCodeHash: pendingPhoneCodeHash,
        phoneCode: code,
      })
    );

    // No 2FA — full auth complete
    const sessionString = (pendingClient.session as StringSession).save();
    setCreds('telegram', { ...creds, sessionString });

    await clearPending();

    const manager = getConnectionManager();
    await manager.connectTelegram();

    res.json({ success: true, status: manager.getStatus('telegram') });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    // 2FA is enabled — keep the client alive for the password step
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      return res.json({ success: false, passwordRequired: true });
    }

    // Any other error — clean up
    await clearPending();
    res.status(500).json({ error: msg });
  }
});

// ── Check 2FA cloud password ──────────────────────────────────────────────────

router.post('/check-password', optionalAuth, async (req, res) => {
  const { password } = req.body as { password?: string };

  if (!password) return res.status(400).json({ error: 'password is required' });
  if (!pendingAuth || isExpired()) {
    await clearPending();
    return res.status(400).json({ error: 'No pending authentication — restart from /send-code' });
  }

  const { client: pendingClient } = pendingAuth;
  const creds = getCreds('telegram') as TelegramCreds | null;

  try {
    // Fetch the current password parameters (salt etc.) then compute the SRP proof
    const passwordInfo = await pendingClient.invoke(new Api.account.GetPassword());
    const checkResult = await PasswordHelper.computeCheck(passwordInfo, password);
    await pendingClient.invoke(new Api.auth.CheckPassword({ password: checkResult }));

    // 2FA accepted — serialise and persist session
    const sessionString = (pendingClient.session as StringSession).save();
    setCreds('telegram', { ...(creds || {}), sessionString } as TelegramCreds);

    await clearPending();

    const manager = getConnectionManager();
    await manager.connectTelegram();

    res.json({ success: true, status: manager.getStatus('telegram') });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Wrong password — keep client alive so they can retry
    if (msg.includes('PASSWORD_HASH_INVALID')) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    // Other error — clean up
    await clearPending();
    res.status(500).json({ error: msg });
  }
});

export default router;
