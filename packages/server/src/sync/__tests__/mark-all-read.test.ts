/**
 * mark-all-read.test.ts
 *
 * Tests for the "mark all chats read" logic.
 * Uses pure replicas of the server functions so no real DB is required.
 *
 * Design: Discord is excluded from mark-all-read (no read cursor tracking).
 * Platform write-backs are always attempted for Slack and Telegram.
 */

import { describe, it, expect } from 'vitest';

// ── Pure replicas ─────────────────────────────────────────────────────────────

/**
 * Pure replica of markAllChatsRead:
 * Upserts every non-Discord chat as read (INSERT OR REPLACE). Always overwrites.
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
    // Discord is excluded from read state tracking
    if (source === 'discord') continue;
    result.set(`${source}:${chatId}`, now);
    processed.push({ source, chatId });
  }
  return { readMap: result, processed };
}

/**
 * Count unread: messages after lastReadAt cursor (null = all unread).
 * Discord always returns 0.
 */
function countUnread(
  messages: Array<{ source: string; chatId: string; timestamp: string }>,
  source: string,
  chatId: string,
  lastReadAt: string | null,
): number {
  if (source === 'discord') return 0;
  const since = lastReadAt ?? '1970-01-01T00:00:00.000Z';
  return messages.filter(
    (m) => m.source === source && m.chatId === chatId && m.timestamp > since,
  ).length;
}

// ── Tests: markAllChatsRead ───────────────────────────────────────────────────

describe('markAllRead — mark all non-Discord chats as read (upsert)', () => {
  const now = '2024-06-01T10:00:00Z';

  it('marks every provided non-Discord chat as read', () => {
    const { readMap, processed } = markAllRead(new Map(), [
      { source: 'slack',   chatId: 'ch1' },
      { source: 'telegram', chatId: '999' },
    ], now);
    expect(readMap.get('slack:ch1')).toBe(now);
    expect(readMap.get('telegram:999')).toBe(now);
    expect(processed).toHaveLength(2);
  });

  it('Discord chats are excluded from mark-all-read', () => {
    const { readMap, processed } = markAllRead(new Map(), [
      { source: 'slack',   chatId: 'ch1' },
      { source: 'discord', chatId: 'disc-ch' },
      { source: 'telegram', chatId: '999' },
    ], now);
    expect(readMap.has('discord:disc-ch')).toBe(false);
    expect(processed.every((e) => e.source !== 'discord')).toBe(true);
    expect(processed).toHaveLength(2);
  });

  it('overwrites an older cursor (upsert, not insert-only)', () => {
    const existing = new Map([['slack:ch1', '2024-01-01T08:00:00Z']]);
    const { readMap } = markAllRead(existing, [{ source: 'slack', chatId: 'ch1' }], now);
    expect(readMap.get('slack:ch1')).toBe(now);
  });

  it('returns processed entries for platform API calls (Slack + Telegram only)', () => {
    const { processed } = markAllRead(new Map(), [
      { source: 'slack',   chatId: 'C111' },
      { source: 'discord', chatId: 'D222' },
      { source: 'telegram', chatId: '999' },
    ], now);
    expect(processed.map((e) => e.source).sort()).toEqual(['slack', 'telegram']);
  });

  it('empty chat list → no-op, returns empty processed', () => {
    const existing = new Map([['slack:ch1', '2024-01-01T08:00:00Z']]);
    const { readMap, processed } = markAllRead(existing, [], now);
    expect(readMap.get('slack:ch1')).toBe('2024-01-01T08:00:00Z'); // unchanged
    expect(processed).toHaveLength(0);
  });

  it('after marking all read, unread count is 0 for all eligible chats', () => {
    const messages = [
      { source: 'slack',   chatId: 'ch1', timestamp: '2024-01-01T09:00:00Z' },
      { source: 'slack',   chatId: 'ch1', timestamp: '2024-01-01T10:00:00Z' },
      { source: 'telegram', chatId: '999', timestamp: '2024-01-01T11:00:00Z' },
    ];
    const chats = [
      { source: 'slack',   chatId: 'ch1' },
      { source: 'telegram', chatId: '999' },
    ];
    const { readMap } = markAllRead(new Map(), chats, now);

    for (const { source, chatId } of chats) {
      const cursor = readMap.get(`${source}:${chatId}`) ?? null;
      expect(countUnread(messages, source, chatId, cursor)).toBe(0);
    }
  });

  it('Discord messages always have 0 unread regardless of cursor', () => {
    const messages = [
      { source: 'discord', chatId: 'ch1', timestamp: '2024-01-01T09:00:00Z' },
      { source: 'discord', chatId: 'ch1', timestamp: '2024-01-01T10:00:00Z' },
    ];
    expect(countUnread(messages, 'discord', 'ch1', null)).toBe(0);
    expect(countUnread(messages, 'discord', 'ch1', '2024-01-01T08:00:00Z')).toBe(0);
  });
});

// ── Tests: platform cursor is source of truth ─────────────────────────────────

describe('platform cursor seeding replaces old local cursor', () => {
  /**
   * Pure replica of seedReadState (upsert — always overwrites).
   */
  function seedReadState(
    existing: Map<string, string>,
    updates: Array<{ source: string; chatId: string; lastReadAt: string }>,
  ): Map<string, string> {
    const result = new Map(existing);
    for (const { source, chatId, lastReadAt } of updates) {
      result.set(`${source}:${chatId}`, lastReadAt);
    }
    return result;
  }

  it('platform last_read overwrites a stale local cursor', () => {
    // User previously marked as read locally at 8am
    const local = new Map([['slack:ch1', '2024-01-01T08:00:00Z']]);
    // Platform says actually read at 11am (user read it on mobile)
    const result = seedReadState(local, [
      { source: 'slack', chatId: 'ch1', lastReadAt: '2024-01-01T11:00:00Z' },
    ]);
    expect(result.get('slack:ch1')).toBe('2024-01-01T11:00:00Z');
  });

  it('platform cursor correctly determines unread count', () => {
    const readMap = seedReadState(new Map(), [
      { source: 'slack', chatId: 'ch1', lastReadAt: '2024-01-01T10:30:00Z' },
    ]);
    const messages = [
      { source: 'slack', chatId: 'ch1', timestamp: '2024-01-01T10:00:00Z' }, // read
      { source: 'slack', chatId: 'ch1', timestamp: '2024-01-01T11:00:00Z' }, // unread
    ];
    const cursor = readMap.get('slack:ch1') ?? null;
    expect(countUnread(messages, 'slack', 'ch1', cursor)).toBe(1);
  });
});
