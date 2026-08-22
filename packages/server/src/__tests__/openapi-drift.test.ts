/**
 * OpenAPI drift guard.
 *
 * The served spec is what agents plan against. When it says an endpoint exists
 * and the router does not register it, every agent that follows the spec gets a
 * 404; when the router grows an endpoint the spec never learns about, agents
 * simply cannot reach it. Both have shipped before — this test makes either one
 * a build failure.
 *
 * It walks the REAL Express router stack from `src/api/router.ts` (not a
 * hand-maintained list) and compares it against the REAL served document from
 * `src/api/openapi.ts`, in both directions.
 *
 * Paths are compared by shape, not by parameter name: `:id`, `*path` and
 * `{folderId}` all normalise to `{}`. A spec that calls a segment `{folderId}`
 * while the route calls it `:id` is a documentation nit, not a 404 — and the
 * generated `parameters` (which do use the real names) are what agents send.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-openapi-drift-test-')),
  'test.db',
);

// ── Mount-path capture ────────────────────────────────────────────────────────
//
// Express 5's Layer keeps only a compiled matcher, so a sub-router's mount
// prefix is not recoverable from the stack afterwards. Recording `use(path, r)`
// as it happens is exact and needs no internals — but it has to be installed
// BEFORE router.ts is imported, hence the dynamic import below.

const mountPaths = new WeakMap<object, string>();

{
  const routerProto = (express as unknown as { Router: { prototype: Record<string, unknown> } }).Router.prototype;
  const originalUse = routerProto['use'] as (...args: unknown[]) => unknown;
  routerProto['use'] = function patchedUse(this: unknown, ...args: unknown[]) {
    const [first, ...handlers] = args;
    if (typeof first === 'string') {
      for (const handler of handlers) {
        if (typeof handler === 'function' && 'stack' in handler) {
          mountPaths.set(handler as unknown as object, first);
        }
      }
    }
    return originalUse.apply(this, args);
  };
}

const apiRouter = (await import('../api/router.js')).default;
const { buildSpec } = await import('../api/openapi.js');

// ── Normalisation ─────────────────────────────────────────────────────────────

/** `/gdrive/folders/:folderId/files/*fileId` → `/gdrive/folders/{}/files/{}`. */
function normaliseExpressPath(p: string): string {
  return normalise(p.replace(/[:*][A-Za-z0-9_]+/g, '{}'));
}

/** `/gdrive/folders/{folderId}/files/{fileId}` → `/gdrive/folders/{}/files/{}`. */
function normaliseSpecPath(p: string): string {
  return normalise(p.replace(/\{[^}]*\}/g, '{}'));
}

function normalise(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

interface StackLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: StackLayer[] };
}

/** Every `METHOD /normalised/path` the router actually serves. */
function collectRegisteredRoutes(): Set<string> {
  const found = new Set<string>();
  const unmounted: string[] = [];

  function walk(router: { stack?: StackLayer[] }, prefix: string): void {
    for (const layer of router.stack ?? []) {
      if (layer.route) {
        const full = prefix + (layer.route.path === '/' ? '' : layer.route.path);
        for (const method of Object.keys(layer.route.methods)) {
          found.add(`${method.toUpperCase()} ${normaliseExpressPath(full)}`);
        }
        continue;
      }
      const sub = layer.handle;
      if (!sub?.stack) continue;
      const mount = mountPaths.get(sub as unknown as object);
      if (mount === undefined) {
        // A sub-router mounted without a path string, or mounted before this
        // test installed its hook. Surfacing it beats silently under-reporting.
        unmounted.push(String((sub as { name?: string }).name ?? 'anonymous'));
        continue;
      }
      walk(sub, prefix + (mount === '/' ? '' : mount));
    }
  }

  walk(apiRouter as unknown as { stack?: StackLayer[] }, '');
  if (unmounted.length) {
    throw new Error(`Could not resolve the mount path of ${unmounted.length} sub-router(s): ${unmounted.join(', ')}`);
  }
  return found;
}

