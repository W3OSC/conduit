import { Router } from 'express';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';

const router = Router();

// Credential keys stored in the settings table
const CRED_KEYS = {
  slack: 'credentials.slack',
  discord: 'credentials.discord',
  telegram: 'credentials.telegram',
  gmail: 'credentials.gmail',
  twitter: 'credentials.twitter',
  notion: 'credentials.notion',
} as const;

type Service = keyof typeof CRED_KEYS;

interface SlackCreds { token: string; appToken?: string }
interface DiscordCreds { token: string }
interface TelegramCreds { apiId: string; apiHash: string; phone: string; sessionString?: string }
interface GmailCredsLite { clientId: string; clientSecret: string; accessToken: string; refreshToken: string; email?: string; tokenExpiry?: string }
interface TwitterCredsLite { cookieString: string; cookies?: string; userId?: string; handle?: string; displayName?: string }
interface NotionCredsLite { token: string; workspaceName?: string; botId?: string }

type Creds = SlackCreds | DiscordCreds | TelegramCreds | GmailCredsLite | TwitterCredsLite | NotionCredsLite;

function redact(service: Service, creds: Creds): Record<string, unknown> {
  if (service === 'slack') {
    const c = creds as SlackCreds;
    return { token: c.token ? `${c.token.slice(0, 8)}...` : '', appToken: c.appToken ? `${c.appToken.slice(0, 8)}...` : '', configured: !!c.token };
  }
  if (service === 'discord') {
    const c = creds as DiscordCreds;
    return { token: c.token ? `${c.token.slice(0, 8)}...` : '', configured: !!c.token };
  }
  if (service === 'telegram') {
    const c = creds as TelegramCreds;
    return { apiId: c.apiId || '', apiHash: c.apiHash ? `${c.apiHash.slice(0, 6)}...` : '', phone: c.phone || '', sessionString: c.sessionString ? '[stored]' : '', configured: !!(c.apiId && c.apiHash && c.phone), authenticated: !!c.sessionString };
  }
  if (service === 'gmail') {
    const c = creds as GmailCredsLite;
    return { email: c.email || '', configured: !!(c.clientId && c.accessToken && c.refreshToken), tokenValid: !c.tokenExpiry || new Date(c.tokenExpiry).getTime() > Date.now() };
  }
  if (service === 'notion') {
    const c = creds as NotionCredsLite;
    return { token: c.token ? '[stored]' : '', workspaceName: c.workspaceName || '', configured: !!c.token };
  }
  // twitter
  const c = creds as TwitterCredsLite;
  return { handle: c.handle || '', configured: !!c.cookieString, authenticated: !!c.cookies };
}

function getCreds(service: Service): Creds | null {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, CRED_KEYS[service])).get();
  if (!row) return null;
  try { return JSON.parse(row.value) as Creds; } catch { return null; }
}

function setCreds(service: Service, creds: Creds): void {
  const db = getDb();
  const value = JSON.stringify(creds);
  db.insert(settings)
    .values({ key: CRED_KEYS[service], value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

// GET /api/credentials/:service/raw — returns full unredacted credentials (for Settings UI)
router.get('/:service/raw', optionalAuth, (req, res) => {
  const service = req.params['service'] as Service;
  if (!CRED_KEYS[service]) return res.status(400).json({ error: 'Unknown service' });
  const creds = getCreds(service);
  if (!creds) return res.json({});
  // Return everything except sessionString (keep that opaque even in raw view)
  if (service === 'telegram') {
    const c = creds as TelegramCreds;
    return res.json({ apiId: c.apiId || '', apiHash: c.apiHash || '', phone: c.phone || '', authenticated: !!c.sessionString });
  }
  res.json(creds);
});

// GET /api/credentials — returns redacted view of all credentials
router.get('/', optionalAuth, (_req, res) => {
  const result: Record<string, unknown> = {};
  for (const service of Object.keys(CRED_KEYS) as Service[]) {
    const creds = getCreds(service);
    result[service] = creds ? redact(service, creds) : { configured: false };
  }
  res.json(result);
});

// PUT /api/credentials/:service — save credentials (never redacted on write)
router.put('/:service', optionalAuth, (req, res) => {
  const service = req.params['service'] as Service;
  if (!CRED_KEYS[service]) return res.status(400).json({ error: 'Unknown service' });

  const existing = getCreds(service) || {} as Creds;
  // Merge: only overwrite fields that are actually sent (allows partial updates)
  const merged = { ...existing, ...req.body } as Creds;

  // Strip redacted placeholder values that the UI might echo back
  if (service === 'slack') {
    const c = merged as SlackCreds;
    if (c.token?.endsWith('...')) c.token = (existing as SlackCreds).token || '';
    if (c.appToken?.endsWith('...')) c.appToken = (existing as SlackCreds).appToken || '';
  } else if (service === 'discord') {
    const c = merged as DiscordCreds;
    if (c.token?.endsWith('...')) c.token = (existing as DiscordCreds).token || '';
  } else if (service === 'telegram') {
    const c = merged as TelegramCreds;
    if (c.apiHash?.endsWith('...')) c.apiHash = (existing as TelegramCreds).apiHash || '';
    if (c.sessionString === '[stored]') c.sessionString = (existing as TelegramCreds).sessionString || '';
  } else if (service === 'notion') {
    const c = merged as NotionCredsLite;
    if (c.token === '[stored]') c.token = (existing as NotionCredsLite).token || '';
  }

  setCreds(service, merged);
  res.json({ success: true, ...redact(service, merged) });
});

export { getCreds, setCreds, type SlackCreds, type DiscordCreds, type TelegramCreds, type GmailCredsLite, type TwitterCredsLite, type NotionCredsLite };
export default router;
