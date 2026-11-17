/**
 * Cloud-agent tests: reconnect backoff schedule, the /api/* path allowlist,
 * config loading (incl. the fail-loud partial-config case), event-payload
 * slimming (never leaks a message body), and the startCloudAgent dispatch
 * glue — hello capability advertisement (probe-dependent, re-sent on
 * reconnect) and the kind:"ai" job branch (frame validation → executeAiJob →
 * result spread into job_result, incl. the malformed-frame reply shape).
 */

import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextBackoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from '../cloud/backoff.js';
import { isAllowedJobPath, executeHttpJob } from '../cloud/jobs.js';
import { loadCloudAgentConfig } from '../cloud/config.js';
import { shouldRelayEvent, slimEventPayload } from '../cloud/events.js';
import { discoverAiCapability, executeAiJob, type AiJobResult } from '../cloud/ai.js';
import { startCloudAgent } from '../cloud/agent.js';

// --- startCloudAgent harness: agent.ts dials out over `ws`, mints a DB-backed
// API key, and subscribes to the live broadcast hub — all faked here so the
// dispatch glue (hello/job_result frames) can be exercised in isolation. The
// ai.js mock is partial: parseAiJobFrame stays real (frame validation is part
// of the glue under test); only the probe and the executor are stubbed. ---

const wsHarness = vi.hoisted(() => {
  /** Minimal stand-in for a `ws` client socket (hand-rolled on/emit — no imports allowed in hoisted scope). */
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    url: string;
    sent: string[] = [];
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(event) ?? []) cb(...args);
    }
    send(data: string): void {
      this.sent.push(data);
    }
  }
  const instances: FakeWebSocket[] = [];
  return { FakeWebSocket, instances };
});

vi.mock('ws', () => ({ WebSocket: wsHarness.FakeWebSocket }));
vi.mock('../websocket/hub.js', () => ({ subscribeBroadcast: vi.fn() }));
vi.mock('../cloud/key.js', () => ({ ensureCloudAgentApiKey: vi.fn(() => 'sk-arb-test') }));
vi.mock('../cloud/ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cloud/ai.js')>();
  return { ...actual, discoverAiCapability: vi.fn(async () => true), executeAiJob: vi.fn() };
});

const discoverAiCapabilityMock = vi.mocked(discoverAiCapability);
const executeAiJobMock = vi.mocked(executeAiJob);

describe('nextBackoffMs', () => {
  it('doubles from a 1 minute base, capped at 16 minutes', () => {
    expect(nextBackoffMs(1)).toBe(1 * 60_000);
    expect(nextBackoffMs(2)).toBe(2 * 60_000);
    expect(nextBackoffMs(3)).toBe(4 * 60_000);
    expect(nextBackoffMs(4)).toBe(8 * 60_000);
    expect(nextBackoffMs(5)).toBe(16 * 60_000);
    expect(nextBackoffMs(6)).toBe(BACKOFF_MAX_MS); // would be 32min uncapped
    expect(nextBackoffMs(20)).toBe(BACKOFF_MAX_MS);
  });

  it('treats non-positive/fractional attempts as attempt 1', () => {
    expect(nextBackoffMs(0)).toBe(BACKOFF_BASE_MS);
    expect(nextBackoffMs(-5)).toBe(BACKOFF_BASE_MS);
    expect(nextBackoffMs(1.9)).toBe(BACKOFF_BASE_MS);
  });
});

describe('isAllowedJobPath', () => {
  it('allows only /api/* paths', () => {
    expect(isAllowedJobPath('/api/outbox')).toBe(true);
    expect(isAllowedJobPath('/api/')).toBe(true);
    expect(isAllowedJobPath('/api')).toBe(false); // missing trailing slash
    expect(isAllowedJobPath('/notapi/outbox')).toBe(false);
    expect(isAllowedJobPath('api/outbox')).toBe(false); // no leading slash
    expect(isAllowedJobPath('')).toBe(false);
    expect(isAllowedJobPath(undefined)).toBe(false);
  });
});

