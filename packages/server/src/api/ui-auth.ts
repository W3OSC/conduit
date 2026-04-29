/**
 * UI Auth — optional multi-method login for the browser UI.
 *
 * Three independent login methods can be enabled in any combination:
 *   • Password  — bcrypt-hashed password
 *   • TOTP 2FA  — layered on top of password (requires password to be enabled too)
 *   • Passkey   — WebAuthn (FIDO2) authenticator
 *
 * Each enabled method has its own sessionDurationHours (0 = always require login,
 * meaning sessions expire immediately and every page load re-checks).
 *
 * When ALL methods are disabled, all browser requests are treated as authenticated.
 *
 * Config stored in settings table under the key 'ui.auth' (JSON):
 * {
 *   password: {
 *     enabled: boolean,
 *     sessionDurationHours: number,   // 0 = require every time
 *     passwordHash: string,
 *   },
 *   totp: {
 *     enabled: boolean,
 *     sessionDurationHours: number,
 *     secret?: string,
 *   },
 *   passkey: {
 *     enabled: boolean,
 *     sessionDurationHours: number,
 *   },
 *   // Single shared session token — whichever method last authenticated issues it.
 *   sessionTokenHash?: string,
 *   sessionExpiry?: string,
 *   sessionMethod?: 'password' | 'totp' | 'passkey',
 * }
 *
 * Routes:
 *   GET  /api/ui-auth/status              → { anyEnabled, methods, authenticated }
 *   GET  /api/ui-auth/config              → current config (no secrets)
 *   PUT  /api/ui-auth/config              → update per-method settings
 *
 *   POST /api/ui-auth/login               → password check → { success, totpRequired }
 *   POST /api/ui-auth/login/totp          → 2FA code check → { success }
 *   POST /api/ui-auth/logout              → clear session
 *
 *   POST /api/ui-auth/totp/setup          → generate TOTP secret → { secret, otpauthUrl, setupNonce }
 *   POST /api/ui-auth/totp/verify         → verify code + enable TOTP → { success }
 *   DELETE /api/ui-auth/totp              → disable TOTP (requires password)
 *
 *   POST /api/ui-auth/passkey/register/begin    → start passkey registration
 *   POST /api/ui-auth/passkey/register/finish   → complete registration + name passkey
 *   POST /api/ui-auth/passkey/login/begin       → start passkey assertion
 *   POST /api/ui-auth/passkey/login/finish      → verify assertion → issues session
 *   GET  /api/ui-auth/passkey/credentials       → list registered passkeys
 *   DELETE /api/ui-auth/passkey/credentials/:id → remove a passkey
 */

import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { OTP } from 'otplib/class';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { getDb } from '../db/client.js';
import { settings, passkeyCredentials } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { Request, Response, NextFunction } from 'express';

const router = Router();
const otp = new OTP({ strategy: 'totp' });
const SETTINGS_KEY = 'ui.auth';
const SESSION_COOKIE_NAME = 'conduit-session';
const TOTP_INTERMEDIATE_COOKIE = 'conduit-totp-step';
const TOTP_STEP_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ── In-memory TOTP setup store ────────────────────────────────────────────────

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

// ── In-memory WebAuthn challenge store ────────────────────────────────────────

interface PendingChallenge {
  challenge: string;
  expiresAt: number;
}
const pendingChallenges = new Map<string, PendingChallenge>();
const CHALLENGE_NONCE_COOKIE = 'conduit-wn-nonce';
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredChallenges(): void {
  const now = Date.now();
  for (const [k, v] of pendingChallenges.entries()) {
    if (v.expiresAt < now) pendingChallenges.delete(k);
  }
}

function storeChallenge(res: Response, challenge: string): string {
  cleanupExpiredChallenges();
  const nonce = randomBytes(16).toString('hex');
  pendingChallenges.set(nonce, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  res.cookie(CHALLENGE_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: CHALLENGE_TTL_MS,
    path: '/',
  });
  return nonce;
}

