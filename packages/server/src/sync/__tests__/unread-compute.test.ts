/**
 * unread-compute.test.ts
 *
 * Tests for the server-side unread count logic.
 * Uses pure functions extracted from unread.ts that can be exercised
 * without a real SQLite database.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure replicas of the server-side logic (from unread.ts)
// ---------------------------------------------------------------------------

/** Mute state map keyed as "source:chatId". */
type MuteMap = Map<string, boolean>;

/** Read cursor map keyed as "source:chatId" → ISO timestamp. */
type ReadMap = Map<string, string>;

interface MessageRow {
  source: string;
  chatId: string;
  timestamp: string;
}

/**
 * Count unread messages for a chat: messages with timestamp > last_read_at.
 * Null last_read_at means "never read" → all messages are unread.
 */
function countUnread(messages: MessageRow[], source: string, chatId: string, lastReadAt: string | null): number {
  const since = lastReadAt ?? '1970-01-01T00:00:00.000Z';
  return messages.filter(
    (m) => m.source === source && m.chatId === chatId && m.timestamp > since,
  ).length;
}

/**
 * Compute unread entries for all chats, mirroring computeAllUnreads() logic.
 */
function computeUnreads(
  messages: MessageRow[],
  readMap: ReadMap,
  muteMap: MuteMap,
): Array<{ source: string; chatId: string; count: number; isMuted: boolean }> {
  // Collect distinct source:chatId pairs from messages
  const chats = new Set<string>(messages.map((m) => `${m.source}:${m.chatId}`));
  // Also include chats with a mute entry but no messages
  for (const key of muteMap.keys()) chats.add(key);

  return [...chats].map((key) => {
    const colonIdx = key.indexOf(':');
    const source = key.slice(0, colonIdx);
    const chatId = key.slice(colonIdx + 1);
    const lastReadAt = readMap.get(key) ?? null;
    const isMuted = muteMap.get(key) ?? false;
    const count = countUnread(messages, source, chatId, lastReadAt);
    return { source, chatId, count, isMuted };
  });
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function msg(source: string, chatId: string, timestamp: string): MessageRow {
  return { source, chatId, timestamp };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('countUnread', () => {
  const messages = [
    msg('discord', 'ch1', '2024-01-01T10:00:00Z'),
    msg('discord', 'ch1', '2024-01-01T11:00:00Z'),
    msg('discord', 'ch1', '2024-01-01T12:00:00Z'),
    msg('discord', 'ch2', '2024-01-01T10:00:00Z'),
  ];

  it('null lastReadAt → all messages are unread', () => {
    expect(countUnread(messages, 'discord', 'ch1', null)).toBe(3);
  });

  it('lastReadAt before all messages → all unread', () => {
    expect(countUnread(messages, 'discord', 'ch1', '2024-01-01T09:00:00Z')).toBe(3);
  });

  it('lastReadAt after first message → 2 unread', () => {
    expect(countUnread(messages, 'discord', 'ch1', '2024-01-01T10:30:00Z')).toBe(2);
  });

  it('lastReadAt at or after last message → 0 unread', () => {
    expect(countUnread(messages, 'discord', 'ch1', '2024-01-01T12:00:00Z')).toBe(0);
    expect(countUnread(messages, 'discord', 'ch1', '2024-01-01T13:00:00Z')).toBe(0);
  });

  it('different chatId is not counted', () => {
    expect(countUnread(messages, 'discord', 'ch2', null)).toBe(1);
  });

  it('different source is not counted', () => {
    expect(countUnread(messages, 'slack', 'ch1', null)).toBe(0);
  });
});

describe('computeUnreads', () => {
  it('returns correct counts for multiple chats', () => {
    const messages = [
      msg('discord', 'ch1', '2024-01-01T10:00:00Z'),
      msg('discord', 'ch1', '2024-01-01T11:00:00Z'),
      msg('discord', 'ch2', '2024-01-01T10:00:00Z'),
    ];
    const readMap: ReadMap = new Map([
      ['discord:ch1', '2024-01-01T10:30:00Z'], // read after first
    ]);
    const muteMap: MuteMap = new Map();

    const results = computeUnreads(messages, readMap, muteMap);
    const ch1 = results.find((r) => r.chatId === 'ch1');
    const ch2 = results.find((r) => r.chatId === 'ch2');

    expect(ch1?.count).toBe(1); // only the second message is unread
    expect(ch2?.count).toBe(1); // never read
  });

  it('muted chats still have counts (muting is a display concern, not a count concern)', () => {
    const messages = [
      msg('discord', 'muted-ch', '2024-01-01T10:00:00Z'),
      msg('discord', 'muted-ch', '2024-01-01T11:00:00Z'),
    ];
    const readMap: ReadMap = new Map();
    const muteMap: MuteMap = new Map([['discord:muted-ch', true]]);

    const results = computeUnreads(messages, readMap, muteMap);
    const ch = results.find((r) => r.chatId === 'muted-ch');
    expect(ch?.count).toBe(2);
    expect(ch?.isMuted).toBe(true);
  });

  it('never-read chat → count = all messages for that chat', () => {
    const messages = [
      msg('slack', 'sl1', '2024-01-01T08:00:00Z'),
      msg('slack', 'sl1', '2024-01-01T09:00:00Z'),
      msg('slack', 'sl1', '2024-01-01T10:00:00Z'),
    ];
    const results = computeUnreads(messages, new Map(), new Map());
    const sl1 = results.find((r) => r.source === 'slack' && r.chatId === 'sl1');
    expect(sl1?.count).toBe(3);
  });

  it('read after all messages → count = 0', () => {
    const messages = [
      msg('discord', 'ch1', '2024-01-01T10:00:00Z'),
    ];
    const readMap: ReadMap = new Map([['discord:ch1', '2024-01-01T12:00:00Z']]);
    const results = computeUnreads(messages, readMap, new Map());
    expect(results.find((r) => r.chatId === 'ch1')?.count).toBe(0);
  });

  it('empty messages → empty result (unless mute entries exist)', () => {
    const results = computeUnreads([], new Map(), new Map());
    expect(results).toHaveLength(0);
  });

  it('mute entry with no messages → still included with count 0', () => {
    const muteMap: MuteMap = new Map([['discord:ghost-ch', true]]);
    const results = computeUnreads([], new Map(), muteMap);
    const entry = results.find((r) => r.chatId === 'ghost-ch');
    expect(entry?.count).toBe(0);
    expect(entry?.isMuted).toBe(true);
  });

  it('isMuted defaults to false when not in muteMap', () => {
    const messages = [msg('discord', 'ch1', '2024-01-01T10:00:00Z')];
    const results = computeUnreads(messages, new Map(), new Map());
    expect(results[0]?.isMuted).toBe(false);
  });
});