describe('loadCloudAgentConfig', () => {
  it('is off when neither URL nor token is set', () => {
    expect(loadCloudAgentConfig({})).toBeNull();
  });

  it('fails loud (logs) and stays off when only one of URL/token is set', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadCloudAgentConfig({ CLOUD_AGENT_URL: 'wss://example.test/ws' })).toBeNull();
    expect(loadCloudAgentConfig({ CLOUD_AGENT_TOKEN: 'tok' })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('is enabled by default once both URL and token are set', () => {
    const cfg = loadCloudAgentConfig({ CLOUD_AGENT_URL: 'wss://example.test/ws', CLOUD_AGENT_TOKEN: 'tok' });
    expect(cfg).toEqual({ url: 'wss://example.test/ws', token: 'tok', ownerEmail: '' });
  });

  it('carries ownerEmail through when set', () => {
    const cfg = loadCloudAgentConfig({
      CLOUD_AGENT_URL: 'wss://example.test/ws',
      CLOUD_AGENT_TOKEN: 'tok',
      CLOUD_AGENT_OWNER_EMAIL: 'joe@auditware.io',
    });
    expect(cfg?.ownerEmail).toBe('joe@auditware.io');
  });

  it('CLOUD_AGENT_ENABLED=0 forces it off even with both set', () => {
    expect(
      loadCloudAgentConfig({ CLOUD_AGENT_URL: 'wss://example.test/ws', CLOUD_AGENT_TOKEN: 'tok', CLOUD_AGENT_ENABLED: '0' }),
    ).toBeNull();
    expect(
      loadCloudAgentConfig({ CLOUD_AGENT_URL: 'wss://example.test/ws', CLOUD_AGENT_TOKEN: 'tok', CLOUD_AGENT_ENABLED: 'false' }),
    ).toBeNull();
  });

  it('CLOUD_AGENT_ENABLED=1 is explicit opt-in (same as default)', () => {
    expect(
      loadCloudAgentConfig({ CLOUD_AGENT_URL: 'wss://example.test/ws', CLOUD_AGENT_TOKEN: 'tok', CLOUD_AGENT_ENABLED: '1' }),
    ).not.toBeNull();
  });
});

describe('shouldRelayEvent', () => {
  it('relays outbox: and message: topics only', () => {
    expect(shouldRelayEvent({ type: 'outbox:new', data: {} })).toBe(true);
    expect(shouldRelayEvent({ type: 'outbox:updated', data: {} })).toBe(true);
    expect(shouldRelayEvent({ type: 'message:new', data: {} })).toBe(true);
    expect(shouldRelayEvent({ type: 'email:new', data: {} })).toBe(false);
    expect(shouldRelayEvent({ type: 'connection:status', data: {} })).toBe(false);
  });
});

describe('slimEventPayload', () => {
  it('keeps only identifier/status fields and drops message bodies', () => {
    const slim = slimEventPayload({
      source: 'discord',
      messageId: 'm1',
      channelId: 'c1',
      channelName: '#general',
      authorName: 'alice',
      content: 'the secret message body',
      timestamp: '2026-11-16T00:00:00Z',
      attachments: [{ url: 'https://example.test/f.png' }],
    });
    expect(slim).toEqual({ source: 'discord', messageId: 'm1', channelId: 'c1' });
    expect(slim).not.toHaveProperty('content');
    expect(slim).not.toHaveProperty('attachments');
  });

  it('keeps id/status/error for outbox updates', () => {
    expect(slimEventPayload({ id: 42, status: 'failed', error: 'boom' })).toEqual({
      id: 42,
      status: 'failed',
      error: 'boom',
    });
  });

  it('handles non-object data', () => {
    expect(slimEventPayload(null)).toEqual({});
    expect(slimEventPayload(undefined)).toEqual({});
    expect(slimEventPayload('x')).toEqual({});
  });
});

describe('executeHttpJob response bodies', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('base64-encodes a non-JSON, non-text response instead of parsing it as text', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake pdf bytes', 'utf8');
    const textSpy = vi.fn(async () => {
      throw new Error('text() must not be called for a binary response');
    });
    const fakeResponse = {
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
      arrayBuffer: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength),
      text: textSpy,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse));

    const result = await executeHttpJob(
      { jobId: 'job-pdf', kind: 'http', method: 'GET', path: '/api/gdrive/files/123/download' },
      3101,
      'sk-arb-test',
    );

    expect(result).toEqual({
      jobId: 'job-pdf',
      ok: true,
      status: 200,
      body: { bodyBase64: pdfBytes.toString('base64'), contentType: 'application/pdf' },
    });
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('still parses JSON responses exactly as before', async () => {
    const fakeResponse = {
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      text: async () => JSON.stringify({ hello: 'world' }),
      arrayBuffer: async () => { throw new Error('arrayBuffer() must not be called for JSON'); },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse));

    const result = await executeHttpJob({ jobId: 'job-json', kind: 'http', path: '/api/health' }, 3101, 'sk-arb-test');

    expect(result).toEqual({ jobId: 'job-json', ok: true, status: 200, body: { hello: 'world' } });
  });

  it('still passes through plain text/* responses as raw strings', async () => {
    const fakeResponse = {
      status: 200,
      headers: { get: () => 'text/plain; charset=utf-8' },
      text: async () => 'plain text body',
      arrayBuffer: async () => { throw new Error('arrayBuffer() must not be called for text/*'); },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse));

    const result = await executeHttpJob({ jobId: 'job-text', kind: 'http', path: '/api/some-text-route' }, 3101, 'sk-arb-test');

    expect(result).toEqual({ jobId: 'job-text', ok: true, status: 200, body: 'plain text body' });
  });
});

