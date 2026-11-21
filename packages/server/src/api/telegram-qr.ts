/**
 * Telegram QR-code login — the "Link Desktop Device" flow.
 *
 * Sidesteps login-code delivery entirely (no app code, no SMS): the server
 * exports a login token, the UI renders it as a QR code, and the user scans
 * it from a phone that is already signed in (Settings → Devices → Link
 * Desktop Device). 2FA still applies after the scan.
 *
 * POST /api/connections/telegram/auth/qr/start    { apiId, apiHash }
 * GET  /api/connections/telegram/auth/qr/status   → { status, token?, hint?, error? }
 * POST /api/connections/telegram/auth/qr/password { password }
 * POST /api/connections/telegram/auth/qr/cancel
 *
 * GramJS's signInUserWithQrCode drives the MTProto side (token rotation,
 * UpdateLoginToken, DC migration, SESSION_PASSWORD_NEEDED). It runs as a
 * long-lived background promise; the HTTP surface is a small state machine
 * the UI polls.
 */

import { Router } from 'express';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { optionalAuth } from '../auth/middleware.js';
import { getCreds, setCreds, type TelegramCreds } from './credentials.js';
import { getConnectionManager } from '../connections/manager.js';

const router = Router();

type QrStatus = 'waiting' | 'password' | 'done' | 'error';

interface QrLoginState {
  client: TelegramClient;
  status: QrStatus;
  /** base64url token for the tg://login?token= QR payload */
  token: string | null;
  /** 2FA hint from Telegram, shown next to the password field */
  hint: string;
  /** set when status === 'error'; also used for a wrong-password retry note */
  error: string;
  passwordResolve: ((pw: string) => void) | null;
  startedAt: number;
}

let qr: QrLoginState | null = null;
const QR_TTL_MS = 5 * 60 * 1000; // matches the OTP flow's pending TTL

async function clearQr(): Promise<void> {
  const prev = qr;
  qr = null;
  if (!prev) return;
  // Unblock a parked password callback so the background promise can exit.
  prev.passwordResolve?.('');
  await Promise.race([
    prev.client.disconnect().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function qrExpired(): boolean {
  return !!qr && (Date.now() - qr.startedAt) > QR_TTL_MS;
}

router.post('/qr/start', optionalAuth, async (req, res) => {
  const body = req.body as { apiId?: string; apiHash?: string };
  const saved = (getCreds('telegram') || {}) as TelegramCreds;
  const apiId = body.apiId || saved.apiId;
  const apiHash = body.apiHash || saved.apiHash;

  if (!apiId || !apiHash) {
    return res.status(400).json({ error: 'apiId and apiHash are required' });
  }

  await clearQr();

  try {
    const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, {
      connectionRetries: 3,
    });
    client.setLogLevel(LogLevel.NONE);
    await client.connect();

    const state: QrLoginState = {
      client,
      status: 'waiting',
      token: null,
      hint: '',
      error: '',
      passwordResolve: null,
      startedAt: Date.now(),
    };
    qr = state;

    // Persist the API credentials like send-code does, so a reload keeps them.
    setCreds('telegram', { ...saved, apiId, apiHash });

    // Long-lived: resolves when the QR is scanned (and 2FA passes) or fails.
    client.signInUserWithQrCode({ apiId: Number(apiId), apiHash }, {
      qrCode: async (code) => {
        // Called on every token rotation (~30s). Buffer → base64url for the
        // tg://login?token= payload the official clients expect.
        state.token = code.token.toString('base64url');
      },
      password: async (hint) => {
        state.status = 'password';
        state.hint = hint ?? '';
        state.token = null; // the QR is consumed once scanned — never re-show it
        return await new Promise<string>((resolve) => { state.passwordResolve = resolve; });
      },
      onError: async (err: Error) => {
        if (qr !== state) return true; // flow was cancelled/replaced — stop
        const msg = err.message ?? String(err);
        if (msg.includes('PASSWORD_HASH_INVALID') || msg.includes('Password is empty')) {
          // Wrong 2FA password: stay in the loop, let the user retry.
          state.status = 'password';
          state.error = 'Incorrect password';
          return false;
        }
        state.status = 'error';
        state.error = msg;
        return true; // stop the GramJS auth loop
      },
    }).then(async () => {
      if (qr !== state) return;
      const sessionString = (client.session as StringSession).save();
      const creds = (getCreds('telegram') || {}) as TelegramCreds;
      setCreds('telegram', { ...creds, apiId, apiHash, sessionString });
      state.status = 'done';
      state.token = null;
      await getConnectionManager().connectTelegram();
      console.log('[telegram-auth] QR login complete — session stored');
    }).catch((e: unknown) => {
      if (qr !== state) return;
      if (state.status !== 'error') {
        state.status = 'error';
        state.error = e instanceof Error ? e.message : String(e);
      }
      console.error('[telegram-auth] QR login failed:', e);
    });

    res.json({ success: true });
  } catch (e) {
    await clearQr();
    console.error('[telegram-auth] QR start failed:', e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/qr/status', optionalAuth, async (_req, res) => {
  if (qr && qrExpired() && qr.status !== 'done') {
    await clearQr();
  }
  if (!qr) {
    return res.json({ status: 'idle' });
  }
  res.json({
    status: qr.status,
    token: qr.status === 'waiting' ? qr.token : null,
    hint: qr.status === 'password' ? qr.hint : undefined,
    error: qr.error || undefined,
  });
});

router.post('/qr/password', optionalAuth, (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password) return res.status(400).json({ error: 'password is required' });
  if (!qr || qr.status !== 'password' || !qr.passwordResolve) {
    return res.status(409).json({ error: 'No password prompt pending' });
  }
  const resolve = qr.passwordResolve;
  qr.passwordResolve = null;
  qr.error = '';
  qr.status = 'waiting'; // checking; flips to done / back to password / error
  resolve(password);
  res.json({ success: true });
});

router.post('/qr/cancel', optionalAuth, async (_req, res) => {
  await clearQr();
  res.json({ success: true });
});

export default router;
