/**
 * mark-all-read.test.ts
 *
 * Tests for the "mark all chats read" and "seed missing read state" logic.
 * Uses pure replicas of the server functions so no real DB is required.
 */

import { describe, it, expect } from 'vitest';

// ── Pure replicas ─────────────────────────────────────────────────────────────

interface ReadEntry {
  source: string;
  chatId: string;
  lastReadAt: string;
}

/**
 * Pure replica of seedMissingReadState:
 * INSERT OR IGNORE — only inserts rows that don't already exist.
 * Returns the updated map.
 */
function seedMissing(
  existing: Map<string, string>,
  updates: Array<{ source: string; chatId: string; lastReadAt: string }>,
): Map<string, string> {
  const result = new Map(existing);
  for (const { source, chatId, lastReadAt } of updates) {
    const key = `${source}:${chatId}`;
    if (!result.has(key)) result.set(key, lastReadAt);
  }
  return result;
}

/**
 * Pure replica of markAllChatsRead:
 * Upserts every chat as read (INSERT OR REPLACE). Always overwrites.
 * Returns the updated map and the list of entries that were processed.
 */
function markAllRead(
  existing: Map<string, string>,
  chats: Array<{ source: string; chatId: string }>,
  now: string,
): { readMap: Map<string, string>; processed: Array<{ source: string; chatId: string }> } {
  const result = new Map(existing);
  const processed: Array<{ source: string; chatId: string }> = [];
  for (const { source, chatId } of chats) {
    result.set(`${source}:${chatId}`, now);
    processed.push({ source, chatId });
  }
  return { readMap: result, processed };
}

/**
 * Count unread: messages after lastReadAt cursor (null = all unread).
 * Used to verify that marking as read with a future timestamp → 0 unread.
 */
function countUnread(
  messages: Array<{ source: string; chatId: string; timestamp: string }>,
  source: string,
  chatId: string,
  lastReadAt: string | null,
): number {
  const since = lastReadAt ?? '1970-01-01T00:00:00.000Z';
  return messages.filter(
    (m) => m.source === source && m.chatId === chatId && m.timestamp > since,
  ).length;
}

// ── Tests: seedMissingReadState ───────────────────────────────────────────────

describe('seedMissing — INSERT OR IGNORE behaviour', () => {
  it('inserts entries that do not exist yet', () => {
    const now = '2024-01-01T12:00:00Z';
    const result = seedMissing(new Map(), [
      { source: 'slack',   chatId: 'ch1', lastReadAt: now },
      { source: 'discord', chatId: 'ch2', lastReadAt: now },
    ]);
    expect(result.get('slack:ch1')).toBe(now);
    expect(result.get('discord:ch2')).toBe(now);
  });

  it('does NOT overwrite an existing cursor', () => {
    const existing = new Map([['slack:ch1', '2024-01-01T08:00:00Z']]);
    const result = seedMissing(existing, [
      { source: 'slack', chatId: 'ch1', lastReadAt: '2024-01-01T12:00:00Z' },
    ]);
    expect(result.get('slack:ch1')).toBe('2024-01-01T08:00:00Z'); // unchanged
  });

  it('inserts new chats without touching existing ones', () => {
    const existing = new Map([['slack:ch1', '2024-01-01T08:00:00Z']]);
    const result = seedMissing(existing, [
      { source: 'slack',   chatId: 'ch1', lastReadAt: '2024-01-01T12:00:00Z' },
      { source: 'discord', chatId: 'ch2', lastReadAt: '2024-01-01T12:00:00Z' },
    ]);
    expect(result.get('slack:ch1')).toBe('2024-01-01T08:00:00Z'); // unchanged
    expect(result.get('discord:ch2')).toBe('2024-01-01T12:00:00Z'); // inserted
  });

  it('empty updates → read map unchanged', () => {
    const existing = new Map([['slack:ch1', '2024-01-01T08:00:00Z']]);
    const result = seedMissing(existing, []);
    expect(result).toEqual(existing);
  });

  it('empty existing + empty updates → empty result', () => {
    const result = seedMissing(new Map(), []);
    expect(result.size).toBe(0);
  });

  it('after seeding, messages before the seed timestamp count as read', () => {
    const seedTs = '2024-01-01T12:00:00Z';
    const readMap = seedMissing(new Map(), [
      { source: 'slack', chatId: 'ch1', lastReadAt: seedTs },
    ]);
    const messages = [
      { source: 'slack', chatId: 'ch1', timestamp: '2024-01-01T10:00:00Z' },
      { source: 'slack', chatId: 'ch1', timestamp: '2024-01-01T11:00:00Z' },
    ];
    const cursor = readMap.get('slack:ch1') ?? null;
    expect(countUnread(messages, 'slack', 'ch1', cursor)).toBe(0);
  });
});

// ── Tests: markAllChatsRead ───────────────────────────────────────────────────

describe('markAllRead — mark all chats as read (upsert)', () => {
  const now = '2024-06-01T10:00:00Z';

  it('marks every provided chat as read', () => {
    const { readMap, processed } = markAllRead(new Map(), [
      { source: 'slack',   chatId: 'ch1' },
      { source: 'discord', chatId: 'ch2' },
    ], now);
    expect(readMap.get('slack:ch1')).toBe(now);
    expect(readMap.get('discord:ch2')).toBe(now);
    expect(processed).toHaveLength(2);
  });

  it('overwrites an older cursor (upsert, not insert-only)', () => {
    const existing = new Map([['slack:ch1', '2024-01-01T08:00:00Z']]);
    const { readMap } = markAllRead(existing, [{ source: 'slack', chatId: 'ch1' }], now);
    expect(readMap.get('slack:ch1')).toBe(now);
  });

  it('returns processed entries for platform API calls', () => {
    const { processed } = markAllRead(new Map(), [
      { source: 'slack',   chatId: 'C111' },
      { source: 'discord', chatId: 'D222' },
      { source: 'telegram', chatId: '999' },
    ], now);
    expect(processed.map((e) => e.source).sort()).toEqual(['discord', 'slack', 'telegram']);
  });

  it('empty chat list → no-op, returns empty processed', () => {
    const existing = new Map([['slack:ch1', '2024-01-01T08:00:00Z']]);
    const { readMap, processed } = markAllRead(existing, [], now);
    expect(readMap.get('slack:ch1')).toBe('2024-01-01T08:00:00Z'); // unchanged
    expect(processed).toHaveLength(0);
  });

  it('after marking all read, unread count is 0 for all chats', () => {
    const messages = [
      { source: 'slack',   chatId: 'ch1', timestamp: '2024-01-01T09:00:00Z' },
      { source: 'slack',   chatId: 'ch1', timestamp: '2024-01-01T10:00:00Z' },
      { source: 'discord', chatId: 'ch2', timestamp: '2024-01-01T11:00:00Z' },
    ];
    const chats = [
      { source: 'slack',   chatId: 'ch1' },
      { source: 'discord', chatId: 'ch2' },
    ];
    const { readMap } = markAllRead(new Map(), chats, now);

    for (const { source, chatId } of chats) {
      const cursor = readMap.get(`${source}:${chatId}`) ?? null;
      expect(countUnread(messages, source, chatId, cursor)).toBe(0);
    }
  });
});
