import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeHttpJob } from '../cloud/jobs.js';

describe('cloud HTTP jobs with the real Fetch implementation', () => {
  const received: Array<{ method: string; body: string; contentType: string | undefined; key: string | undefined }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method!, body, contentType: req.headers['content-type'], key: req.headers['x-api-key'] as string | undefined });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ available: true }));
  });
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it.each([undefined, 'GET', 'get', 'HEAD', 'head'])('reads successfully with method %s and a serialized null payload', async (method) => {
    const result = await executeHttpJob({ kind: 'http', jobId: 'read', path: '/api/meet-notes', method, body: null }, port, 'test-key');
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(received.at(-1)).toEqual({ method: (method || 'GET').toUpperCase(), body: '', contentType: undefined, key: 'test-key' });
    if ((method || 'GET').toUpperCase() === 'HEAD') expect(result).toHaveProperty('body', null);
    else expect(result).toHaveProperty('body', { available: true });
  });

  it('omits a supplied object payload from a GET while preserving its query string', async () => {
    const result = await executeHttpJob({ kind: 'http', jobId: 'read', path: '/api/meet-notes?limit=2', body: { unused: true } }, port, 'test-key');
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(received.at(-1)).toMatchObject({ body: '', contentType: undefined });
  });

  it.each([null, { content: 'keep the message body' }])('preserves write payload %j', async (body) => {
    const result = await executeHttpJob({ kind: 'http', jobId: 'write', path: '/api/test', method: 'post', body }, port, 'test-key');
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(received.at(-1)).toEqual({ method: 'POST', body: JSON.stringify(body), contentType: 'application/json', key: 'test-key' });
  });
});
