/**
 * AI-runner config tests — the settings-over-env resolution (cloud/
 * ai-config.ts), the /api/ai-runner routes (token never exposed, env-managed
 * 409s, hot bridge restart), the settings API's sensitive-list exclusion,
 * and the full round trip that matters: a token STORED via the API must
 * reach a spawned CLI's env as CLAUDE_CODE_OAUTH_TOKEN (the #23/#25 lesson —
 * test the whole transaction, not just the write).
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-ai-runner-test-')),
  'test.db',
);

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
// The routes hot-restart the bridge after writes; the real agent.ts dials a
// WebSocket, which has no business running here.
vi.mock('../cloud/agent.js', () => ({ restartCloudAgent: vi.fn() }));

const spawnMock = vi.mocked(spawn);
const { restartCloudAgent } = await import('../cloud/agent.js');
const { runMigrations, getDb } = await import('../db/client.js');
const { AI_RUNNER_SETTING_KEYS, resolveAiRunnerConfig } = await import('../cloud/ai-config.js');
const { discoverAiCapability, executeAiJob } = await import('../cloud/ai.js');
const aiRunnerRouter = (await import('../api/ai-runner.js')).default;
const settingsRouter = (await import('../api/settings.js')).default;
const schema = await import('../db/schema.js');

/** EventEmitter-backed stand-in for a spawned CLI child (see cloud-ai.test.ts). */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  stdin = {
    on: (): void => {},
    write: (_: string, cb?: () => void): boolean => {
      cb?.();
      return true;
    },
    end: (): void => {},
  };
  kill(): boolean {
    return true;
  }
}

function mockNextChild(opts: { stdout?: string; code: number | null }): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new FakeChild();
    queueMicrotask(() => {
      if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
      child.emit('close', opts.code);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

const app = express();
app.use(express.json());
app.use('/ai-runner', aiRunnerRouter);
app.use('/settings', settingsRouter);

let server: Server;
let base: string;

beforeAll(async () => {
  runMigrations();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  spawnMock.mockReset();
  // Default probe behavior: CLI "not installed" (exit 1). Tests that need a
  // working CLI queue their own children.
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    queueMicrotask(() => child.emit('close', 1));
    return child as unknown as ReturnType<typeof spawn>;
  });
  getDb().delete(schema.settings).run();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLOUD_AGENT_CLAUDE_BIN;
});

// ── resolution ────────────────────────────────────────────────────────────────

describe('resolveAiRunnerConfig', () => {
  const read = (vals: Record<string, unknown>) => (key: string) => vals[key];

  it('env wins over settings for bin and token; sources reported', () => {
    const cfg = resolveAiRunnerConfig(
      { CLOUD_AGENT_CLAUDE_BIN: '/env/claude', CLAUDE_CODE_OAUTH_TOKEN: 'env-tok' },
      read({ [AI_RUNNER_SETTING_KEYS.claudeBin]: '/db/claude', [AI_RUNNER_SETTING_KEYS.oauthToken]: 'db-tok' }),
    );
    expect(cfg).toMatchObject({ bin: '/env/claude', binSource: 'env', token: 'env-tok', tokenSource: 'env' });
  });

  it('falls back to settings, then defaults; blank strings do not count', () => {
    const fromDb = resolveAiRunnerConfig(
      { CLOUD_AGENT_CLAUDE_BIN: '  ' },
      read({ [AI_RUNNER_SETTING_KEYS.claudeBin]: '/db/claude', [AI_RUNNER_SETTING_KEYS.oauthToken]: 'db-tok' }),
    );
    expect(fromDb).toMatchObject({ bin: '/db/claude', binSource: 'settings', token: 'db-tok', tokenSource: 'settings' });

    const bare = resolveAiRunnerConfig({}, read({}));
    expect(bare).toMatchObject({ bin: 'claude', binSource: 'default', token: null, tokenSource: 'default', enabled: true });
  });

  it('enabled:false is the only off state', () => {
    expect(resolveAiRunnerConfig({}, read({ [AI_RUNNER_SETTING_KEYS.enabled]: false })).enabled).toBe(false);
    expect(resolveAiRunnerConfig({}, read({ [AI_RUNNER_SETTING_KEYS.enabled]: true })).enabled).toBe(true);
    expect(resolveAiRunnerConfig({}, read({})).enabled).toBe(true);
  });
});

