/**
 * UI Auth — optional password + TOTP 2FA login for the browser UI.
 *
 * This is a single-user app. There is no username — just a password and
 * optionally a TOTP second factor.
 *
 * When login is disabled (default), all UI requests are treated as
 * authenticated (actor = 'ui'). When login is enabled, the UI must present a
 * valid session token (stored as a cookie / X-UI-Session header) on every
 * request, otherwise the server returns 401 and the client shows the login page.
 *
 * Config stored in settings table under the key 'ui.auth':
 * {
 *   enabled: boolean,
 *   passwordHash: string,      // bcrypt hash
 *   totpEnabled: boolean,
 *   sessionToken?: string,     // sha256 of the active session token (single session)
 *   sessionExpiry?: string,    // ISO date
 * }
 *
 * TOTP secret is held in an in-memory Map keyed by a setup nonce during
 * the setup flow and only written to DB after the user successfully verifies
 * a TOTP code. This prevents the secret from leaking if an attacker reads
 * the DB between /setup and /verify.
 *
 * Routes:
 *   GET  /api/ui-auth/status     → { enabled, totpEnabled, authenticated }
 *   POST /api/ui-auth/login      → { success, totpRequired } — step 1
 *   POST /api/ui-auth/login/totp → { success }               — step 2 (if 2FA enabled)
 *   POST /api/ui-auth/logout     → { success }
 *   GET  /api/ui-auth/config     → current config (no secrets)
 *   PUT  /api/ui-auth/config     → update password / enable / disable
 *   POST /api/ui-auth/totp/setup → generates a new TOTP secret, returns QR data
 *   POST /api/ui-auth/totp/verify → verifies a code and enables 2FA
 *   DELETE /api/ui-auth/totp    → disables 2FA (requires password)
 */

import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { OTP } from 'otplib/class';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Request, Response, NextFunction } from 'express';

const router = Router();
const otp = new OTP({ strategy: 'totp' });
const SETTINGS_KEY = 'ui.auth';
const SESSION_COOKIE_NAME = 'conduit-session';
const TOTP_INTERMEDIATE_COOKIE = 'conduit-totp-step';
const SESSION_DURATION_HOURS = 24 * 7; // 1 week
const TOTP_STEP_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ── In-memory TOTP setup store ────────────────────────────────────────────────
// Holds pending TOTP secrets during setup — never written to DB until verified.
// Key: setup nonce (sent to client), Value: { secret, expiresAt }

interface PendingTotpSetup {
  secret: string;
  expiresAt: number;
}

const pendingTotpSetups = new Map<string, PendingTotpSetup>();

function cleanupExpiredSetups(): void {
  const now = Date.now();
  for (const [nonce, entry] of pendingTotpSetups.entries()) {
    if (entry.expiresAt < now) pendingTotpSetups.delete(nonce);
  }
}

// ── In-memory login rate limiter ──────────────────────────────────────────────
// Simple per-IP sliding window — max 10 login attempts per minute.

interface RateEntry { count: number; resetAt: number }
const loginAttempts = new Map<string, RateEntry>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true; // allowed
  }
  entry.count++;
  if (entry.count > RATE_MAX) return false; // blocked
  return true;
}

// ── Config helpers ─────────────────────────────────────────────────────────────

interface UiAuthConfig {
  enabled: boolean;
  passwordHash: string;
  totpSecret?: string;   // only present once fully enabled (not during setup)
  totpEnabled: boolean;
  sessionTokenHash?: string;  // sha256 of the active session token (single session)
  sessionExpiry?: string;
}

function getConfig(): UiAuthConfig {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
  if (!row) return { enabled: false, passwordHash: '', totpEnabled: false };
  try { return JSON.parse(row.value) as UiAuthConfig; } catch { return { enabled: false, passwordHash: '', totpEnabled: false }; }
}

