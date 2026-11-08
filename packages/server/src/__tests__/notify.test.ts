/**
 * Internal notification endpoint — permission gating, legacy chat_id alias,
 * and sent/failed outbox history rows. Delivery goes through the connection
 * manager, which is not connected in tests, so the dispatch failure path is
 * what a live assertion can reach; gating runs before dispatch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-notify-test-')),
  'test.db',
);

const { runMigrations, getDb } = await import('../db/client.js');
const notifyRouter = (await import('../api/notify.js')).default;
const schema = await import('../db/schema.js');

const app = express();
app.use(express.json());
app.use('/notify', notifyRouter);

let server: Server;
let base: string;

function post(body: unknown): Promise<Response> {
  return fetch(`${base}/notify/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setSendEnabled(service: string, enabled: boolean) {
  const db = getDb();
  const existing = db.select().from(schema.permissions)
    .where(eq(schema.permissions.service, service)).get();
  if (existing) {
    db.update(schema.permissions).set({ sendEnabled: enabled })
      .where(eq(schema.permissions.service, service)).run();
  } else {
    db.insert(schema.permissions).values({ service, sendEnabled: enabled }).run();
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

describe('POST /notify/internal', () => {
  it('rejects unknown channels and missing targets', async () => {
    const bad = await post({ channel: 'gmail', target: 'x', message: 'hi' });
    expect(bad.status).toBe(400);

    const noTarget = await post({ channel: 'slack', message: 'hi' });
    expect(noTarget.status).toBe(400);
    expect(((await noTarget.json()) as { error: string }).error).toMatch(/target/);
  });

  it('403s when sendEnabled is off for the service', async () => {
    setSendEnabled('slack', false);
    const res = await post({ channel: 'slack', target: 'C123', message: 'hi' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/not enabled/);
  });

  it('accepts the legacy telegram chat_id alias and records a failed row when not connected', async () => {
    setSendEnabled('telegram', true);
    const res = await post({
      channel: 'telegram', chat_id: -4763647927, message: 'high-value lead', priority: 'high',
    });
    // No telegram connection in tests — dispatch fails, but AFTER gating:
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; id: number };
    expect(body.error).toMatch(/not connected/i);

    const db = getDb();
    const row = db.select().from(schema.outbox)
      .where(eq(schema.outbox.id, body.id)).get();
    expect(row).toMatchObject({
      source: 'telegram',
      recipientId: '-4763647927',
      content: 'high-value lead',
      status: 'failed',
    });
    expect(row?.sentAt).toBeNull();
  });
});
