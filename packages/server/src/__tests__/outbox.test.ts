/**
 * Outbox integrity tests — the atomic status transitions that prevent
 * double-sending, and idempotency-key deduplication.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-outbox-test-')),
  'test.db',
);

const { runMigrations, getDb } = await import('../db/client.js');
const { atomicStatusFlip, findByIdempotencyKey } = await import('../api/outbox.js');
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

beforeAll(async () => {
  await runMigrations();
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
