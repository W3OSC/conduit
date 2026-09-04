/**
 * Source-filter (sync scope) tests — allowlist parsing, Telegram id
 * canonicalisation, and the generated SQL predicates run against a real
 * migrated database.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-source-filter-test-')),
  'test.db',
);

const { runMigrations, getDb } = await import('../db/client.js');
const schema = await import('../db/schema.js');
const {
  getSourceAllowlist, canonicalTelegramChatId, getTelegramAllowlistCanonical,
  sourceFilterPredicate, SOURCE_FILTER_KEYS,
} = await import('../sync/source-filters.js');
const { sql } = await import('drizzle-orm');

function setAllowlist(service: keyof typeof SOURCE_FILTER_KEYS, ids: string[] | null): void {
  const db = getDb();
  const key = SOURCE_FILTER_KEYS[service];
  if (ids === null) {
    db.delete(schema.settings).where(sql`key = ${key}`).run();
    return;
  }
  const value = JSON.stringify(ids);
  db.insert(schema.settings)
    .values({ key, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}

beforeAll(async () => {
  await runMigrations();
  const db = getDb();

  db.insert(schema.discordMessages).values([
    { messageId: 'd1', channelId: 'C_A', channelName: 'general', guildId: 'G_KEEP', guildName: 'Kept', content: 'hi', timestamp: '2026-01-01T00:00:00Z' },
    { messageId: 'd2', channelId: 'C_B', channelName: 'noise', guildId: 'G_DROP', guildName: 'Dropped', content: 'spam', timestamp: '2026-01-01T00:00:00Z' },
    { messageId: 'd3', channelId: 'C_DM', channelName: 'DM', guildId: null, guildName: null, content: 'dm', timestamp: '2026-01-01T00:00:00Z' },
  ]).run();

  db.insert(schema.slackMessages).values([
    { messageId: 's1', channelId: 'C111', channelName: 'kept', content: 'hi', timestamp: '2026-01-01T00:00:00Z' },
    { messageId: 's2', channelId: 'C222', channelName: 'dropped', content: 'spam', timestamp: '2026-01-01T00:00:00Z' },
    { messageId: 's3', channelId: 'D333', channelName: 'dm', content: 'dm', timestamp: '2026-01-01T00:00:00Z' },
  ]).run();

  db.insert(schema.telegramMessages).values([
    // Group stored under the "marked" encoding (-100 prefix) — allowlisted via its raw dialog id
    { messageId: 1, chatId: -1001234567890, chatName: 'kept-group', chatType: 'supergroup', content: 'hi', timestamp: '2026-01-01T00:00:00Z' },
    { messageId: 2, chatId: -987654, chatName: 'dropped-group', chatType: 'group', content: 'spam', timestamp: '2026-01-01T00:00:00Z' },
    { messageId: 3, chatId: 4242, chatName: 'alice', chatType: 'private', content: 'dm', timestamp: '2026-01-01T00:00:00Z' },
    // Legacy row without chat_type: positive small id = DM heuristic
    { messageId: 4, chatId: 5555, chatName: 'bob', chatType: null, content: 'dm2', timestamp: '2026-01-01T00:00:00Z' },
  ]).run();
});

function queryIds(table: string, idCol: string, predicate: string): string[] {
  const db = getDb();
  const rows = db.all<Record<string, unknown>>(
    sql.raw(`SELECT CAST(${idCol} AS TEXT) AS id FROM ${table} WHERE ${predicate} ORDER BY id`),
  );
  return rows.map((r) => String(r['id']));
}

describe('canonicalTelegramChatId', () => {
  it('normalises every encoding to the raw positive id', () => {
    expect(canonicalTelegramChatId('1234567890')).toBe('1234567890');
    expect(canonicalTelegramChatId('-987654')).toBe('987654');
    expect(canonicalTelegramChatId('-1001234567890')).toBe('1234567890');
    expect(canonicalTelegramChatId(1001234567890)).toBe('1234567890');
    expect(canonicalTelegramChatId('garbage')).toBe('garbage');
  });
});

describe('getSourceAllowlist', () => {
  it('returns null when unset or empty (= include everything)', () => {
    setAllowlist('discord', null);
    expect(getSourceAllowlist('discord')).toBeNull();
    setAllowlist('discord', []);
    expect(getSourceAllowlist('discord')).toBeNull();
  });

  it('returns the stored ids as a set', () => {
    setAllowlist('discord', ['G_KEEP']);
    expect([...getSourceAllowlist('discord')!]).toEqual(['G_KEEP']);
    setAllowlist('discord', null);
  });
});

describe('sourceFilterPredicate', () => {
  it('is a no-op without an allowlist', () => {
    setAllowlist('discord', null);
    expect(sourceFilterPredicate('discord')).toBe('1=1');
    expect(queryIds('discord_messages', 'channel_id', sourceFilterPredicate('discord'))).toHaveLength(3);
  });

  it('discord: keeps DMs and allowlisted guilds only', () => {
    setAllowlist('discord', ['G_KEEP']);
    expect(queryIds('discord_messages', 'channel_id', sourceFilterPredicate('discord')))
      .toEqual(['C_A', 'C_DM']);
    setAllowlist('discord', null);
  });

  it('slack: keeps 1:1 DMs and allowlisted conversations only', () => {
    setAllowlist('slack', ['C111']);
    expect(queryIds('slack_messages', 'channel_id', sourceFilterPredicate('slack')))
      .toEqual(['C111', 'D333']);
    setAllowlist('slack', null);
  });

  it('telegram: keeps private chats and allowlisted groups across id encodings', () => {
    // Allowlist uses the raw dialog id; the stored row uses the marked -100 form.
    setAllowlist('telegram', ['1234567890']);
    expect(queryIds('telegram_messages', 'chat_id', sourceFilterPredicate('telegram')))
      .toEqual(['-1001234567890', '4242', '5555']);
    expect(getTelegramAllowlistCanonical()!.has('1234567890')).toBe(true);
    setAllowlist('telegram', null);
  });

  it('drops ids that are not plain platform identifiers (no SQL injection)', () => {
    setAllowlist('slack', ["C111'); DROP TABLE slack_messages;--"]);
    const predicate = sourceFilterPredicate('slack');
    expect(predicate).not.toContain('DROP');
    // Malformed id is discarded → only DMs survive the filter.
    expect(queryIds('slack_messages', 'channel_id', predicate)).toEqual(['D333']);
    setAllowlist('slack', null);
  });
});
