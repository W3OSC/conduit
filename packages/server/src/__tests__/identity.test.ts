/**
 * Read-API tests for the Meridian reconcile surface:
 *   - /contacts q filtering (name, phone, email-in-platformId)
 *   - POST /contacts/resolve ranking, dmChatId resolution, no-match honesty
 *   - GET /contacts/:source/:platformId/chats (DMs flagged)
 *   - /search lean-by-default (no rawJson) and fields=full opt-in
 *   - coverage blocks on /search, /messages, /contacts and resolve
 *
 * Runs against a real migrated temp database, invoking the route handlers
 * directly (same pattern as digest.test.ts).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, Response, Router } from 'express';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-identity-test-')),
  'test.db',
);

const { runMigrations, getDb } = await import('../db/client.js');
const contactsRouter = (await import('../api/contacts.js')).default;
const identityRouter = (await import('../api/identity.js')).default;
const messagesRouter = (await import('../api/messages.js')).default;
const schema = await import('../db/schema.js');

// ── Minimal router harness ────────────────────────────────────────────────────

type Layer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => void }>;
  };
};

function findRoute(router: Router, method: string, routePath: string) {
  const layer = (router as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === routePath && l.route.methods[method],
  );
  if (!layer?.route) throw new Error(`No ${method.toUpperCase()} ${routePath} route found`);
  return layer.route.stack.map((s) => s.handle);
}

/** Run a route's full middleware chain (validators included) in-process. */
function invoke(
  router: Router,
  method: string,
  routePath: string,
  opts: { query?: Record<string, unknown>; body?: unknown; params?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handlers = findRoute(router, method, routePath);
  return new Promise((resolve, reject) => {
    const req = {
      query: opts.query ?? {},
      body: opts.body,
      params: opts.params ?? {},
      headers: {},
      actor: 'ui',
    } as unknown as Request;
    const res = {
      statusCode: 200,
      status(this: { statusCode: number }, code: number) { this.statusCode = code; return this; },
      json(this: { statusCode: number }, body: Record<string, unknown>) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    } as unknown as Response & { statusCode: number };
    let i = 0;
    const next = (err?: unknown) => {
      if (err) return reject(err);
      const h = handlers[i++];
      if (!h) return reject(new Error('route fell through all handlers'));
      try { h(req, res, next); } catch (e) { reject(e); }
    };
    next();
  });
}

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  await runMigrations();
  const db = getDb();

  // Our own accounts (coverage + isMe detection)
  db.insert(schema.accounts).values([
    { source: 'telegram', accountId: '111', displayName: 'Me | Operator' },
    { source: 'slack', accountId: 'U_ME', displayName: 'me' },
  ]).run();

  // Contacts
  db.insert(schema.contacts).values([
    {
      source: 'telegram', platformId: '2139911038', accountId: '111',
      displayName: 'Nathan | Symbiosis', username: 'nuhhtyy',
      firstName: 'Nathan | Symbiosis', hasDm: true,
    },
    {
      source: 'telegram', platformId: '555', accountId: '111',
      displayName: 'Jonathan Miranda', username: 'Terrapin_Wolf',
      firstName: 'Jonathan', lastName: 'Miranda', phone: '18064419692',
    },
    {
      source: 'calendar', platformId: 'anthony@wuwei.dev', accountId: 'op@example.com',
      displayName: 'anthony@wuwei.dev', username: 'anthony@wuwei.dev', hasDm: true,
    },
    {
      source: 'slack', platformId: 'U_NATE', accountId: 'U_ME',
      displayName: 'Nate Example', username: 'nate',
    },
  ]).run();

  // Telegram messages: Nathan's DM (chat_id = his user id) + a shared group
  db.insert(schema.telegramMessages).values([
    { messageId: 1, chatId: 2139911038, chatName: 'Nathan | Symbiosis', chatType: 'private', senderId: 2139911038, senderName: 'Nathan', content: 'hey — symbiosis integration?', timestamp: iso(3 * HOUR), rawJson: '{"big":"payload"}' },
    { messageId: 2, chatId: 2139911038, chatName: 'Nathan | Symbiosis', chatType: 'private', senderId: 111, senderName: 'Me', content: 'sure, tomorrow', timestamp: iso(2 * HOUR), rawJson: '{"big":"payload"}' },
    { messageId: 3, chatId: -100500, chatName: 'DeFi Group', chatType: 'supergroup', senderId: 2139911038, senderName: 'Nathan', content: 'gm', timestamp: iso(50 * HOUR), rawJson: '{"big":"payload"}' },
  ]).run();

  // Slack DM from the other contact
  db.insert(schema.slackMessages).values([
    { messageId: 's1', channelId: 'D42', channelName: 'nate', userId: 'U_NATE', userName: 'Nate', content: 'symbiosis launch update', timestamp: iso(1 * HOUR), rawJson: '{"big":"payload"}' },
  ]).run();
});