describe('executeHttpJob auth header', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchCapturingInit() {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{}',
    });
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  it('attaches X-API-Key by default (auth field absent)', async () => {
    const fetchSpy = stubFetchCapturingInit();

    await executeHttpJob({ jobId: 'job-keyed', kind: 'http', path: '/api/health' }, 3101, 'sk-arb-test');

    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['X-API-Key']).toBe('sk-arb-test');
  });

  it('omits X-API-Key when auth is "none" — required for uiOnlyAuth endpoints like chats/:source/:chatId/read', async () => {
    const fetchSpy = stubFetchCapturingInit();

    await executeHttpJob(
      { jobId: 'job-keyless', kind: 'http', method: 'POST', path: '/api/chats/telegram/123/read', auth: 'none' },
      3101,
      'sk-arb-test',
    );

    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers).not.toHaveProperty('X-API-Key');
    // Everything else about the request is unaffected by going keyless.
    expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:3101/api/chats/telegram/123/read');
    expect(init.headers.Accept).toBe('application/json');
  });
});

describe('startCloudAgent dispatch glue', () => {
  type FakeWs = InstanceType<typeof wsHarness.FakeWebSocket>;
  const ENV_KEYS = ['CLOUD_AGENT_URL', 'CLOUD_AGENT_TOKEN', 'CLOUD_AGENT_OWNER_EMAIL'] as const;
  let savedEnv: Record<string, string | undefined>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env['CLOUD_AGENT_URL'] = 'wss://example.test/ws';
    process.env['CLOUD_AGENT_TOKEN'] = 'tok';
    process.env['CLOUD_AGENT_OWNER_EMAIL'] = 'joe@auditware.io';
    wsHarness.instances.length = 0;
    discoverAiCapabilityMock.mockClear();
    discoverAiCapabilityMock.mockResolvedValue(true);
    executeAiJobMock.mockClear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };

  /** Boot the agent, surface the socket it dialed, and complete the open+hello handshake. */
  async function bootAndOpen(): Promise<FakeWs> {
    startCloudAgent();
    const sock = wsHarness.instances.at(-1)!;
    sock.emit('open');
    await flush(); // hello rides the (already-resolved) capability probe's .then
    return sock;
  }

  function frames(sock: FakeWs): Array<Record<string, unknown>> {
    return sock.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  function sendJobFrame(sock: FakeWs, frame: Record<string, unknown>): void {
    sock.emit('message', Buffer.from(JSON.stringify(frame)));
  }

  it('hello advertises ["messaging","ai"] when the CLI probe succeeds', async () => {
    const sock = await bootAndOpen();
    expect(frames(sock)).toEqual([
      { type: 'hello', deviceName: os.hostname(), ownerEmail: 'joe@auditware.io', capabilities: ['messaging', 'ai'] },
    ]);
  });

  it('hello advertises only ["messaging"] when the probe fails', async () => {
    discoverAiCapabilityMock.mockResolvedValue(false);
    const sock = await bootAndOpen();
    const hello = frames(sock).find((f) => f['type'] === 'hello');
    expect(hello?.['capabilities']).toEqual(['messaging']);
  });

  it('re-sends hello capabilities on reconnect without re-probing the CLI', async () => {
    const first = await bootAndOpen();
    expect(frames(first)[0]?.['capabilities']).toEqual(['messaging', 'ai']);

    // Drop the connection; the backoff timer (attempt 1 = BACKOFF_BASE_MS)
    // schedules a fresh connect() with a brand-new socket.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    first.readyState = 3; // CLOSED
    first.emit('close');
    await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
    vi.useRealTimers();

    expect(wsHarness.instances).toHaveLength(2);
    const second = wsHarness.instances[1]!;
    second.emit('open');
    await flush();

    const hello = frames(second).find((f) => f['type'] === 'hello');
    expect(hello?.['capabilities']).toEqual(['messaging', 'ai']);
    // Probed once per process — reconnects reuse the cached result.
    expect(discoverAiCapabilityMock).toHaveBeenCalledTimes(1);
  });

  it('kind:"ai": the frame is validated into an AiJob and the result is spread into job_result', async () => {
    const okResult: AiJobResult = {
      jobId: 'job-ai-1',
      ok: true,
      status: 200,
      body: { type: 'result', result: 'hi', total_cost_usd: 0.001 },
    };
    executeAiJobMock.mockResolvedValue(okResult);
    const sock = await bootAndOpen();

    sendJobFrame(sock, { type: 'job', jobId: 'job-ai-1', kind: 'ai', mode: 'chat', model: 'claude-haiku-4-5', prompt: 'p', timeoutSecs: 60 });
    await flush();

    expect(executeAiJobMock).toHaveBeenCalledTimes(1);
    expect(executeAiJobMock).toHaveBeenCalledWith({
      jobId: 'job-ai-1',
      mode: 'chat',
      model: 'claude-haiku-4-5',
      prompt: 'p',
      schema: undefined,
      timeoutSecs: 60,
    });
    const results = frames(sock).filter((f) => f['type'] === 'job_result');
    expect(results).toEqual([{ type: 'job_result', ...okResult }]);
  });

  it('kind:"ai": an error result\'s protocol body rides through to job_result', async () => {
    const errResult: AiJobResult = {
      jobId: 'job-ai-2',
      ok: false,
      error: 'claude CLI exceeded its timeout and was killed',
      body: { error: 'claude CLI exceeded its timeout and was killed', errorKind: 'timeout' },
    };
    executeAiJobMock.mockResolvedValue(errResult);
    const sock = await bootAndOpen();

    sendJobFrame(sock, { type: 'job', jobId: 'job-ai-2', kind: 'ai', mode: 'json', model: 'm1', prompt: 'p', schema: {}, timeoutSecs: 180 });
    await flush();

    const results = frames(sock).filter((f) => f['type'] === 'job_result');
    expect(results).toEqual([{ type: 'job_result', ...errResult }]);
  });

  it('kind:"ai": a malformed frame replies with the documented body and never invokes the CLI', async () => {
    const sock = await bootAndOpen();

    // mode:"turn" is a phase-2 kind parseAiJobFrame rejects.
    sendJobFrame(sock, { type: 'job', jobId: 'job-bad', kind: 'ai', mode: 'turn', model: 'm1', prompt: 'p', timeoutSecs: 60 });
    await flush();

    expect(executeAiJobMock).not.toHaveBeenCalled();
    const results = frames(sock).filter((f) => f['type'] === 'job_result');
    expect(results).toHaveLength(1);
    const reply = results[0]!;
    expect(reply['jobId']).toBe('job-bad');
    expect(reply['ok']).toBe(false);
    expect(reply['error']).toBe('malformed ai job frame (mode/model/prompt/timeoutSecs)');
    // Protocol body (docs/m5b-ai-runner.md) with the top-level error mirrored.
    expect(reply['body']).toEqual({ error: reply['error'], errorKind: 'cli_error' });
  });
});