/** Every `METHOD /normalised/path` the served document advertises. */
function collectSpecRoutes(spec: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const paths = spec['paths'] as Record<string, Record<string, unknown>>;
  for (const [specPath, item] of Object.entries(paths)) {
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      found.add(`${method.toUpperCase()} ${normaliseSpecPath(specPath)}`);
    }
  }
  return found;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

// ── Intentional omissions ─────────────────────────────────────────────────────
//
// The served document is deliberately "agent-relevant endpoints only" (see the
// header of openapi.ts). Everything below is a real route that an agent has no
// business calling, so it is excluded from the spec on purpose.
//
// An entry is either a path (`/metrics`) — matching that path and everything
// under it for any method — or `METHOD path` when only one verb on an otherwise
// documented path is admin-only. Every entry carries the reason it is here; an
// unexplained entry is how drift creeps back in.
const SPEC_OMISSIONS: readonly string[] = [
  '/health',                    // liveness probe for the container, not a tool
  '/openapi.json',              // the document describing the document
  '/connections',               // UI: connect/disconnect/status per service
  '/sync',                      // UI: manual sync triggers and cancellation
  '/service',                   // UI: destructive per-service data resets
  '/reset-app-data',            // UI: wipes the entire local database
  '/credentials',               // setup: raw platform credentials, never exposed
  '/google',                    // setup: Google OAuth credential management
  '/keys',                      // setup: API key issuing/revocation (bootstrap)
  '/permissions',               // setup: the very permissions that gate agents
  '/settings',                  // UI: app-level preferences
  '/audit-log',                 // UI: operator audit trail
  '/metrics',                   // UI: dashboard charts
  '/test',                      // UI: per-service connection smoke tests
  '/update',                    // UI: self-update status/apply
  '/ai',                        // UI: AI tool-call inspector
  '/discord',                   // UI: Discord guild picker/sync helpers
  '/slack',                     // UI: Slack channel picker
  '/telegram',                  // UI: Telegram chat picker

  // Service-scoped admin endpoints that live under an otherwise documented
  // prefix, so they must be listed individually.
  '/gmail/status',              // UI: connection badge
  '/gmail/sync',                // UI: manual sync trigger
  '/calendar/status',           // UI: connection badge
  '/calendar/sync',             // UI: manual sync trigger
  '/twitter/status',            // UI: connection badge
  '/twitter/sync',              // UI: manual DM sync trigger
  '/twitter/auth',              // setup: cookie paste / refresh / disconnect
  '/meet-notes/settings',       // UI: Drive-search toggle
  '/meet-notes/sync',           // UI: manual sync trigger
  '/meet-notes/{}/refresh',     // UI: re-fetch one note from Drive
  '/contacts/criteria',         // UI: contact-inclusion rules editor
  '/contacts/rebuild',          // UI: re-derive contacts from stored messages
  '/contacts/{}/{}/sync',       // UI: re-sync one platform's contacts
  '/contacts/{}/{}',            // UI-only DELETE (removes a local contact row)
  '/obsidian/vaults/{}/ssh-fingerprint', // setup: deploy-key fingerprint display
  '/smb/shares/{}/upload',      // UI: multipart upload (not JSON, not agent-facing)
  '/gdrive/folders/{}/upload',  // UI: multipart upload (not JSON, not agent-facing)
  '/gdrive/folders/{}/test',    // UI: verify Drive access for a folder config
  '/gdrive/folders/{}/sync',    // UI: manual cache refresh
  '/gdrive/available-folders',  // UI: folder picker during setup

  // Config CRUD sharing a path with a documented read endpoint — only the
  // mutating verbs are admin-only, hence the method-scoped entries.
  'PUT /smb/shares/{}',         // UI: edit an SMB share config
  'DELETE /smb/shares/{}',      // UI: remove an SMB share config
  'PUT /gdrive/folders/{}',     // UI: rename a whitelisted Drive folder
  'DELETE /gdrive/folders/{}',  // UI: un-whitelist a Drive folder
];

/** Does `omission` cover `METHOD /path`? */
function omissionMatches(omission: string, route: string): boolean {
  const spaceIndex = omission.indexOf(' ');
  if (spaceIndex !== -1) return route === omission;
  const routePath = route.slice(route.indexOf(' ') + 1);
  return routePath === omission || routePath.startsWith(`${omission}/`);
}

