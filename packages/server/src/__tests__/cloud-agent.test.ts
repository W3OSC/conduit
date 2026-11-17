/**
 * Cloud-agent pure-function tests: reconnect backoff schedule, the /api/*
 * path allowlist, config loading (incl. the fail-loud partial-config case),
 * and event-payload slimming (never leaks a message body).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextBackoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from '../cloud/backoff.js';
import { isAllowedJobPath, executeHttpJob } from '../cloud/jobs.js';
import { loadCloudAgentConfig } from '../cloud/config.js';
import { shouldRelayEvent, slimEventPayload } from '../cloud/events.js';

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
