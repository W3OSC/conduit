/**
 * Agent Slack endpoints — permission gating and history rows. The connection
 * manager is not connected in tests, so the dispatch-failure path is what a
 * live assertion can reach; gating runs before dispatch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-agent-slack-test-')),
  'test.db',
);

const { runMigrations, getDb } = await import('../db/client.js');
const agentSlackRouter = (await import('../api/agent-slack.js')).default;
const schema = await import('../db/schema.js');

const app = express();
app.use(express.json());
app.use('/agent/slack', agentSlackRouter);

let server: Server;
let base: string;

function call(route: string, body: unknown): Promise<Response> {
  return fetch(`${base}/agent/slack/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setSendEnabled(enabled: boolean) {
  const db = getDb();
  const existing = db.select().from(schema.permissions)
    .where(eq(schema.permissions.service, 'slack')).get();
  if (existing) {
    db.update(schema.permissions).set({ sendEnabled: enabled })
      .where(eq(schema.permissions.service, 'slack')).run();
  } else {
    db.insert(schema.permissions).values({ service: 'slack', sendEnabled: enabled }).run();
  }
}

beforeAll(async () => {
  await runMigrations();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

describe('POST /agent/slack/post', () => {
  it('400s on missing fields', async () => {
    const res = await call('post', { text: 'hi' });
    expect(res.status).toBe(400);
  });

  it('403s when sendEnabled is off', async () => {
    setSendEnabled(false);
    const res = await call('post', { channel_id: 'C123', text: 'hi' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/not enabled/);
  });

  it('400s on invalid attachment base64 (after gating)', async () => {
    setSendEnabled(true);
    const res = await call('post', {
      channel_id: 'C123', text: 'hi',
      attachments: [{ filename: 'a.txt', mime: 'text/plain', data: '!!!notbase64' }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/base64/);
  });

  it('records a failed sent-row with thread metadata when slack is not connected', async () => {
    setSendEnabled(true);
    const res = await call('post', { channel_id: 'C123', text: 'threaded reply', thread_ts: '1700000000.000100' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; id: number };
    expect(body.error).toMatch(/not connected/i);

    const db = getDb();
    const row = db.select().from(schema.outbox).where(eq(schema.outbox.id, body.id)).get();
    expect(row).toMatchObject({
      source: 'slack',
      recipientId: 'C123',
      content: 'threaded reply',
      status: 'failed',
    });
    expect(row?.sentAt).toBeNull();
    const meta = JSON.parse(row?.metadata ?? '{}') as Record<string, unknown>;
    expect(meta.agentSend).toBe(true);
    expect(meta.threadTs).toBe('1700000000.000100');
  });
});

describe('POST /agent/slack/reactions', () => {
  it('403s when sendEnabled is off', async () => {
    setSendEnabled(false);
    const res = await call('reactions', { channel_id: 'C123', ts: '1.2', emoji: 'eyes' });
    expect(res.status).toBe(403);
  });

  it('502s when slack is not connected (after gating)', async () => {
    setSendEnabled(true);
    const res = await call('reactions', { channel_id: 'C123', ts: '1.2', emoji: 'eyes' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/not connected/i);
  });
});

describe('GET /agent/slack/thread + /directory', () => {
  it('thread 400s without params and 502s when not connected', async () => {
    const bad = await fetch(`${base}/agent/slack/thread`);
    expect(bad.status).toBe(400);

    const res = await fetch(`${base}/agent/slack/thread?channel_id=C123&thread_ts=1.2`);
    expect(res.status).toBe(502);
  });

  it('directory 502s when not connected', async () => {
    const res = await fetch(`${base}/agent/slack/directory`);
    expect(res.status).toBe(502);
  });
});
