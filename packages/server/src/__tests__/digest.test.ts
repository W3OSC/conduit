/**
 * Digest endpoint tests — exercises the raw SQL (window functions, json_each,
 * read-state joins) against a real migrated database.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, Response } from 'express';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-digest-test-')),
  'test.db',
);

const { runMigrations, getDb } = await import('../db/client.js');
const digestRouter = (await import('../api/digest.js')).default;
const schema = await import('../db/schema.js');

// Pull the GET / handler out of the router stack (optionalAuth → trackAiCall → handler).
type Handler = (req: Request, res: Response, next: () => void) => void;
function getDigestHandler(): Handler {
  const layer = (digestRouter as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ handle: Handler }> } }>;
  }).stack.find((l) => l.route?.path === '/');
  const handlers = layer!.route!.stack;
  return handlers[handlers.length - 1]!.handle;
}

function runDigest(query: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = { query, headers: {}, actor: 'ui' } as unknown as Request;
    const res = {
      statusCode: 200,
      status(this: { statusCode: number }, code: number) { this.statusCode = code; return this; },
      json(this: { statusCode: number }, body: Record<string, unknown>) { resolve({ status: this.statusCode, body }); return this; },
    } as unknown as Response & { statusCode: number };
    getDigestHandler()(req, res, () => { /* no next */ });
  });
}

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  await runMigrations();
  const db = getDb();

  // My slack account + a channel where the OTHER person spoke last (needs reply)
  db.insert(schema.accounts).values({ source: 'slack', accountId: 'U_ME' }).run();
  db.insert(schema.slackMessages).values([
    { messageId: '1', channelId: 'D100', channelName: 'jane', userId: 'U_ME', userName: 'Me', content: 'hey jane', timestamp: iso(5 * HOUR) },
    { messageId: '2', channelId: 'D100', channelName: 'jane', userId: 'U_JANE', userName: 'Jane', content: 'can you review the doc?', timestamp: iso(2 * HOUR) },
    // A channel where I spoke last — must NOT need a reply
    { messageId: '3', channelId: 'D200', channelName: 'bob', userId: 'U_BOB', userName: 'Bob', content: 'ping', timestamp: iso(4 * HOUR) },
    { messageId: '4', channelId: 'D200', channelName: 'bob', userId: 'U_ME', userName: 'Me', content: 'pong', timestamp: iso(3 * HOUR) },
  ]).run();

  // Unread + read email
  db.insert(schema.gmailMessages).values([
    { gmailId: 'g1', threadId: 't1', subject: 'Invoice', fromName: 'Acme', fromAddress: 'billing@acme.io', snippet: 'Your invoice', isRead: false, internalDate: iso(1 * HOUR), labels: '["INBOX","UNREAD"]' },
    { gmailId: 'g2', threadId: 't2', subject: 'Old news', fromName: 'List', fromAddress: 'list@x.io', snippet: 'read already', isRead: true, internalDate: iso(9 * HOUR), labels: '["INBOX"]' },
  ]).run();

  // One upcoming event, one past event
  db.insert(schema.calendarEvents).values([
    { eventId: 'e1', calendarId: 'primary', title: 'Standup', startTime: new Date(NOW + 2 * HOUR).toISOString(), endTime: new Date(NOW + 3 * HOUR).toISOString(), attendees: '[{"email":"a"},{"email":"b"}]' },
    { eventId: 'e2', calendarId: 'primary', title: 'Yesterday', startTime: iso(20 * HOUR), endTime: iso(19 * HOUR) },
  ]).run();

  // A meeting note within the window
  db.insert(schema.meetNotes).values({
    noteId: 'n1', title: 'Roadmap sync', meetingDate: iso(30 * HOUR),
    summary: 'Action items: ship the digest endpoint. '.repeat(20),
  }).run();

  // Pending outbox item
  db.insert(schema.outbox).values({
    source: 'slack', recipientId: 'D100', recipientName: 'jane',
    content: 'draft reply', status: 'pending', requester: 'api', createdAt: iso(1 * HOUR),
  }).run();

  // Set the unread epoch well before the test messages so they count.
  db.insert(schema.settings)
    .values({ key: 'chat.unreadEpoch', value: iso(24 * HOUR), updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: iso(24 * HOUR) } })
    .run();
});

describe('GET /api/digest', () => {
  it('surfaces needs-reply chats, unread email, events, meetings, and outbox in one call', async () => {
    const { status, body } = await runDigest({ since: iso(12 * HOUR) });
    expect(status).toBe(200);

    const needsReply = body['needsReply'] as Array<{ source: string; chatId: string; lastMessage: { senderName: string } }>;
    expect(needsReply.some((n) => n.chatId === 'D100' && n.lastMessage.senderName === 'Jane')).toBe(true);
    expect(needsReply.some((n) => n.chatId === 'D200')).toBe(false);

    const unreadEmail = body['unreadEmail'] as { count: number; latest: Array<{ subject: string | null }> };
    expect(unreadEmail.count).toBe(1);
    expect(unreadEmail.latest[0]?.subject).toBe('Invoice');

    const events = body['upcomingEvents'] as Array<{ eventId: string; attendeeCount: number }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe('e1');
    expect(events[0]?.attendeeCount).toBe(2);

    const meetings = body['recentMeetings'] as Array<{ title: string | null; excerpt: string }>;
    expect(meetings).toHaveLength(1);
    expect(meetings[0]?.title).toBe('Roadmap sync');
    expect(meetings[0]?.excerpt.length).toBeLessThanOrEqual(300);

    const pending = body['pendingOutbox'] as { count: number };
    expect(pending.count).toBe(1);

    const unreadBySource = body['unreadBySource'] as Record<string, number>;
    // Jane's message in D100 is unread; my own messages never count.
    expect(unreadBySource['slack']).toBe(1);
    expect(unreadBySource['gmail']).toBe(1);
  });

  it('respects a chat read cursor — marking D100 read empties needsReply', async () => {
    const db = getDb();
    const nowIso = new Date().toISOString();
    db.insert(schema.chatReadState)
      .values({ source: 'slack', chatId: 'D100', lastReadAt: nowIso, updatedAt: nowIso })
      .onConflictDoUpdate({
        target: [schema.chatReadState.source, schema.chatReadState.chatId],
        set: { lastReadAt: nowIso, updatedAt: nowIso },
      }).run();

    const { body } = await runDigest({ since: iso(12 * HOUR) });
    const needsReply = body['needsReply'] as Array<{ chatId: string }>;
    expect(needsReply.some((n) => n.chatId === 'D100')).toBe(false);
    expect((body['unreadBySource'] as Record<string, number>)['slack']).toBe(0);
  });

  it('rejects a malformed since param (never reaches raw SQL)', async () => {
    const { status } = await runDigest({ since: "2024'; DROP TABLE outbox;--" });
    expect(status).toBe(400);
  });
});