function consumeChallenge(req: Request, res: Response): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const nonce = cookies?.[CHALLENGE_NONCE_COOKIE];
  if (!nonce) return null;
  const entry = pendingChallenges.get(nonce);
  pendingChallenges.delete(nonce);
  res.clearCookie(CHALLENGE_NONCE_COOKIE, { path: '/' });
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

// ── In-memory login rate limiter ──────────────────────────────────────────────

interface RateEntry { count: number; resetAt: number }
const loginAttempts = new Map<string, RateEntry>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_MAX;
}

// ── Config types ───────────────────────────────────────────────────────────────

interface PasswordMethodConfig {
  enabled: boolean;
  sessionDurationHours: number;  // 0 = always require
  passwordHash: string;
}

interface TotpMethodConfig {
  enabled: boolean;
  sessionDurationHours: number;
  secret?: string;
}

interface PasskeyMethodConfig {
  enabled: boolean;
  sessionDurationHours: number;
}

interface UiAuthConfig {
  password: PasswordMethodConfig;
  totp: TotpMethodConfig;
  passkey: PasskeyMethodConfig;
  sessionTokenHash?: string;
  sessionExpiry?: string;
  sessionMethod?: 'password' | 'totp' | 'passkey';
}

const DEFAULT_CONFIG: UiAuthConfig = {
  password: { enabled: false, sessionDurationHours: 0, passwordHash: '' },
  totp:     { enabled: false, sessionDurationHours: 0 },
  passkey:  { enabled: false, sessionDurationHours: 0 },
};

function getConfig(): UiAuthConfig {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
  if (!row) return structuredClone(DEFAULT_CONFIG);
  try {
    const parsed = JSON.parse(row.value) as Partial<UiAuthConfig>;
    // Migrate from old flat format if necessary
    if ('enabled' in parsed || 'passwordHash' in parsed) {
      return migrateOldConfig(parsed as Record<string, unknown>);
    }
    return {
      password: { ...DEFAULT_CONFIG.password, ...(parsed.password ?? {}) },
      totp:     { ...DEFAULT_CONFIG.totp,     ...(parsed.totp ?? {}) },
      passkey:  { ...DEFAULT_CONFIG.passkey,  ...(parsed.passkey ?? {}) },
      sessionTokenHash: parsed.sessionTokenHash,
      sessionExpiry:    parsed.sessionExpiry,
      sessionMethod:    parsed.sessionMethod,
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** One-time migration from old flat config format. */
function migrateOldConfig(old: Record<string, unknown>): UiAuthConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (old.enabled)      cfg.password.enabled = true;
  if (old.passwordHash) cfg.password.passwordHash = old.passwordHash as string;
  if (old.totpEnabled)  cfg.totp.enabled = true;
  if (old.totpSecret)   cfg.totp.secret   = old.totpSecret as string;
  if (old.sessionTokenHash) cfg.sessionTokenHash = old.sessionTokenHash as string;
  if (old.sessionExpiry)    cfg.sessionExpiry    = old.sessionExpiry as string;
  return cfg;
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

function anyMethodEnabled(cfg: UiAuthConfig): boolean {
  return cfg.password.enabled || cfg.totp.enabled || cfg.passkey.enabled;
}

function sessionDurationMs(cfg: UiAuthConfig): number {
  // Use the duration for whichever method last authenticated.
  const method = cfg.sessionMethod;
  let hours = 0;
  if (method === 'password') hours = cfg.password.sessionDurationHours;
  else if (method === 'totp') hours = cfg.totp.sessionDurationHours;
  else if (method === 'passkey') hours = cfg.passkey.sessionDurationHours;
  return hours > 0 ? hours * 60 * 60 * 1000 : 0;
}

function isSessionValid(cfg: UiAuthConfig, token: string): boolean {
  if (!cfg.sessionTokenHash) return false;
  // Duration 0 means "always require" — treat as expired
  if (sessionDurationMs(cfg) === 0) return false;
  if (!cfg.sessionExpiry || new Date(cfg.sessionExpiry) < new Date()) return false;
  return hashToken(token) === cfg.sessionTokenHash;
}

function getSessionToken(req: Request): string | null {
  const fromCookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
  const fromHeader = req.headers['x-ui-session'] as string | undefined;
  return fromCookie || fromHeader || null;
}

function issueSession(
  cfg: UiAuthConfig,
  method: 'password' | 'totp' | 'passkey',
  res: Response,
): void {
  const methodCfg = cfg[method];
  const durationMs = methodCfg.sessionDurationHours > 0
    ? methodCfg.sessionDurationHours * 60 * 60 * 1000
    : 0;

  if (durationMs === 0) {
    // Duration 0 → always require login; still issue a very short session so the
    // current page load works, but it expires immediately (1 second).
    const token = randomBytes(32).toString('hex');
    cfg.sessionTokenHash = hashToken(token);
    cfg.sessionExpiry    = new Date(Date.now() + 1000).toISOString();
    cfg.sessionMethod    = method;
    saveConfig(cfg);
    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true, sameSite: 'lax', maxAge: 1, path: '/',
    });
    return;
  }

  const token = randomBytes(32).toString('hex');
  cfg.sessionTokenHash = hashToken(token);
  cfg.sessionExpiry    = new Date(Date.now() + durationMs).toISOString();
  cfg.sessionMethod    = method;
  saveConfig(cfg);
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'lax', maxAge: durationMs, path: '/',
  });
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export function uiAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-api-key']) { next(); return; }
  if (req.path.startsWith('/api/ui-auth')) { next(); return; }

  const cfg = getConfig();
  if (!anyMethodEnabled(cfg)) { next(); return; }

  const token = getSessionToken(req);
  if (token && isSessionValid(cfg, token)) { next(); return; }

  res.status(401).json({ error: 'Authentication required', loginRequired: true });
}