function saveConfig(cfg: UiAuthConfig): void {
  const db = getDb();
  const value = JSON.stringify(cfg);
  db.insert(settings)
    .values({ key: SETTINGS_KEY, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isSessionValid(cfg: UiAuthConfig, token: string): boolean {
  if (!cfg.sessionTokenHash || !cfg.sessionExpiry) return false;
  if (new Date(cfg.sessionExpiry) < new Date()) return false;
  return hashToken(token) === cfg.sessionTokenHash;
}

function getSessionToken(req: Request): string | null {
  // Check cookie first, then header
  const fromCookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
  const fromHeader = req.headers['x-ui-session'] as string | undefined;
  return fromCookie || fromHeader || null;
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/**
 * Express middleware that enforces UI login when enabled.
 * Returns 401 JSON when authentication is required but not present.
 * This is mounted in index.ts BEFORE the API router.
 */
export function uiAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // API routes with X-API-Key are always handled by optionalAuth — skip UI auth
  if (req.headers['x-api-key']) { next(); return; }

  // Auth routes themselves are always accessible
  if (req.path.startsWith('/api/ui-auth')) { next(); return; }

  const cfg = getConfig();
  if (!cfg.enabled) { next(); return; }

  const token = getSessionToken(req);
  if (token && isSessionValid(cfg, token)) { next(); return; }

  // Return 401 so the client knows to show the login page
  res.status(401).json({ error: 'Authentication required', loginRequired: true });
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/ui-auth/status
router.get('/status', (req, res) => {
  const cfg = getConfig();
  const token = getSessionToken(req);
  const authenticated = !cfg.enabled || (!!token && isSessionValid(cfg, token));
  res.json({
    enabled: cfg.enabled,
    totpEnabled: cfg.totpEnabled,
    authenticated,
    configured: !!cfg.passwordHash,
  });
});

// GET /api/ui-auth/config
router.get('/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    enabled: cfg.enabled,
    totpEnabled: cfg.totpEnabled,
    hasPassword: !!cfg.passwordHash,
  });
});

// PUT /api/ui-auth/config — update password, enable/disable login
router.put('/config', async (req, res) => {
  const { enabled, password, currentPassword } = req.body as {
    enabled?: boolean;
    password?: string;
    currentPassword?: string;
  };

  const cfg = getConfig();

  // If login is already enabled, require current password to make changes
  if (cfg.enabled && cfg.passwordHash && currentPassword !== undefined) {
    const valid = await bcrypt.compare(currentPassword, cfg.passwordHash);
    if (!valid) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
  }

  if (password !== undefined && password.length > 0) {
    cfg.passwordHash = await bcrypt.hash(password, 12);
    // Invalidate any existing session when the password changes
    cfg.sessionTokenHash = undefined;
    cfg.sessionExpiry = undefined;
  }

  if (enabled !== undefined) {
    if (enabled && !cfg.passwordHash) {
      return res.status(400).json({ error: 'Set a password before enabling login' });
    }
    cfg.enabled = enabled;
    // Clear session when disabling
    if (!enabled) {
      cfg.sessionTokenHash = undefined;
      cfg.sessionExpiry = undefined;
    }
  }

  saveConfig(cfg);

  // Clear the session cookie if we invalidated the session
  if (password !== undefined && password.length > 0) {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  }

  res.json({ success: true, enabled: cfg.enabled, totpEnabled: cfg.totpEnabled });
});

// POST /api/ui-auth/login — password check
router.post('/login', async (req, res) => {
  const { password } = req.body as { password?: string };
  const cfg = getConfig();

  if (!cfg.enabled) {
    return res.status(400).json({ error: 'Login is not enabled' });
  }

  if (!password || !cfg.passwordHash) {
    return res.status(400).json({ error: 'Password required' });
  }

  // Rate limiting per IP
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many login attempts. Please wait a minute before trying again.' });
  }

  const valid = await bcrypt.compare(password, cfg.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  if (cfg.totpEnabled) {
    // Password correct but 2FA required — issue a short-lived intermediate token
    // as an httpOnly cookie (not in the response body) to avoid it appearing in logs.
    const intermediate = randomBytes(24).toString('hex');
    cfg.sessionTokenHash = `pending:${hashToken(intermediate)}`;
    cfg.sessionExpiry = new Date(Date.now() + TOTP_STEP_DURATION_MS).toISOString();
    saveConfig(cfg);

    res.cookie(TOTP_INTERMEDIATE_COOKIE, intermediate, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: TOTP_STEP_DURATION_MS,
      path: '/',
    });

    return res.json({ success: true, totpRequired: true });
  }

  // Full login — issue session token
  const token = randomBytes(32).toString('hex');
  cfg.sessionTokenHash = hashToken(token);
  cfg.sessionExpiry = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();
  saveConfig(cfg);

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_DURATION_HOURS * 60 * 60 * 1000,
    path: '/',
  });

  res.json({ success: true, totpRequired: false });
});

