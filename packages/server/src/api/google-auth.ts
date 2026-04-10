/**
 * Google Auth routes — multi-account credential management.
 *
 * Credentials are stored in settings under `credentials.gmail` as a JSON array:
 * [{ email, clientId, clientSecret, accessToken, refreshToken, tokenExpiry }, ...]
 *
 * Each account is identified by its email address.
 */

import { Router } from 'express';
import { google } from 'googleapis';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';
import type { GmailCreds } from '../sync/gmail.js';

const router = Router();
const SETTINGS_KEY = 'credentials.gmail';

// ── Storage helpers ────────────────────────────────────────────────────────────

export function getAllGmailCreds(): GmailCreds[] {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    // Handle legacy single-account format
    if (Array.isArray(parsed)) return parsed as GmailCreds[];
    if (parsed && typeof parsed === 'object' && parsed.accessToken) return [parsed as GmailCreds];
    return [];
  } catch { return []; }
}

/** @deprecated Use getAllGmailCreds() */
export function getGmailCreds(): GmailCreds | null {
  const all = getAllGmailCreds();
  return all[0] ?? null;
}

export function getGmailCredsByEmail(email: string): GmailCreds | null {
  return getAllGmailCreds().find((c) => c.email === email) ?? null;
}

function saveAllGmailCreds(creds: GmailCreds[]): void {
  const db = getDb();
  const value = JSON.stringify(creds);
  db.insert(settings)
    .values({ key: SETTINGS_KEY, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

export function upsertGmailCreds(creds: GmailCreds): void {
  const all = getAllGmailCreds();
  const idx = all.findIndex((c) => c.email === creds.email);
  if (idx >= 0) all[idx] = creds;
  else all.push(creds);
  saveAllGmailCreds(all);
}

export function removeGmailCreds(email: string): void {
  const all = getAllGmailCreds().filter((c) => c.email !== email);
  saveAllGmailCreds(all);
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/google/status — status of all connected accounts
router.get('/status', optionalAuth, async (req, res) => {
  const allCreds = getAllGmailCreds();
  const accounts = allCreds.map((creds) => {
    const expiresAt = creds.tokenExpiry || null;
    const tokenValid = !expiresAt || new Date(expiresAt).getTime() > Date.now() + 60000;
    return {
      email: creds.email || null,
      configured: !!(creds.clientId && creds.accessToken && creds.refreshToken),
      tokenValid,
      expiresAt,
    };
  });
  res.json({
    configured: accounts.length > 0,
    accountCount: accounts.length,
    accounts,
  });
});

// GET /api/google/accounts — list all accounts (for UI display)
router.get('/accounts', optionalAuth, (req, res) => {
  const allCreds = getAllGmailCreds();
  res.json(allCreds.map((c) => ({
    email: c.email || null,
    configured: !!(c.clientId && c.accessToken && c.refreshToken),
    tokenValid: !c.tokenExpiry || new Date(c.tokenExpiry).getTime() > Date.now() + 60000,
    expiresAt: c.tokenExpiry || null,
  })));
});

// POST /api/google/credentials — add or update an account
router.post('/credentials', optionalAuth, async (req, res) => {
  const { clientId, clientSecret, accessToken, refreshToken } = req.body as Partial<GmailCreds>;

  if (!clientId || !clientSecret || !accessToken || !refreshToken) {
    return res.status(400).json({ error: 'clientId, clientSecret, accessToken, and refreshToken are all required' });
  }

  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    const gmail = google.gmail({ version: 'v1', auth });

    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress || '';

    const creds: GmailCreds = { clientId, clientSecret, accessToken, refreshToken, email };
    upsertGmailCreds(creds);

    // Connect the new account through the manager
    const { getConnectionManager } = await import('../connections/manager.js');
    const manager = getConnectionManager();
    await manager.connectGmailAccount(creds);

    res.json({ success: true, email, accountCount: getAllGmailCreds().length });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid credentials' });
  }
});

// DELETE /api/google/credentials/:email — remove a specific account
router.delete('/credentials/:email', optionalAuth, async (req, res) => {
  const email = decodeURIComponent(req.params['email'] as string);
  removeGmailCreds(email);

  // Disconnect from manager
  const { getConnectionManager } = await import('../connections/manager.js');
  const manager = getConnectionManager();
  manager.disconnectGmailAccount(email);

  res.json({ success: true, remaining: getAllGmailCreds().length });
});

// DELETE /api/google/credentials — remove ALL accounts (legacy compat)
router.delete('/credentials', optionalAuth, async (req, res) => {
  const db = getDb();
  db.delete(settings).where(eq(settings.key, SETTINGS_KEY)).run();

  const { getConnectionManager } = await import('../connections/manager.js');
  const manager = getConnectionManager();
  manager.disconnectAllGmailAccounts();

  res.json({ success: true });
});

// POST /api/google/refresh/:email — refresh a specific account's token
router.post('/refresh/:email', optionalAuth, async (req, res) => {
  const email = decodeURIComponent(req.params['email'] as string);
  const creds = getGmailCredsByEmail(email);
  if (!creds?.clientId || !creds?.refreshToken) {
    return res.status(400).json({ error: `No credentials found for ${email}` });
  }

  try {
    const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
    auth.setCredentials({ refresh_token: creds.refreshToken });
    const { credentials } = await auth.refreshAccessToken();

    creds.accessToken = credentials.access_token || creds.accessToken;
    if (credentials.expiry_date) creds.tokenExpiry = new Date(credentials.expiry_date).toISOString();
    upsertGmailCreds(creds);

    res.json({ success: true, email, expiresAt: creds.tokenExpiry });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /api/google/refresh — refresh all accounts
router.post('/refresh', optionalAuth, async (req, res) => {
  const allCreds = getAllGmailCreds();
  const results: Array<{ email: string; success: boolean; error?: string }> = [];

  for (const creds of allCreds) {
    if (!creds.clientId || !creds.refreshToken) continue;
    try {
      const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
      auth.setCredentials({ refresh_token: creds.refreshToken });
      const { credentials } = await auth.refreshAccessToken();
      creds.accessToken = credentials.access_token || creds.accessToken;
      if (credentials.expiry_date) creds.tokenExpiry = new Date(credentials.expiry_date).toISOString();
      upsertGmailCreds(creds);
      results.push({ email: creds.email || '', success: true });
    } catch (e) {
      results.push({ email: creds.email || '', success: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  res.json({ success: true, results });
});

export default router;
