/**
 * Per-platform source-inclusion filters ("sync scope").
 *
 * Users can restrict each platform to an allowlist of sources; everything
 * outside the allowlist is omitted from sync, chats, digests, activity and
 * search. Direct messages are always included — the filter exists to mute
 * high-traffic group sources, not people.
 *
 *   discord.syncGuilds   — guild ids. DMs (guild_id IS NULL) always included.
 *   slack.syncChannels   — conversation ids (public/private channels, group
 *                          DMs). 1:1 DMs (D-prefixed ids) always included.
 *   telegram.syncChats   — chat ids for groups/supergroups/channels. Private
 *                          chats always included.
 *
 * Semantics: absent or empty allowlist = include everything (matches the
 * pre-existing discord.syncGuilds behaviour).
 *
 * Enforcement happens at BOTH layers:
 *   - ingest: the sync engines skip excluded sources entirely (no storage,
 *     no message:new broadcasts, no wasted API calls);
 *   - query: chats/digest/activity/search apply a SQL predicate, so a filter
 *     change takes effect immediately on already-stored history without a
 *     resync.
 */
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export const SOURCE_FILTER_KEYS = {
  discord: 'discord.syncGuilds',
  slack: 'slack.syncChannels',
  telegram: 'telegram.syncChats',
} as const;

export type FilterableService = keyof typeof SOURCE_FILTER_KEYS;

/** Read a platform's allowlist as stored. Null = no filter (include all). */
export function getSourceAllowlist(service: FilterableService): Set<string> | null {
  const db = getDb();
  const row = db.select().from(settings)
    .where(eq(settings.key, SOURCE_FILTER_KEYS[service])).get();
  if (!row) return null;
  try {
    const ids = JSON.parse(row.value) as string[];
    if (!Array.isArray(ids) || ids.length === 0) return null;
    return new Set(ids.map(String));
  } catch { return null; }
}

/**
 * Telegram chat ids appear in several encodings depending on where they came
 * from: dialogs expose raw positive ids, while message peers can be "marked"
 * (basic groups negative, channels/supergroups offset by 10^12 and/or
 * negated). Canonicalise to the raw positive id so allowlist membership is
 * stable across all of them.
 */
export function canonicalTelegramChatId(id: string | number): string {
  let n: bigint;
  try {
    n = typeof id === 'number' ? BigInt(Math.trunc(id)) : BigInt(String(id).trim());
  } catch { return String(id); }
  if (n < 0n) n = -n;
  if (n > 1_000_000_000_000n) n -= 1_000_000_000_000n;
  return n.toString();
}

/** Telegram allowlist with every id canonicalised. Null = include all. */
export function getTelegramAllowlistCanonical(): Set<string> | null {
  const raw = getSourceAllowlist('telegram');
  if (!raw) return null;
  return new Set([...raw].map(canonicalTelegramChatId));
}

/**
 * SQL-escape an id list for interpolation into raw SQL. Ids are platform
 * identifiers (digits, possibly negative, for Telegram; alphanumerics for
 * Discord/Slack) — anything else is defensively dropped.
 */
function sqlIdList(ids: Iterable<string>): string {
  return [...ids]
    .filter((id) => /^-?[A-Za-z0-9_]+$/.test(id))
    .map((id) => `'${id}'`)
    .join(',');
}

/** All stored encodings a canonical Telegram id may take in telegram_messages. */
function telegramIdVariants(canonical: string): string[] {
  try {
    const n = BigInt(canonical);
    const offset = n + 1_000_000_000_000n;
    return [n.toString(), (-n).toString(), offset.toString(), (-offset).toString()];
  } catch { return [canonical]; }
}

/**
 * Build a SQL predicate confining message rows to the configured sync scope.
 * Returns '1=1' when no filter is set. `qualifier` prefixes column names
 * (pass the table name or alias; '' for bare columns).
 *
 * The id lists come from our own settings writes and are sanitised, so the
 * predicate is safe to embed via sql.raw().
 */
export function sourceFilterPredicate(service: FilterableService, qualifier = ''): string {
  const allow = getSourceAllowlist(service);
  if (!allow) return '1=1';
  const q = qualifier ? `${qualifier}.` : '';
  switch (service) {
    case 'discord': {
      const list = sqlIdList(allow) || "''";
      return `(${q}guild_id IS NULL OR ${q}guild_id IN (${list}))`;
    }
    case 'slack': {
      const list = sqlIdList(allow) || "''";
      return `(${q}channel_id LIKE 'D%' OR ${q}channel_id IN (${list}))`;
    }
    case 'telegram': {
      const variants = [...allow].flatMap((id) => telegramIdVariants(canonicalTelegramChatId(id)));
      const list = sqlIdList(variants) || "''";
      // Private chats are always included; rows predating the chat_type column
      // fall back to the same numeric heuristic /chats uses for DM detection.
      return `(${q}chat_type IN ('private','user')`
        + ` OR (${q}chat_type IS NULL AND ${q}chat_id > 0 AND ${q}chat_id < 1000000000000)`
        + ` OR CAST(${q}chat_id AS TEXT) IN (${list}))`;
    }
  }
}