// ── Status / Config routes ─────────────────────────────────────────────────────

// GET /api/ui-auth/status
router.get('/status', (req, res) => {
  const cfg = getConfig();
  const token = getSessionToken(req);
  const enabled = anyMethodEnabled(cfg);
  const authenticated = !enabled || (!!token && isSessionValid(cfg, token));

  const db = getDb();
  const passkeys = db.select().from(passkeyCredentials).all();

  res.json({
    anyEnabled: enabled,
    authenticated,
    methods: {
      password: {
        enabled: cfg.password.enabled,
        sessionDurationHours: cfg.password.sessionDurationHours,
        hasPassword: !!cfg.password.passwordHash,
      },
      totp: {
        enabled: cfg.totp.enabled,
        sessionDurationHours: cfg.totp.sessionDurationHours,
        totpEnabled: cfg.totp.enabled && !!cfg.totp.secret,
      },
      passkey: {
        enabled: cfg.passkey.enabled,
        sessionDurationHours: cfg.passkey.sessionDurationHours,
        count: passkeys.length,
      },
    },
  });
});

// GET /api/ui-auth/config
router.get('/config', (req, res) => {
  const cfg = getConfig();
  const db = getDb();
  const passkeys = db.select().from(passkeyCredentials).all();

  res.json({
    password: {
      enabled: cfg.password.enabled,
      sessionDurationHours: cfg.password.sessionDurationHours,
      hasPassword: !!cfg.password.passwordHash,
    },
    totp: {
      enabled: cfg.totp.enabled,
      sessionDurationHours: cfg.totp.sessionDurationHours,
      totpEnabled: cfg.totp.enabled && !!cfg.totp.secret,
    },
    passkey: {
      enabled: cfg.passkey.enabled,
      sessionDurationHours: cfg.passkey.sessionDurationHours,
      count: passkeys.length,
    },
  });
});