function isIntentionallyOmitted(route: string): boolean {
  return SPEC_OMISSIONS.some((omission) => omissionMatches(omission, route));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let registered: Set<string>;
let documented: Set<string>;

beforeAll(() => {
  registered = collectRegisteredRoutes();
  documented = collectSpecRoutes(buildSpec('http://localhost:3000'));
});

describe('OpenAPI spec ↔ Express router', () => {
  it('finds routes and spec paths at all (guards against a broken walker)', () => {
    expect(registered.size).toBeGreaterThan(50);
    expect(documented.size).toBeGreaterThan(50);
  });

  it('documents every registered /api route (or explicitly omits it)', () => {
    const undocumented = [...registered]
      .filter((route) => !documented.has(route))
      .filter((route) => !isIntentionallyOmitted(route))
      .sort();

    expect(
      undocumented,
      'These routes exist but are missing from GET /api/openapi.json. Either document them '
      + '(add a documentRoute(...) call or a hand-written paths entry) or add them to '
      + 'SPEC_OMISSIONS with a reason.',
    ).toEqual([]);
  });

  it('has a real route behind every documented path (no 404s for agents)', () => {
    const phantom = [...documented].filter((route) => !registered.has(route)).sort();

    expect(
      phantom,
      'GET /api/openapi.json advertises these operations but no route serves them — '
      + 'agents following the spec would get a 404.',
    ).toEqual([]);
  });

  it('keeps the omission allowlist honest (no stale entries)', () => {
    const stale = SPEC_OMISSIONS.filter(
      (omission) => ![...registered].some((route) => omissionMatches(omission, route)),
    );

    expect(stale, 'SPEC_OMISSIONS entries that no longer match any route — delete them.')
      .toEqual([]);
  });
});

describe('served document', () => {
  it('serialises to valid OpenAPI 3 with its metadata intact', () => {
    const spec = buildSpec('https://conduit.example') as Record<string, never>;

    expect(spec['openapi']).toBe('3.0.0');
    expect(spec['info']).toMatchObject({ title: 'Conduit', version: '1.0.0' });
    expect(spec['servers']).toEqual([{ url: 'https://conduit.example/api', description: 'Conduit API' }]);
    expect(spec['security']).toEqual([{ ApiKeyAuth: [] }]);
    expect(spec['components']['securitySchemes']['ApiKeyAuth']).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-API-Key' });

    // Must survive JSON serialisation — this is what res.json() does.
    expect(() => JSON.stringify(spec)).not.toThrow();
  });

  it('declares a parameter for every path template variable', () => {
    const spec = buildSpec('http://localhost:3000') as Record<string, never>;
    const violations: string[] = [];

    for (const [specPath, item] of Object.entries<Record<string, never>>(spec['paths'])) {
      const variables = [...specPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      if (!variables.length) continue;
      for (const [method, operation] of Object.entries<Record<string, never>>(item)) {
        if (!HTTP_METHODS.has(method)) continue;
        const declared = new Set(
          ((operation['parameters'] ?? []) as Array<{ in: string; name: string; required?: boolean }>)
            .filter((p) => p.in === 'path')
            .map((p) => p.name),
        );
        for (const variable of variables) {
          if (!declared.has(variable)) violations.push(`${method.toUpperCase()} ${specPath} → {${variable}}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('marks every path parameter required, as OpenAPI 3 demands', () => {
    const spec = buildSpec('http://localhost:3000') as Record<string, never>;
    const violations: string[] = [];

    for (const [specPath, item] of Object.entries<Record<string, never>>(spec['paths'])) {
      for (const [method, operation] of Object.entries<Record<string, never>>(item)) {
        if (!HTTP_METHODS.has(method)) continue;
        for (const parameter of (operation['parameters'] ?? []) as Array<{ in: string; name: string; required?: boolean }>) {
          if (parameter.in === 'path' && parameter.required !== true) {
            violations.push(`${method.toUpperCase()} ${specPath} → ${parameter.name}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
