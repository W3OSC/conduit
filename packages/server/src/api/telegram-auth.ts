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
import { optionalAuth } from '../auth/middleware.js';
import { getCreds, setCreds, type TelegramCreds } from './credentials.js';
import { getConnectionManager } from '../connections/manager.js';

const router = Router();

// ── Auth flow state ───────────────────────────────────────────────────────────
// Module-level state for the Telegram multi-step auth flow.
// A simple lock prevents concurrent /send-code requests from corrupting the flow.

interface PendingTelegramAuth {
  client: TelegramClient;
  phoneCodeHash: string;
  lockedAt: number; // timestamp — auto-expires after 5 minutes
}

let pendingAuth: PendingTelegramAuth | null = null;
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function clearPending(): Promise<void> {
  if (pendingAuth) {
    await pendingAuth.client.disconnect().catch(() => {});
    pendingAuth = null;
  }
}

function isExpired(): boolean {
  return !!pendingAuth && (Date.now() - pendingAuth.lockedAt) > PENDING_TTL_MS;
}

// ── Send OTP code ─────────────────────────────────────────────────────────────

router.post('/send-code', optionalAuth, async (req, res) => {
  const { apiId, apiHash, phone } = req.body as { apiId?: string; apiHash?: string; phone?: string };

  if (!apiId || !apiHash || !phone) {
    return res.status(400).json({ error: 'apiId, apiHash, and phone are required' });
  }

  // Clear any stale or expired pending session
  if (pendingAuth && isExpired()) await clearPending();
  if (pendingAuth) await clearPending();

  try {
    const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, {
      connectionRetries: 3,
    });
    await client.connect();

    const result = await client.sendCode({ apiId: Number(apiId), apiHash }, phone);
    pendingAuth = { client, phoneCodeHash: result.phoneCodeHash, lockedAt: Date.now() };

    // Persist credentials immediately so the flow survives a page reload
    const existing = (getCreds('telegram') || {}) as TelegramCreds;
    setCreds('telegram', { ...existing, apiId, apiHash, phone });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
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