// ── A: contacts q filter ──────────────────────────────────────────────────────

describe('GET /contacts?q=', () => {
  it('matches Nathan by name and ranks the real match in', async () => {
    const { status, body } = await invoke(contactsRouter, 'get', '/', { query: { q: 'Nathan' } });
    expect(status).toBe(200);
    const hits = body.contacts as Array<{ platformId: string; displayName: string }>;
    expect(hits.some((c) => c.displayName === 'Nathan | Symbiosis')).toBe(true);
    // Filtering, not just ranking: unrelated contacts must be absent.
    expect(hits.some((c) => c.displayName === 'anthony@wuwei.dev')).toBe(false);
  });

  it('is case-insensitive', async () => {
    const { body } = await invoke(contactsRouter, 'get', '/', { query: { q: 'nAtHaN' } });
    const hits = body.contacts as Array<{ displayName: string }>;
    expect(hits.some((c) => c.displayName === 'Nathan | Symbiosis')).toBe(true);
  });

  it('matches phone numbers and email-bearing platformIds', async () => {
    const byPhone = await invoke(contactsRouter, 'get', '/', { query: { q: '8064419692' } });
    expect((byPhone.body.contacts as Array<{ displayName: string }>)
      .some((c) => c.displayName === 'Jonathan Miranda')).toBe(true);

    const byEmail = await invoke(contactsRouter, 'get', '/', { query: { q: 'anthony@wuwei' } });
    expect((byEmail.body.contacts as Array<{ platformId: string }>)
      .some((c) => c.platformId === 'anthony@wuwei.dev')).toBe(true);
  });

  it('rejects unknown query params instead of silently ignoring them', async () => {
    const { status, body } = await invoke(contactsRouter, 'get', '/', { query: { name: 'Nathan' } });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('name');
  });

  it('carries a coverage block and supports fields=lean', async () => {
    const { body } = await invoke(contactsRouter, 'get', '/', { query: { q: 'Nathan', fields: 'lean' } });
    expect(body.coverage).toBeDefined();
    const cov = body.coverage as { accountsSearched: Array<{ source: string; accountId: string }> };
    expect(cov.accountsSearched.some((a) => a.source === 'telegram' && a.accountId === '111')).toBe(true);
    const first = (body.contacts as Array<Record<string, unknown>>)[0]!;
    expect(first).not.toHaveProperty('avatarUrl');
    expect(first).not.toHaveProperty('bio');
  });
});

// ── B: resolve_identity ───────────────────────────────────────────────────────

describe('POST /contacts/resolve', () => {
  it('resolves name+domain to the telegram contact with its dmChatId', async () => {
    const { status, body } = await invoke(identityRouter, 'post', '/resolve', {
      body: { name: 'Nathan', domain: 'symbiosis.finance' },
    });
    expect(status).toBe(200);
    const candidates = body.candidates as Array<{
      contact: { source: string; platformId: string };
      confidence: number; matchedFields: string[]; dmChatId: string | null; hasDm: boolean;
      messageCount: number; accountId: string;
    }>;
    expect(candidates.length).toBeGreaterThan(0);
    const top = candidates[0]!;
    expect(top.contact.source).toBe('telegram');
    expect(top.contact.platformId).toBe('2139911038');
    expect(top.dmChatId).toBe('2139911038');
    expect(top.hasDm).toBe(true);
    expect(top.matchedFields).toContain('name');
    expect(top.matchedFields).toContain('domain');
    expect(top.confidence).toBeGreaterThan(0.8);
    expect(top.messageCount).toBe(2); // his messages: DM + group
    expect(top.accountId).toBe('111');
  });

  it('resolves a known email to its contact', async () => {
    const { body } = await invoke(identityRouter, 'post', '/resolve', {
      body: { email: 'Anthony@Wuwei.dev' },
    });
    const candidates = body.candidates as Array<{ contact: { platformId: string }; confidence: number; matchedFields: string[] }>;
    expect(candidates[0]!.contact.platformId).toBe('anthony@wuwei.dev');
    expect(candidates[0]!.matchedFields).toContain('email');
    expect(candidates[0]!.confidence).toBe(1);
  });

  it('states explicitly when no connected account has seen an identity', async () => {
    const { status, body } = await invoke(identityRouter, 'post', '/resolve', {
      body: { email: 'ghost@nowhere.example' },
    });
    expect(status).toBe(200);
    expect(body.candidates).toEqual([]);
    expect(body.resolution).toBe('no_match');
    expect(String(body.message)).toContain('No connected account has seen');
    expect(body.coverage).toBeDefined();
  });

  it('requires at least one identity field', async () => {
    const { status } = await invoke(identityRouter, 'post', '/resolve', { body: {} });
    expect(status).toBe(400);
  });

  it('respects the sources filter', async () => {
    const { body } = await invoke(identityRouter, 'post', '/resolve', {
      body: { name: 'Nathan', sources: ['slack'] },
    });
    const candidates = body.candidates as Array<{ contact: { source: string } }>;
    expect(candidates.every((c) => c.contact.source === 'slack')).toBe(true);
  });
});

