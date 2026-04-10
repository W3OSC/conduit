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
 *   totpSecret?: string,       // base32 TOTP secret (set when 2FA is enabled)
 *   totpEnabled: boolean,
 *   sessionToken?: string,     // sha256 of the active session token (single session)
 *   sessionExpiry?: string,    // ISO date
 * }
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
 *   DELETE /api/ui-auth/totp    → disables 2FA
 */

import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Request, Response, NextFunction } from 'express';

const router = Router();
const SETTINGS_KEY = 'ui.auth';
const SESSION_COOKIE_NAME = 'conduit-session';
const SESSION_DURATION_HOURS = 24 * 7; // 1 week

// ── Config helpers ─────────────────────────────────────────────────────────────

interface UiAuthConfig {
  enabled: boolean;
  passwordHash: string;
  totpSecret?: string;
  totpEnabled: boolean;
  sessionTokenHash?: string;  // sha256 of the active session token
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
router.put('/config', (req, res) => {
  const { enabled, password, currentPassword } = req.body as {
    enabled?: boolean;
    password?: string;
    currentPassword?: string;
  };

  const cfg = getConfig();

  // If login is already enabled, require current password to make changes
  if (cfg.enabled && cfg.passwordHash && currentPassword !== undefined) {
    if (!bcrypt.compareSync(currentPassword, cfg.passwordHash)) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
  }

  if (password !== undefined && password.length > 0) {
    cfg.passwordHash = bcrypt.hashSync(password, 12);
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

  const valid = bcrypt.compareSync(password, cfg.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  if (cfg.totpEnabled) {
    // Password correct but 2FA required — signal client to ask for TOTP code
    // Generate a short-lived intermediate token so the TOTP step is stateless
    const intermediate = randomBytes(24).toString('hex');
    cfg.sessionTokenHash = `pending:${hashToken(intermediate)}`;
    cfg.sessionExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min for TOTP step
    saveConfig(cfg);
    return res.json({ success: true, totpRequired: true, intermediateToken: intermediate });
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

  res.json({ success: true, totpRequired: false, token });
});

// POST /api/ui-auth/login/totp — complete 2FA
router.post('/login/totp', (req, res) => {
  const { code, intermediateToken } = req.body as { code?: string; intermediateToken?: string };
  const cfg = getConfig();

  if (!cfg.totpEnabled || !cfg.totpSecret) {
    return res.status(400).json({ error: '2FA not configured' });
  }

  // Verify the intermediate token is valid and pending
  if (!intermediateToken || cfg.sessionTokenHash !== `pending:${hashToken(intermediateToken)}`) {
    return res.status(401).json({ error: 'Invalid or expired intermediate token' });
  }

  if (!code || !authenticator.verify({ token: code, secret: cfg.totpSecret })) {
    return res.status(401).json({ error: 'Invalid 2FA code' });
  }

  // Issue full session
  const token = randomBytes(32).toString('hex');
  cfg.sessionTokenHash = hashToken(token);
  cfg.sessionExpiry = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();
  saveConfig(cfg);

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'lax',
    maxAge: SESSION_DURATION_HOURS * 60 * 60 * 1000,
    path: '/',
  });

  res.json({ success: true, token });
});

// POST /api/ui-auth/logout
router.post('/logout', (req, res) => {
  const cfg = getConfig();
  cfg.sessionTokenHash = undefined;
  cfg.sessionExpiry = undefined;
  saveConfig(cfg);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ success: true });
});

// POST /api/ui-auth/totp/setup — generate a new secret (not yet enabled)
router.post('/totp/setup', (req, res) => {
  const cfg = getConfig();
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri('Conduit', 'Conduit', secret);
  // Store the new secret before the user verifies it — totpEnabled stays false until /totp/verify succeeds.
  cfg.totpSecret = secret;
  cfg.totpEnabled = false;
  saveConfig(cfg);
  res.json({ secret, otpauthUrl });
});

// POST /api/ui-auth/totp/verify — verify and enable 2FA
router.post('/totp/verify', (req, res) => {
  const { code } = req.body as { code?: string };
  const cfg = getConfig();

  if (!cfg.totpSecret) {
    return res.status(400).json({ error: 'Run /setup first' });
  }

  if (!code || !authenticator.verify({ token: code, secret: cfg.totpSecret })) {
    return res.status(401).json({ error: 'Invalid code — check your authenticator app' });
  }

  cfg.totpEnabled = true;
  saveConfig(cfg);
  res.json({ success: true });
});

// DELETE /api/ui-auth/totp — disable 2FA
router.delete('/totp', (req, res) => {
  const cfg = getConfig();
  cfg.totpSecret = undefined;
  cfg.totpEnabled = false;
  saveConfig(cfg);
  res.json({ success: true });
});

export default router;