// PUT /api/ui-auth/config — update any combination of method settings
router.put('/config', async (req, res) => {
  const body = req.body as {
    password?: {
      enabled?: boolean;
      sessionDurationHours?: number;
      newPassword?: string;
      currentPassword?: string;
    };
    totp?: {
      sessionDurationHours?: number;
    };
    passkey?: {
      enabled?: boolean;
      sessionDurationHours?: number;
    };
  };

  const cfg = getConfig();

  // ── Password method ──────────────────────────────────────────────────────────
  if (body.password !== undefined) {
    const pw = body.password;

    // Require current password to make changes if one is already set
    if (cfg.password.passwordHash && pw.currentPassword !== undefined) {
      const valid = await bcrypt.compare(pw.currentPassword, cfg.password.passwordHash);
      if (!valid) return res.status(403).json({ error: 'Current password is incorrect' });
    }

    if (pw.newPassword !== undefined && pw.newPassword.length > 0) {
      cfg.password.passwordHash = await bcrypt.hash(pw.newPassword, 12);
      cfg.sessionTokenHash = undefined;
      cfg.sessionExpiry    = undefined;
    }

    if (pw.sessionDurationHours !== undefined) {
      cfg.password.sessionDurationHours = Math.max(0, pw.sessionDurationHours);
    }

    if (pw.enabled !== undefined) {
      if (pw.enabled && !cfg.password.passwordHash) {
        return res.status(400).json({ error: 'Set a password before enabling password login' });
      }
      cfg.password.enabled = pw.enabled;
      if (!pw.enabled) {
        cfg.sessionTokenHash = undefined;
        cfg.sessionExpiry    = undefined;
      }
    }

    if (pw.newPassword !== undefined && pw.newPassword.length > 0) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    }
  }

  // ── TOTP method ──────────────────────────────────────────────────────────────
  if (body.totp !== undefined) {
    const t = body.totp;
    if (t.sessionDurationHours !== undefined) {
      cfg.totp.sessionDurationHours = Math.max(0, t.sessionDurationHours);
    }
    // Enabling/disabling TOTP is handled via the totp/verify and DELETE /totp routes
  }

  // ── Passkey method ────────────────────────────────────────────────────────────
  if (body.passkey !== undefined) {
    const pk = body.passkey;
    if (pk.sessionDurationHours !== undefined) {
      cfg.passkey.sessionDurationHours = Math.max(0, pk.sessionDurationHours);
    }
    if (pk.enabled !== undefined) {
      const db = getDb();
      const passkeys = db.select().from(passkeyCredentials).all();
      if (pk.enabled && passkeys.length === 0) {
        return res.status(400).json({ error: 'Register at least one passkey before enabling passkey login' });
      }
      cfg.passkey.enabled = pk.enabled;
      if (!pk.enabled) {
        cfg.sessionTokenHash = undefined;
        cfg.sessionExpiry    = undefined;
      }
    }
  }

  saveConfig(cfg);
  res.json({ success: true });
});

// ── Password login routes ──────────────────────────────────────────────────────

