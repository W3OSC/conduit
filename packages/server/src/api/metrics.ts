import { Router } from 'express';
import { getDb } from '../db/client.js';
import { telegramMessages, discordMessages, slackMessages, twitterDms, gmailMessages, syncRuns, outbox, auditLog, apiKeys } from '../db/schema.js';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';

const router = Router();

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function truncateToDay(iso: string): string {
  return iso.split('T')[0];
}

function truncateToHour(iso: string): string {
  return iso.substring(0, 13) + ':00:00';
}

router.get('/messages-over-time', optionalAuth, (req, res) => {
  const { days = '30', granularity = 'day' } = req.query as Record<string, string>;
  const daysNum = parseInt(days) || 30;
  const since = daysAgo(daysNum);
  const db = getDb();

  // Bucket in SQL with textual truncation (byte-identical to the previous JS
  // truncateToDay/truncateToHour output for ISO timestamps) — never loads
  // individual message rows into JS.
  type CountRow = { bucket: string; c: number };
  const countsFor = (table: string, col: string): CountRow[] => {
    const bucketExpr = granularity === 'hour'
      ? `substr(${col}, 1, 13) || ':00:00'`
      : `substr(${col}, 1, 10)`;
    return db.all<CountRow>(sql`
      SELECT ${sql.raw(bucketExpr)} AS bucket, COUNT(*) AS c
      FROM ${sql.raw(table)}
      WHERE ${sql.raw(col)} >= ${since}
      GROUP BY bucket
    `);
  };

  type Bucket = { telegram: number; discord: number; slack: number; twitter: number; gmail: number };
  const buckets = new Map<string, Bucket>();

  const ensureBucket = (key: string) => {
    if (!buckets.has(key)) buckets.set(key, { telegram: 0, discord: 0, slack: 0, twitter: 0, gmail: 0 });
    return buckets.get(key)!;
  };

  const perSource: Array<[keyof Bucket, CountRow[]]> = [
    ['telegram', countsFor('telegram_messages', 'timestamp')],
    ['discord',  countsFor('discord_messages', 'timestamp')],
    ['slack',    countsFor('slack_messages', 'timestamp')],
    ['twitter',  countsFor('twitter_dms', 'created_at')],
    ['gmail',    countsFor('gmail_messages', 'internal_date')],
  ];
  for (const [key, rows] of perSource) {
    for (const r of rows) ensureBucket(r.bucket)[key] += r.c;
  }

  const data = Array.from(buckets.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({ data, granularity, days: daysNum });
});

router.get('/sync-runs', optionalAuth, (req, res) => {
  const { days = '30', source } = req.query as Record<string, string>;
  const daysNum = parseInt(days) || 30;
  const since = daysAgo(daysNum);
  const db = getDb();

  const conditions = [gte(syncRuns.startedAt, since)];
  if (source) conditions.push(eq(syncRuns.source, source));

  const runs = db.select().from(syncRuns)
    .where(and(...conditions))
    .orderBy(desc(syncRuns.startedAt))
    .all();

  // Group by day
  const buckets = new Map<string, { success: number; error: number; totalMessages: number }>();
  for (const run of runs) {
    const key = truncateToDay(run.startedAt);
    if (!buckets.has(key)) buckets.set(key, { success: 0, error: 0, totalMessages: 0 });
    const b = buckets.get(key)!;
    if (run.status === 'success') b.success++;
    else if (run.status === 'error') b.error++;
    b.totalMessages += run.messagesSaved || 0;
  }

  const data = Array.from(buckets.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Avg duration per service
  const avgDuration: Record<string, number> = {};
  for (const src of ['telegram', 'discord', 'slack', 'twitter', 'gmail']) {
    const completed = runs.filter((r) => r.source === src && r.finishedAt && r.startedAt);
    if (completed.length > 0) {
      const total = completed.reduce((sum, r) => {
        const dur = new Date(r.finishedAt!).getTime() - new Date(r.startedAt).getTime();
        return sum + dur / 1000;
      }, 0);
      avgDuration[src] = Math.round(total / completed.length);
    }
  }

  res.json({ data, avgDuration, total: runs.length });
});

router.get('/outbox-activity', optionalAuth, (req, res) => {
  const { days = '30' } = req.query as Record<string, string>;
  const daysNum = parseInt(days) || 30;
  const since = daysAgo(daysNum);
  const db = getDb();

  const items = db.select().from(outbox)
    .where(gte(outbox.createdAt, since))
    .all();

  const buckets = new Map<string, { received: number; approved: number; rejected: number; sent: number }>();
  for (const item of items) {
    const key = truncateToDay(item.createdAt || new Date().toISOString());
    if (!buckets.has(key)) buckets.set(key, { received: 0, approved: 0, rejected: 0, sent: 0 });
    const b = buckets.get(key)!;
    b.received++;
    if (item.status === 'approved' || item.status === 'sent') b.approved++;
    if (item.status === 'rejected') b.rejected++;
    if (item.status === 'sent') b.sent++;
  }

  const data = Array.from(buckets.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({ data });
});

router.get('/api-usage', optionalAuth, (req, res) => {
  const { days = '30' } = req.query as Record<string, string>;
  const daysNum = parseInt(days) || 30;
  const since = daysAgo(daysNum);
  const db = getDb();

  const logs = db.select().from(auditLog)
    .where(and(eq(auditLog.actor, 'api'), gte(auditLog.timestamp, since)))
    .all();

  const keys = db.select().from(apiKeys).all();

  // Prebuilt id → name map for active (non-revoked) keys — O(1) lookups
  const labelById = new Map<number, string | null>();
  for (const k of keys) {
    if (!k.revokedAt) labelById.set(k.id, k.name || null);
  }

  // Resolve a human-readable label for each log entry's key id — returns null for deleted keys
  const keyLabel = (apiKeyId: number | null): string | null => {
    if (!apiKeyId) return null;
    return labelById.get(apiKeyId) ?? null;
  };

  // Daily breakdown — one column per API key name; skip entries from deleted keys
  const buckets = new Map<string, Record<string, number>>();
  for (const log of logs) {
    const label = keyLabel(log.apiKeyId ?? null);
    if (!label) continue; // skip requests from deleted keys
    const day = truncateToDay(log.timestamp || new Date().toISOString());
    if (!buckets.has(day)) buckets.set(day, {});
    const b = buckets.get(day)!;
    b[label] = (b[label] || 0) + 1;
  }

  // Collect the full set of key names that appear in the data
  const keyNames = Array.from(
    new Set(
      logs
        .map((l) => keyLabel(l.apiKeyId ?? null))
        .filter((label): label is string => label !== null)
    )
  );

  const daily = Array.from(buckets.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json({ daily, keys: keyNames });
});

export default router;