// ── C: contact → chats ────────────────────────────────────────────────────────

describe('GET /contacts/:source/:platformId/chats', () => {
  it('returns the chats Nathan participates in, DM flagged and sendable', async () => {
    const { status, body } = await invoke(identityRouter, 'get', '/:source/:platformId/chats', {
      params: { source: 'telegram', platformId: '2139911038' },
    });
    expect(status).toBe(200);
    const chats = body.chats as Array<{ chatId: string; chatType: string; isDm: boolean; messageCount: number }>;
    const dm = chats.find((c) => c.isDm);
    expect(dm).toBeDefined();
    expect(dm!.chatId).toBe('2139911038');
    expect(dm!.messageCount).toBe(2); // both directions in the DM
    const group = chats.find((c) => !c.isDm);
    expect(group).toBeDefined();
    expect(group!.chatId).toBe('-100500');
  });

  it('404s for an unknown contact', async () => {
    const { status } = await invoke(identityRouter, 'get', '/:source/:platformId/chats', {
      params: { source: 'telegram', platformId: '999999' },
    });
    expect(status).toBe(404);
  });
});

// ── D: lean search ────────────────────────────────────────────────────────────

describe('GET /search', () => {
  it('returns lean normalised rows with no rawJson by default', async () => {
    const { status, body } = await invoke(messagesRouter, 'get', '/search', {
      query: { q: 'symbiosis' },
    });
    expect(status).toBe(200);
    const results = body.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThanOrEqual(2); // telegram + slack hits
    for (const r of results) {
      expect(r).not.toHaveProperty('rawJson');
      expect(r).not.toHaveProperty('attachments');
      expect(typeof r.chatId).toBe('string');
      expect(r).toHaveProperty('senderName');
      expect(r).toHaveProperty('context');
    }
  });

  it('returns raw rows only on explicit fields=full', async () => {
    const { body } = await invoke(messagesRouter, 'get', '/search', {
      query: { q: 'symbiosis', fields: 'full' },
    });
    const results = body.results as Array<Record<string, unknown>>;
    expect(results.some((r) => 'rawJson' in r)).toBe(true);
  });

  it('rejects unknown query params', async () => {
    const { status } = await invoke(messagesRouter, 'get', '/search', {
      query: { query: 'symbiosis' },
    });
    expect(status).toBe(400);
  });
});

// ── E: coverage blocks ────────────────────────────────────────────────────────

describe('coverage', () => {
  it('search responses name the accounts actually searched and flag disconnected sources', async () => {
    const { body } = await invoke(messagesRouter, 'get', '/search', { query: { q: 'symbiosis' } });
    const cov = body.coverage as {
      accountsSearched: Array<{ source: string; accountId: string }>;
      sourcesSearched: string[];
      sourcesUnavailable: Array<{ source: string; status: string; detail: string }>;
      visibility: string;
    };
    expect(cov.accountsSearched.some((a) => a.source === 'telegram' && a.accountId === '111')).toBe(true);
    expect(cov.sourcesSearched).toContain('telegram');
    // No connection manager is live in tests: sources must be flagged, and a
    // source with no account must say "never connected" rather than nothing.
    const twitter = cov.sourcesUnavailable.find((u) => u.source === 'twitter');
    expect(twitter).toBeDefined();
    expect(twitter!.detail).toContain('never been connected');
    expect(cov.visibility).toContain('Only accounts connected to this Conduit hub');
  });

  it('messages responses carry coverage too', async () => {
    const { body } = await invoke(messagesRouter, 'get', '/messages', { query: { source: 'telegram', limit: '5' } });
    expect(body.coverage).toBeDefined();
    const cov = body.coverage as { sourcesSearched: string[] };
    expect(cov.sourcesSearched).toEqual(['telegram']);
  });
});