// POST /api/ui-auth/login
router.post('/login', async (req, res) => {
  const { password } = req.body as { password?: string };
  const cfg = getConfig();

  if (!cfg.password.enabled) {
    return res.status(400).json({ error: 'Password login is not enabled' });
  }
  if (!password || !cfg.password.passwordHash) {
    return res.status(400).json({ error: 'Password required' });
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many login attempts. Please wait a minute before trying again.' });
  }

  const valid = await bcrypt.compare(password, cfg.password.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  if (cfg.totp.enabled && cfg.totp.secret) {
    // Issue a short-lived intermediate token before TOTP step
    const intermediate = randomBytes(24).toString('hex');
    cfg.sessionTokenHash = `pending:${hashToken(intermediate)}`;
    cfg.sessionExpiry    = new Date(Date.now() + TOTP_STEP_DURATION_MS).toISOString();
    saveConfig(cfg);

    res.cookie(TOTP_INTERMEDIATE_COOKIE, intermediate, {
      httpOnly: true, sameSite: 'lax', maxAge: TOTP_STEP_DURATION_MS, path: '/',
    });
    return res.json({ success: true, totpRequired: true });
  }

  issueSession(cfg, 'password', res);
  res.json({ success: true, totpRequired: false });
});

// POST /api/ui-auth/login/totp
router.post('/login/totp', (req, res) => {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const intermediateToken = cookies?.[TOTP_INTERMEDIATE_COOKIE];
  const { code } = req.body as { code?: string };
  const cfg = getConfig();

  if (!cfg.totp.enabled || !cfg.totp.secret) {
    return res.status(400).json({ error: '2FA not configured' });
  }
  if (!intermediateToken || cfg.sessionTokenHash !== `pending:${hashToken(intermediateToken)}`) {
    return res.status(401).json({ error: 'Invalid or expired login session. Please start the login process again.' });
  }

  const verifyResult = otp.verifySync({ token: code || '', secret: cfg.totp.secret });
  if (!code || !verifyResult.valid) {
    return res.status(401).json({ error: 'Invalid 2FA code' });
  }

  res.clearCookie(TOTP_INTERMEDIATE_COOKIE, { path: '/' });
  issueSession(cfg, 'totp', res);
  res.json({ success: true });
});

// POST /api/ui-auth/logout
router.post('/logout', (req, res) => {
  const cfg = getConfig();
  cfg.sessionTokenHash = undefined;
  cfg.sessionExpiry    = undefined;
  saveConfig(cfg);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.clearCookie(TOTP_INTERMEDIATE_COOKIE, { path: '/' });
  res.json({ success: true });
});

// ── TOTP management routes ─────────────────────────────────────────────────────

// POST /api/ui-auth/totp/setup
router.post('/totp/setup', (req, res) => {
  cleanupExpiredSetups();
  const secret = otp.generateSecret();
  const nonce  = randomBytes(16).toString('hex');
  const otpauthUrl = otp.generateURI({ issuer: 'Conduit', label: 'Conduit', secret });

  pendingTotpSetups.set(nonce, { secret, expiresAt: Date.now() + 15 * 60 * 1000 });
  res.json({ secret, otpauthUrl, setupNonce: nonce });
});

// POST /api/ui-auth/totp/verify
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

  const cfg = getConfig();
  cfg.totp.secret  = pending.secret;
  cfg.totp.enabled = true;
  saveConfig(cfg);
  pendingTotpSetups.delete(setupNonce);
  res.json({ success: true });
});

// DELETE /api/ui-auth/totp
router.delete('/totp', async (req, res) => {
  const { password } = req.body as { password?: string };
  const cfg = getConfig();

  if (!password) return res.status(400).json({ error: 'Current password is required to disable 2FA' });
  if (!cfg.password.passwordHash) return res.status(400).json({ error: 'No password configured' });

  const valid = await bcrypt.compare(password, cfg.password.passwordHash);
  if (!valid) return res.status(403).json({ error: 'Incorrect password' });

  cfg.totp.secret  = undefined;
  cfg.totp.enabled = false;
  saveConfig(cfg);
  res.json({ success: true });
});

// ── Passkey (WebAuthn) routes ──────────────────────────────────────────────────

function getRpId(req: Request): string {
  // Derive rpId from the Origin header or Host; fall back to localhost.
  const origin = req.headers.origin || req.headers.host || 'localhost';
  try {
    return new URL(origin.includes('://') ? origin : `https://${origin}`).hostname;
  } catch {
    return 'localhost';
  }
}

function getOrigin(req: Request): string {
  const origin = req.headers.origin;
  if (origin) return origin;
  const host = req.headers.host || 'localhost';
  return `http://${host}`;
}

