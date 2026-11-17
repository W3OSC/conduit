/**
 * Outbox integrity tests — the atomic status transitions that prevent
 * double-sending, and idempotency-key / cloudJobId deduplication.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-outbox-test-')),
  'test.db',
);

const { runMigrations, getDb } = await import('../db/client.js');
const outboxModule = await import('../api/outbox.js');
const { atomicStatusFlip, findByIdempotencyKey, findByCloudJobId } = outboxModule;
const outboxRouter = outboxModule.default;
const schema = await import('../db/schema.js');

function insertItem(overrides: Partial<typeof schema.outbox.$inferInsert> = {}) {
  const db = getDb();
  return db.insert(schema.outbox).values({
    source: 'slack',
    recipientId: 'C123',
    recipientName: 'general',
    content: 'hello',
    status: 'pending',
    requester: 'api',
    createdAt: new Date().toISOString(),
    ...overrides,
  }).returning().get();
}

const app = express();
app.use(express.json());
app.use('/outbox', outboxRouter);

let server: Server;
let base: string;

function postOutbox(body: unknown): Promise<Response> {
  return fetch(`${base}/outbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await runMigrations();
  // Required for POST /outbox to get past the sendEnabled gate; requireApproval
  // stays at its default (true) so these requests never attempt a real dispatch.
  // Default data seeding may have already inserted a 'slack' row, so upsert.
  getDb().insert(schema.permissions).values({ service: 'slack', sendEnabled: true })
    .onConflictDoUpdate({ target: schema.permissions.service, set: { sendEnabled: true } })
    .run();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

describe('atomicStatusFlip', () => {
  it('flips a pending item exactly once — the double-send guard', () => {
    const item = insertItem();
    const first = atomicStatusFlip(item.id, 'pending', { status: 'approved', approvedAt: new Date().toISOString() });
    const second = atomicStatusFlip(item.id, 'pending', { status: 'approved', approvedAt: new Date().toISOString() });
    expect(first).toBe(true);
    expect(second).toBe(false);

    const row = getDb().select().from(schema.outbox).where(eq(schema.outbox.id, item.id)).get();
    expect(row?.status).toBe('approved');
  });

  it('cannot flip a sent item back through the pending guard', () => {
    const item = insertItem({ status: 'sent' });
    expect(atomicStatusFlip(item.id, 'pending', { status: 'approved' })).toBe(false);
    const row = getDb().select().from(schema.outbox).where(eq(schema.outbox.id, item.id)).get();
    expect(row?.status).toBe('sent');
  });

  it('retry guard only matches failed items', () => {
    const failed = insertItem({ status: 'failed', errorMessage: 'boom' });
    expect(atomicStatusFlip(failed.id, 'failed', { status: 'approved', errorMessage: null })).toBe(true);
    // Second retry attempt loses the race.
    expect(atomicStatusFlip(failed.id, 'failed', { status: 'approved' })).toBe(false);

    const pending = insertItem();
    expect(atomicStatusFlip(pending.id, 'failed', { status: 'approved' })).toBe(false);
  });

  it('concurrent approve and reject cannot both win', () => {
    const item = insertItem();
    const approve = atomicStatusFlip(item.id, 'pending', { status: 'approved' });
    const reject = atomicStatusFlip(item.id, 'pending', { status: 'rejected' });
    expect([approve, reject].filter(Boolean)).toHaveLength(1);
  });
});

describe('idempotency keys', () => {
  it('finds an existing row by key', () => {
    const item = insertItem({ idempotencyKey: 'key-abc' });
    const found = findByIdempotencyKey('key-abc');
    expect(found?.id).toBe(item.id);
    expect(findByIdempotencyKey('missing-key')).toBeNull();
  });

  it('the unique index rejects a duplicate key', () => {
    insertItem({ idempotencyKey: 'key-dup' });
    expect(() => insertItem({ idempotencyKey: 'key-dup' })).toThrowError(/UNIQUE/i);
  });

  it('null keys are unconstrained (partial index)', () => {
    insertItem();
    insertItem();
    // No throw — multiple NULL idempotency keys coexist.
  });
});

describe('metadata.cloudJobId dedupe', () => {
  it('finds an existing row by metadata.cloudJobId', () => {
    const item = insertItem({ metadata: JSON.stringify({ cloudJobId: 'job-abc' }) });
    const found = findByCloudJobId('job-abc');
    expect(found?.id).toBe(item.id);
    expect(findByCloudJobId('job-missing')).toBeNull();
  });

  it('POST /outbox is idempotent across redelivery of the same cloudJobId', async () => {
    const countBefore = (
      getDb().select().from(schema.outbox).where(eq(schema.outbox.source, 'slack')).all()
    ).length;

    const body = {
      source: 'slack',
      recipient_id: 'C-redeliver',
      content: 'hello from the cloud bridge',
      metadata: { cloudJobId: 'cloud-job-123' },
    };

    const first = await postOutbox(body);
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { id: number; status: string };
    expect(firstJson.status).toBe('pending');

    // Simulate the cloud's at-least-once queue redelivering the same create.
    const second = await postOutbox(body);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { id: number };

    // Same row handed back — no new outbox item was queued.
    expect(secondJson.id).toBe(firstJson.id);
    const countAfter = (
      getDb().select().from(schema.outbox).where(eq(schema.outbox.source, 'slack')).all()
    ).length;
    expect(countAfter).toBe(countBefore + 1);
  });

  it('a request without metadata.cloudJobId is never deduped against one that has it', async () => {
    const withJobId = await postOutbox({
      source: 'slack',
      recipient_id: 'C-plain',
      content: 'has a job id',
      metadata: { cloudJobId: 'cloud-job-456' },
    });
    const withJobIdJson = (await withJobId.json()) as { id: number };

    const plain = await postOutbox({ source: 'slack', recipient_id: 'C-plain', content: 'has a job id' });
    const plainJson = (await plain.json()) as { id: number };

    expect(plainJson.id).not.toBe(withJobIdJson.id);
  });
});