// POST /api/ui-auth/login/totp — complete 2FA
router.post('/login/totp', (req, res) => {
  // Read the intermediate token from the httpOnly cookie (not the request body)
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const intermediateToken = cookies?.[TOTP_INTERMEDIATE_COOKIE];

  const { code } = req.body as { code?: string };
  const cfg = getConfig();

  if (!cfg.totpEnabled || !cfg.totpSecret) {
    return res.status(400).json({ error: '2FA not configured' });
  }

  // Verify the intermediate token is valid and pending
  if (!intermediateToken || cfg.sessionTokenHash !== `pending:${hashToken(intermediateToken)}`) {
    return res.status(401).json({ error: 'Invalid or expired login session. Please start the login process again.' });
  }

  const verifyResult = otp.verifySync({ token: code || '', secret: cfg.totpSecret });
  if (!code || !verifyResult.valid) {
    return res.status(401).json({ error: 'Invalid 2FA code' });
  }

  // Issue full session — clear the intermediate cookie
  const token = randomBytes(32).toString('hex');
  cfg.sessionTokenHash = hashToken(token);
  cfg.sessionExpiry = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();
  saveConfig(cfg);

  res.clearCookie(TOTP_INTERMEDIATE_COOKIE, { path: '/' });
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'lax',
    maxAge: SESSION_DURATION_HOURS * 60 * 60 * 1000,
    path: '/',
  });

  res.json({ success: true });
});

// POST /api/ui-auth/logout
router.post('/logout', (req, res) => {
  const cfg = getConfig();
  cfg.sessionTokenHash = undefined;
  cfg.sessionExpiry = undefined;
  saveConfig(cfg);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.clearCookie(TOTP_INTERMEDIATE_COOKIE, { path: '/' });
  res.json({ success: true });
});

// POST /api/ui-auth/totp/setup — generate a new secret (not yet enabled)
// The secret is stored in memory only — written to DB only on successful verify.
router.post('/totp/setup', (req, res) => {
  cleanupExpiredSetups();

  const secret = otp.generateSecret();
  const nonce = randomBytes(16).toString('hex');
  const otpauthUrl = otp.generateURI({ issuer: 'Conduit', label: 'Conduit', secret });

  pendingTotpSetups.set(nonce, {
    secret,
    expiresAt: Date.now() + 15 * 60 * 1000, // 15-minute setup window
  });

  res.json({ secret, otpauthUrl, setupNonce: nonce });
});

// POST /api/ui-auth/totp/verify — verify and enable 2FA
router.post('/totp/verify', (req, res) => {
  const { code, setupNonce } = req.body as { code?: string; setupNonce?: string };

  if (!setupNonce) {
    return res.status(400).json({ error: 'setupNonce is required — run /setup first' });
  }

  const pending = pendingTotpSetups.get(setupNonce);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingTotpSetups.delete(setupNonce);
    return res.status(400).json({ error: 'Setup session expired — run /setup again' });
  }

  const verifyResult = otp.verifySync({ token: code || '', secret: pending.secret });
  if (!code || !verifyResult.valid) {
    return res.status(401).json({ error: 'Invalid code — check your authenticator app' });
  }

  // Code verified — now persist the TOTP secret to DB and enable 2FA
  const cfg = getConfig();
  cfg.totpSecret = pending.secret;
  cfg.totpEnabled = true;
  saveConfig(cfg);

  pendingTotpSetups.delete(setupNonce);

  res.json({ success: true });
});

// DELETE /api/ui-auth/totp — disable 2FA (requires current password)
router.delete('/totp', async (req, res) => {
  const { password } = req.body as { password?: string };
  const cfg = getConfig();

  // Require password confirmation to disable 2FA
  if (!password) {
    return res.status(400).json({ error: 'Current password is required to disable 2FA' });
  }
  if (!cfg.passwordHash) {
    return res.status(400).json({ error: 'No password configured' });
  }
  const valid = await bcrypt.compare(password, cfg.passwordHash);
  if (!valid) {
    return res.status(403).json({ error: 'Incorrect password' });
  }

  cfg.totpSecret = undefined;
  cfg.totpEnabled = false;
  saveConfig(cfg);
  res.json({ success: true });
});

export default router;