// POST /api/ui-auth/passkey/register/begin
router.post('/passkey/register/begin', async (req, res) => {
  const db = getDb();
  const existing = db.select().from(passkeyCredentials).all();
  const excludeCredentials = existing.map((c) => ({
    id: c.credentialId,
    transports: undefined as AuthenticatorTransportFuture[] | undefined,
  }));

  const options = await generateRegistrationOptions({
    rpName: 'Conduit',
    rpID: getRpId(req),
    userName: 'conduit-user',
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  storeChallenge(res, options.challenge);
  res.json(options);
});

// POST /api/ui-auth/passkey/register/finish
router.post('/passkey/register/finish', async (req, res) => {
  const expectedChallenge = consumeChallenge(req, res);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge expired or missing — start registration again' });
  }

  const body = req.body as { response: RegistrationResponseJSON; name?: string };
  const rpID = getRpId(req);
  const origin = getOrigin(req);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'Registration verification failed' });
  }

  const { credential } = verification.registrationInfo;

  const db = getDb();
  db.insert(passkeyCredentials).values({
    credentialId: credential.id,
    publicKey:    Buffer.from(credential.publicKey).toString('base64url'),
    counter:      credential.counter,
    aaguid:       verification.registrationInfo.aaguid,
    name:         body.name || 'Passkey',
    createdAt:    new Date().toISOString(),
  }).run();

  // Auto-enable passkey method if this is the first credential
  const cfg = getConfig();
  if (!cfg.passkey.enabled) {
    cfg.passkey.enabled = true;
    saveConfig(cfg);
  }

  res.json({ success: true });
});

// POST /api/ui-auth/passkey/login/begin
router.post('/passkey/login/begin', async (req, res) => {
  const cfg = getConfig();
  if (!cfg.passkey.enabled) {
    return res.status(400).json({ error: 'Passkey login is not enabled' });
  }

  const db = getDb();
  const existing = db.select().from(passkeyCredentials).all();
  if (existing.length === 0) {
    return res.status(400).json({ error: 'No passkeys registered' });
  }

  const allowCredentials = existing.map((c) => ({
    id: c.credentialId,
    transports: undefined as AuthenticatorTransportFuture[] | undefined,
  }));

  const options = await generateAuthenticationOptions({
    rpID: getRpId(req),
    allowCredentials,
    userVerification: 'preferred',
  });

  storeChallenge(res, options.challenge);
  res.json(options);
});

// POST /api/ui-auth/passkey/login/finish
router.post('/passkey/login/finish', async (req, res) => {
  const expectedChallenge = consumeChallenge(req, res);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'Challenge expired or missing — start login again' });
  }

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many login attempts. Please wait a minute before trying again.' });
  }

  const body = req.body as { response: AuthenticationResponseJSON };
  const rpID = getRpId(req);
  const origin = getOrigin(req);

  const db = getDb();
  const credId = body.response.id;
  const storedCred = db.select().from(passkeyCredentials).where(eq(passkeyCredentials.credentialId, credId)).get();

  if (!storedCred) {
    return res.status(401).json({ error: 'Passkey not recognised' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: storedCred.credentialId,
        publicKey: Buffer.from(storedCred.publicKey, 'base64url'),
        counter: storedCred.counter,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    return res.status(401).json({ error: (e as Error).message });
  }

  if (!verification.verified) {
    return res.status(401).json({ error: 'Passkey verification failed' });
  }

  // Update counter
  db.update(passkeyCredentials)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date().toISOString() })
    .where(eq(passkeyCredentials.credentialId, credId))
    .run();

  const cfg = getConfig();
  issueSession(cfg, 'passkey', res);
  res.json({ success: true });
});

// GET /api/ui-auth/passkey/credentials
router.get('/passkey/credentials', (req, res) => {
  const db = getDb();
  const rows = db.select().from(passkeyCredentials).all();
  res.json({
    credentials: rows.map((r) => ({
      id: r.id,
      credentialId: r.credentialId,
      name: r.name,
      aaguid: r.aaguid,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    })),
  });
});

// DELETE /api/ui-auth/passkey/credentials/:id
router.delete('/passkey/credentials/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const db = getDb();
  db.delete(passkeyCredentials).where(eq(passkeyCredentials.id, id)).run();

  // If no passkeys remain, disable the passkey method
  const remaining = db.select().from(passkeyCredentials).all();
  if (remaining.length === 0) {
    const cfg = getConfig();
    cfg.passkey.enabled = false;
    saveConfig(cfg);
  }

  res.json({ success: true });
});

export default router;