describe('discoverAiCapability', () => {
  it('reports unavailable without probing when the runner is disabled in settings', async () => {
    getDb().insert(schema.settings)
      .values({ key: AI_RUNNER_SETTING_KEYS.enabled, value: 'false', updatedAt: new Date().toISOString() })
      .run();
    expect(await discoverAiCapability()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ── routes ────────────────────────────────────────────────────────────────────

async function put(body: unknown): Promise<Response> {
  return fetch(`${base}/ai-runner`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/ai-runner', () => {
  it('GET reports status without any token material', async () => {
    const res = await fetch(`${base}/ai-runner`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, bin: 'claude', binSource: 'default', tokenSet: false, cliAvailable: false });
    expect(JSON.stringify(body)).not.toContain('token"'); // only tokenSet/tokenSource keys
  });

  it('PUT stores token + bin, reports tokenSet, never echoes the token, restarts the bridge', async () => {
    mockNextChild({ stdout: '9.9.9 (Claude Code)', code: 0 }); // the PUT's status probe
    const res = await put({ token: 'sk-ant-oat01-secret', claudeBin: '/opt/claude' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      tokenSet: true,
      tokenSource: 'settings',
      bin: '/opt/claude',
      binSource: 'settings',
      cliAvailable: true,
      cliVersion: '9.9.9 (Claude Code)',
    });
    expect(JSON.stringify(body)).not.toContain('sk-ant-oat01-secret');
    expect(vi.mocked(restartCloudAgent)).toHaveBeenCalled();
  });

  it('GET /settings never exposes the stored token', async () => {
    await put({ token: 'sk-ant-oat01-secret' });
    const res = await fetch(`${base}/settings`);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('sk-ant-oat01-secret');
    expect(text).not.toContain('aiRunner.oauthToken');
  });

  it('PUT token:"" clears the stored token (fall back to host login)', async () => {
    await put({ token: 'sk-ant-oat01-secret' });
    const res = await put({ token: '' });
    expect(((await res.json()) as { tokenSet: boolean }).tokenSet).toBe(false);
  });

  it('PUT rejects env-managed fields with 409', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-tok';
    expect((await put({ token: 'x' })).status).toBe(409);
    // Other fields stay writable while the token is env-managed.
    expect((await put({ enabled: false })).status).toBe(200);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    process.env.CLOUD_AGENT_CLAUDE_BIN = '/env/claude';
    expect((await put({ claudeBin: '/x' })).status).toBe(409);
  });

  it('DELETE clears all stored runner config', async () => {
    await put({ token: 'sk-ant-oat01-secret', claudeBin: '/opt/claude', enabled: false });
    const res = await fetch(`${base}/ai-runner`, { method: 'DELETE' });
    const body = await res.json();
    expect(body).toMatchObject({ tokenSet: false, bin: 'claude', enabled: true });
  });
});

// ── the round trip: stored token → spawned CLI env ───────────────────────────

describe('token injection into spawned CLIs', () => {
  const job = { jobId: 'j1', mode: 'chat', model: 'haiku', prompt: 'hi', timeoutSecs: 60 } as const;
  const okEnvelope = JSON.stringify({ type: 'result', is_error: false, result: 'ok' });

  it('a token stored via the API reaches the CLI env as CLAUDE_CODE_OAUTH_TOKEN', async () => {
    await put({ token: 'sk-ant-oat01-secret' });
    mockNextChild({ stdout: okEnvelope, code: 0 });
    const result = await executeAiJob({ ...job });
    expect(result.ok).toBe(true);
    const [, , spawnOpts] = spawnMock.mock.calls.at(-1)!;
    expect((spawnOpts as { env: NodeJS.ProcessEnv }).env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-secret');
  });

  it('an env token wins over the stored one', async () => {
    await put({ token: 'db-tok' });
    mockNextChild({ stdout: okEnvelope, code: 0 });
    await executeAiJob({ ...job }, { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'env-tok' } });
    const [, , spawnOpts] = spawnMock.mock.calls.at(-1)!;
    expect((spawnOpts as { env: NodeJS.ProcessEnv }).env.CLAUDE_CODE_OAUTH_TOKEN).toBe('env-tok');
  });

  it('without any token the CLI env carries none (rides the host login)', async () => {
    mockNextChild({ stdout: okEnvelope, code: 0 });
    await executeAiJob({ ...job });
    const [, , spawnOpts] = spawnMock.mock.calls.at(-1)!;
    expect((spawnOpts as { env: NodeJS.ProcessEnv }).env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
