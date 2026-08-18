/**
 * Auth regression tests.
 *
 * The critical invariant: a presented X-API-Key MUST be validated everywhere.
 * A junk key must never bypass UI login (ui-auth) nor be demoted to the
 * trusted 'ui' actor (optionalAuth) — both were real vulnerabilities.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { AuthedRequest } from '../auth/middleware.js';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-auth-test-')),
  'test.db',
);

const { runMigrations, getDb } = await import('../db/client.js');
const { optionalAuth, apiKeyAuth, uiOnlyAuth, hashKey } =
  await import('../auth/middleware.js');
const { uiAuthMiddleware } = await import('../api/ui-auth.js');
const { isReadEnabled, isSendEnabled, isApprovalRequired, requireRead } =
  await import('../api/permissions-utils.js');
const schema = await import('../db/schema.js');

const VALID_KEY = 'sk-arb-test-valid-key';
let validKeyId = 0;

function mockReq(opts: {
  headers?: Record<string, string>;
  path?: string;
  cookies?: Record<string, string>;
} = {}): Request {
  return {
    headers: opts.headers ?? {},
    path: opts.path ?? '/api/messages',
    cookies: opts.cookies ?? {},
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
  } as unknown as Request;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    cookie() { return this; },
    clearCookie() { return this; },
    setHeader() { return this; },
  };
  return res as typeof res & Response;
}

function enableUiLogin(): void {
  const db = getDb();
  const value = JSON.stringify({
    password: { enabled: true, sessionDurationHours: 24, passwordHash: '$2a$10$x' },
    totp: { enabled: false, sessionDurationHours: 0 },
    passkey: { enabled: false, sessionDurationHours: 0 },
  });
  db.insert(schema.settings)
    .values({ key: 'ui.auth', value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}

beforeAll(async () => {
  await runMigrations();
  const db = getDb();
  const key = db.insert(schema.apiKeys).values({
    name: 'test-key',
    keyHash: hashKey(VALID_KEY),
    keyPrefix: VALID_KEY.slice(0, 12),
    createdAt: new Date().toISOString(),
  }).returning().get();
  validKeyId = key.id;
  enableUiLogin();
});

describe('optionalAuth', () => {
  it('rejects an invalid API key with 401 instead of demoting to ui actor', () => {
    const req = mockReq({ headers: { 'x-api-key': 'junk-value' } });
    const res = mockRes();
    let called = false;
    optionalAuth(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked API key', () => {
    const db = getDb();
    const revoked = db.insert(schema.apiKeys).values({
      name: 'revoked',
      keyHash: hashKey('sk-arb-revoked'),
      keyPrefix: 'sk-arb-revok',
      createdAt: new Date().toISOString(),
      revokedAt: new Date().toISOString(),
    }).returning().get();
    expect(revoked.id).toBeGreaterThan(0);

    const req = mockReq({ headers: { 'x-api-key': 'sk-arb-revoked' } });
    const res = mockRes();
    let called = false;
    optionalAuth(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('attaches the api actor for a valid key', () => {
    const req = mockReq({ headers: { 'x-api-key': VALID_KEY } });
    const res = mockRes();
    let called = false;
    optionalAuth(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect((req as AuthedRequest).actor).toBe('api');
    expect((req as AuthedRequest).apiKey?.id).toBe(validKeyId);
  });

  it('falls through to the ui actor only when no key header is present', () => {
    const req = mockReq();
    const res = mockRes();
    let called = false;
    optionalAuth(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect((req as AuthedRequest).actor).toBe('ui');
  });
});

describe('apiKeyAuth', () => {
  it('requires a key when required=true', () => {
    const res = mockRes();
    let called = false;
    apiKeyAuth(true)(mockReq(), res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

describe('uiOnlyAuth', () => {
  it('rejects API key callers outright', () => {
    const res = mockRes();
    let called = false;
    uiOnlyAuth(mockReq({ headers: { 'x-api-key': VALID_KEY } }), res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe('uiAuthMiddleware (login enabled)', () => {
  it('rejects a junk X-API-Key instead of bypassing login', () => {
    const req = mockReq({ headers: { 'x-api-key': 'anything-at-all' } });
    const res = mockRes();
    let called = false;
    uiAuthMiddleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('allows a valid API key through', () => {
    const req = mockReq({ headers: { 'x-api-key': VALID_KEY } });
    const res = mockRes();
    let called = false;
    uiAuthMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('401s unauthenticated /api requests', () => {
    const req = mockReq({ path: '/api/messages' });
    const res = mockRes();
    let called = false;
    uiAuthMiddleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { loginRequired?: boolean }).loginRequired).toBe(true);
  });

  it('lets the static SPA shell load so the login page can render', () => {
    const req = mockReq({ path: '/assets/index.js' });
    const res = mockRes();
    let called = false;
    uiAuthMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('leaves /api/ui-auth and /api/skill public', () => {
    for (const p of ['/api/ui-auth/status', '/api/skill']) {
      const res = mockRes();
      let called = false;
      uiAuthMiddleware(mockReq({ path: p }), res, () => { called = true; });
      expect(called, p).toBe(true);
    }
  });
});

describe('permission toggles', () => {
  it('ui actor is never read-restricted', () => {
    expect(isReadEnabled('slack', null)).toBe(true);
    expect(isReadEnabled('slack', undefined)).toBe(true);
  });

  it('per-key override beats the global readEnabled', () => {
    const db = getDb();
    db.update(schema.permissions)
      .set({ readEnabled: false })
      .where(eq(schema.permissions.service, 'slack'))
      .run();
    expect(isReadEnabled('slack', validKeyId)).toBe(false);

    db.insert(schema.apiKeyPermissions).values({
      apiKeyId: validKeyId,
      service: 'slack',
      readEnabled: true,
    }).run();
    expect(isReadEnabled('slack', validKeyId)).toBe(true);
  });

  it('per-key override beats the global sendEnabled and requireApproval', () => {
    const db = getDb();
    db.update(schema.permissions)
      .set({ sendEnabled: false, requireApproval: true })
      .where(eq(schema.permissions.service, 'telegram'))
      .run();
    expect(isSendEnabled('telegram', validKeyId)).toBe(false);
    expect(isApprovalRequired('telegram', validKeyId)).toBe(true);

    db.insert(schema.apiKeyPermissions).values({
      apiKeyId: validKeyId,
      service: 'telegram',
      sendEnabled: true,
      requireApproval: false,
    }).run();
    expect(isSendEnabled('telegram', validKeyId)).toBe(true);
    expect(isApprovalRequired('telegram', validKeyId)).toBe(false);
  });

  it('requireRead 403s a disabled key and passes the ui actor', () => {
    const db = getDb();
    db.update(schema.permissions)
      .set({ readEnabled: false })
      .where(eq(schema.permissions.service, 'discord'))
      .run();

    const middleware = requireRead('discord');

    const apiReq = mockReq() as AuthedRequest;
    apiReq.actor = 'api';
    apiReq.apiKey = { id: validKeyId, name: 'test-key' };
    const res = mockRes();
    let called = false;
    middleware(apiReq, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);

    const uiReq = mockReq() as AuthedRequest;
    uiReq.actor = 'ui';
    const res2 = mockRes();
    let called2 = false;
    middleware(uiReq, res2, () => { called2 = true; });
    expect(called2).toBe(true);
  });
});
