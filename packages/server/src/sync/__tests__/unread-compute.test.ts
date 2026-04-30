/**
 * unread-compute.test.ts
 *
 * Tests for the server-side unread count logic.
 * Uses pure functions extracted from unread.ts that can be exercised
 * without a real SQLite database.
 *
 * Design: the platform is the source of truth. Discord is excluded from
 * unread tracking (no reliable read cursor API). Gmail uses per-thread
 * counts. Slack and Telegram use platform-seeded cursors.
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
 * Discord is excluded (returns 0) — no reliable read cursor available.
 */
function countUnread(messages: MessageRow[], source: string, chatId: string, lastReadAt: string | null): number {
  if (source === 'discord') return 0; // Discord unread tracking disabled
  const since = lastReadAt ?? '1970-01-01T00:00:00.000Z';
  return messages.filter(
    (m) => m.source === source && m.chatId === chatId && m.timestamp > since,
  ).length;
}

/**
 * Compute unread entries for all chats, mirroring computeAllUnreads() logic.
 * Discord entries are excluded from the result.
 */
function computeUnreads(
  messages: MessageRow[],
  readMap: ReadMap,
  muteMap: MuteMap,
): Array<{ source: string; chatId: string; count: number; isMuted: boolean }> {
  // Collect distinct source:chatId pairs from messages — exclude Discord
  const chats = new Set<string>(
    messages
      .filter((m) => m.source !== 'discord')
      .map((m) => `${m.source}:${m.chatId}`),
  );
  // Also include chats with a mute entry but no messages (exclude Discord)
  for (const key of muteMap.keys()) {
    if (!key.startsWith('discord:')) chats.add(key);
  }

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
// Tests — countUnread
// ---------------------------------------------------------------------------

describe('countUnread', () => {
  const messages = [
    msg('slack', 'ch1', '2024-01-01T10:00:00Z'),
    msg('slack', 'ch1', '2024-01-01T11:00:00Z'),
    msg('slack', 'ch1', '2024-01-01T12:00:00Z'),
    msg('slack', 'ch2', '2024-01-01T10:00:00Z'),
  ];

  it('null lastReadAt → all messages are unread', () => {
    expect(countUnread(messages, 'slack', 'ch1', null)).toBe(3);
  });

  it('lastReadAt before all messages → all unread', () => {
    expect(countUnread(messages, 'slack', 'ch1', '2024-01-01T09:00:00Z')).toBe(3);
  });

  it('lastReadAt after first message → 2 unread', () => {
    expect(countUnread(messages, 'slack', 'ch1', '2024-01-01T10:30:00Z')).toBe(2);
  });

  it('lastReadAt at or after last message → 0 unread', () => {
    expect(countUnread(messages, 'slack', 'ch1', '2024-01-01T12:00:00Z')).toBe(0);
    expect(countUnread(messages, 'slack', 'ch1', '2024-01-01T13:00:00Z')).toBe(0);
  });

  it('different chatId is not counted', () => {
    expect(countUnread(messages, 'slack', 'ch2', null)).toBe(1);
  });

  it('different source is not counted', () => {
    expect(countUnread(messages, 'telegram', 'ch1', null)).toBe(0);
  });

  it('Discord always returns 0 regardless of messages or cursor', () => {
    const discordMessages = [
      msg('discord', 'ch1', '2024-01-01T10:00:00Z'),
      msg('discord', 'ch1', '2024-01-01T11:00:00Z'),
    ];
    // Even with null cursor (all unread), Discord returns 0 — tracking is disabled
    expect(countUnread(discordMessages, 'discord', 'ch1', null)).toBe(0);
    expect(countUnread(discordMessages, 'discord', 'ch1', '2024-01-01T09:00:00Z')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — computeUnreads
// ---------------------------------------------------------------------------

describe('computeUnreads', () => {
  it('returns correct counts for multiple Slack chats', () => {
    const messages = [
      msg('slack', 'ch1', '2024-01-01T10:00:00Z'),
      msg('slack', 'ch1', '2024-01-01T11:00:00Z'),
      msg('slack', 'ch2', '2024-01-01T10:00:00Z'),
    ];
    const readMap: ReadMap = new Map([
      ['slack:ch1', '2024-01-01T10:30:00Z'], // read after first
    ]);
    const muteMap: MuteMap = new Map();

    const results = computeUnreads(messages, readMap, muteMap);
    const ch1 = results.find((r) => r.chatId === 'ch1');
    const ch2 = results.find((r) => r.chatId === 'ch2');

    expect(ch1?.count).toBe(1); // only the second message is unread
    expect(ch2?.count).toBe(1); // never read
  });

  it('Discord messages are excluded from results', () => {
    const messages = [
      msg('discord', 'ch1', '2024-01-01T10:00:00Z'),
      msg('discord', 'ch1', '2024-01-01T11:00:00Z'),
      msg('slack',   'sl1', '2024-01-01T10:00:00Z'),
    ];
    const results = computeUnreads(messages, new Map(), new Map());

    // No Discord entries in output
    expect(results.every((r) => r.source !== 'discord')).toBe(true);
    // Slack entry is present
    const sl1 = results.find((r) => r.source === 'slack' && r.chatId === 'sl1');
    expect(sl1?.count).toBe(1);
  });

  it('Discord mute entries do not appear in unread results', () => {
    const muteMap: MuteMap = new Map([['discord:guild-ch', true]]);
    const results = computeUnreads([], new Map(), muteMap);
    // Discord mute state is tracked but not in unread counts
    expect(results.every((r) => r.source !== 'discord')).toBe(true);
  });

  it('muted Slack chats still have counts (muting is a display concern, not a count concern)', () => {
    const messages = [
      msg('slack', 'muted-ch', '2024-01-01T10:00:00Z'),
      msg('slack', 'muted-ch', '2024-01-01T11:00:00Z'),
    ];
    const readMap: ReadMap = new Map();
    const muteMap: MuteMap = new Map([['slack:muted-ch', true]]);

    const results = computeUnreads(messages, readMap, muteMap);
    const ch = results.find((r) => r.chatId === 'muted-ch');
    expect(ch?.count).toBe(2);
    expect(ch?.isMuted).toBe(true);
  });

  it('never-read Slack chat → count = all messages for that chat', () => {
    const messages = [
      msg('slack', 'sl1', '2024-01-01T08:00:00Z'),
      msg('slack', 'sl1', '2024-01-01T09:00:00Z'),
      msg('slack', 'sl1', '2024-01-01T10:00:00Z'),
    ];
    const results = computeUnreads(messages, new Map(), new Map());
    const sl1 = results.find((r) => r.source === 'slack' && r.chatId === 'sl1');
    expect(sl1?.count).toBe(3);
  });

  it('platform-seeded cursor marks messages as read', () => {
    // Simulate fetchUnreadCounts seeding last_read from Slack/Telegram platform
    const messages = [
      msg('slack', 'ch1', '2024-01-01T10:00:00Z'),
      msg('slack', 'ch1', '2024-01-01T11:00:00Z'),
      msg('slack', 'ch1', '2024-01-01T12:00:00Z'),
    ];
    // Platform says last_read is after message 2 — only message 3 is unread
    const readMap: ReadMap = new Map([['slack:ch1', '2024-01-01T11:30:00Z']]);
    const results = computeUnreads(messages, readMap, new Map());
    expect(results.find((r) => r.chatId === 'ch1')?.count).toBe(1);
  });

  it('read after all messages → count = 0', () => {
    const messages = [
      msg('telegram', '12345', '2024-01-01T10:00:00Z'),
    ];
    const readMap: ReadMap = new Map([['telegram:12345', '2024-01-01T12:00:00Z']]);
    const results = computeUnreads(messages, readMap, new Map());
    expect(results.find((r) => r.chatId === '12345')?.count).toBe(0);
  });

  it('empty messages → empty result (unless mute entries exist for non-Discord)', () => {
    const results = computeUnreads([], new Map(), new Map());
    expect(results).toHaveLength(0);
  });

  it('non-Discord mute entry with no messages → still included with count 0', () => {
    const muteMap: MuteMap = new Map([['slack:ghost-ch', true]]);
    const results = computeUnreads([], new Map(), muteMap);
    const entry = results.find((r) => r.chatId === 'ghost-ch');
    expect(entry?.count).toBe(0);
    expect(entry?.isMuted).toBe(true);
  });

  it('isMuted defaults to false when not in muteMap', () => {
    const messages = [msg('slack', 'ch1', '2024-01-01T10:00:00Z')];
    const results = computeUnreads(messages, new Map(), new Map());
    expect(results[0]?.isMuted).toBe(false);
  });

  it('Telegram entries are included with correct counts', () => {
    const messages = [
      msg('telegram', '999', '2024-01-01T10:00:00Z'),
      msg('telegram', '999', '2024-01-01T11:00:00Z'),
    ];
    // readInboxMaxId lookup result — cursor set from platform
    const readMap: ReadMap = new Map([['telegram:999', '2024-01-01T10:30:00Z']]);
    const results = computeUnreads(messages, readMap, new Map());
    const entry = results.find((r) => r.source === 'telegram' && r.chatId === '999');
    expect(entry?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — platform cursor seeding (simulates Slack/Telegram fetchUnreadCounts)
// ---------------------------------------------------------------------------

describe('platform cursor seeding', () => {
  /**
   * Pure replica of seedReadState: always overwrites (upsert).
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

  it('seedReadState always overwrites existing cursor (platform is source of truth)', () => {
    const existing = new Map([['slack:ch1', '2024-01-01T08:00:00Z']]);
    // Platform says last_read is later — overwrite
    const result = seedReadState(existing, [
      { source: 'slack', chatId: 'ch1', lastReadAt: '2024-01-01T12:00:00Z' },
    ]);
    expect(result.get('slack:ch1')).toBe('2024-01-01T12:00:00Z');
  });

  it('after seeding from platform, prior messages are read', () => {
    const platformLastRead = '2024-01-01T12:00:00Z';
    const readMap = seedReadState(new Map(), [
      { source: 'slack', chatId: 'ch1', lastReadAt: platformLastRead },
    ]);
    const messages = [
      msg('slack', 'ch1', '2024-01-01T10:00:00Z'),
      msg('slack', 'ch1', '2024-01-01T11:00:00Z'),
    ];
    const cursor = readMap.get('slack:ch1') ?? null;
    expect(countUnread(messages, 'slack', 'ch1', cursor)).toBe(0);
  });

  it('messages after platform last_read are correctly counted as unread', () => {
    const platformLastRead = '2024-01-01T11:30:00Z'; // between msg 2 and msg 3
    const readMap = seedReadState(new Map(), [
      { source: 'telegram', chatId: '999', lastReadAt: platformLastRead },
    ]);
    const messages = [
      msg('telegram', '999', '2024-01-01T10:00:00Z'),
      msg('telegram', '999', '2024-01-01T11:00:00Z'),
      msg('telegram', '999', '2024-01-01T12:00:00Z'), // unread
    ];
    const cursor = readMap.get('telegram:999') ?? null;
    expect(countUnread(messages, 'telegram', '999', cursor)).toBe(1);
  });
});
