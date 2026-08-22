/**
 * Dev-only demo data seeder — populates the dashboard/metrics surfaces with
 * plausible activity so the UI can be designed and reviewed without live
 * service connections.
 *
 *   npx tsx scripts/seed-demo-data.ts          # seed
 *   npx tsx scripts/seed-demo-data.ts --clean  # remove everything it seeded
 *
 * Every row carries a marker (demo- id prefixes, raw_json/detail {"demo":true},
 * account_id/key_prefix "demo", sync_runs.error_message "demo-seed") so --clean
 * deletes only seeded rows. Never run against a database with real data you
 * care about mixing demo rows into.
 */
import { getSqlite } from '../src/db/client';

const sqlite = getSqlite();
const DAY = 86_400_000;
const NOW = Date.now();

// Deterministic pseudo-random so re-seeding produces the same shape.
let seedState = 42;
function rand() {
  seedState = (seedState * 1103515245 + 12345) % 2 ** 31;
  return seedState / 2 ** 31;
}
const iso = (t: number) => new Date(t).toISOString();
// Weekday-weighted daily volume with noise: quieter on weekends.
function dailyCount(base: number, dayOffset: number) {
  const date = new Date(NOW - dayOffset * DAY);
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const wave = 0.75 + 0.5 * Math.sin(dayOffset / 4.5);
  return Math.max(0, Math.round(base * wave * (weekend ? 0.35 : 1) * (0.7 + rand() * 0.6)));
}
// A timestamp on that day, biased toward working hours.
function timeOnDay(dayOffset: number) {
  const dayStart = NOW - dayOffset * DAY - (NOW % DAY);
  const hour = 8 + Math.floor(rand() * 13);
  return dayStart + hour * 3_600_000 + Math.floor(rand() * 3_600_000);
}

const DAYS = 90;
const DEMO = '{"demo":true}';

function clean() {
  const stmts = [
    `DELETE FROM slack_messages    WHERE raw_json = '${DEMO}'`,
    `DELETE FROM discord_messages  WHERE raw_json = '${DEMO}'`,
    `DELETE FROM telegram_messages WHERE raw_json = '${DEMO}'`,
    `DELETE FROM twitter_dms       WHERE raw_json = '${DEMO}'`,
    `DELETE FROM gmail_messages    WHERE raw_headers = '${DEMO}'`,
    `DELETE FROM sync_state        WHERE account_id = 'demo'`,
    `DELETE FROM sync_runs         WHERE error_message = 'demo-seed'`,
    `DELETE FROM outbox            WHERE idempotency_key LIKE 'demo-%'`,
    `DELETE FROM audit_log         WHERE detail = '${DEMO}'`,
    `DELETE FROM api_keys          WHERE key_prefix = 'demo'`,
  ];
  for (const s of stmts) {
    const info = sqlite.prepare(s).run();
    console.log(`${s.split(' ')[2].padEnd(18)} -${info.changes}`);
  }
}

function seed() {
  const senders = ['Maya', 'Devon', 'Priya', 'Tom', 'Ana', 'Chris', 'Lena', 'Sam'];
  const snippets = [
    'Sounds good, let’s do it', 'Can you take a look at this?', 'Shipping the fix now',
    'Meeting moved to 3pm', 'lol perfect', 'Draft attached — thoughts?', 'On it',
    'Any update on the rollout?', 'That worked, thanks!', 'Let’s sync tomorrow morning',
  ];
  const pick = (arr: string[]) => arr[Math.floor(rand() * arr.length)];

  const insertMsg = {
    slack: sqlite.prepare(`INSERT OR IGNORE INTO slack_messages
      (message_id, channel_id, channel_name, user_id, user_name, content, timestamp, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, '${DEMO}')`),
    discord: sqlite.prepare(`INSERT OR IGNORE INTO discord_messages
      (message_id, channel_id, channel_name, guild_name, author_id, author_name, content, timestamp, raw_json)
      VALUES (?, ?, ?, 'Demo Guild', ?, ?, ?, ?, '${DEMO}')`),
    telegram: sqlite.prepare(`INSERT OR IGNORE INTO telegram_messages
      (message_id, chat_id, chat_name, chat_type, sender_id, sender_name, content, timestamp, raw_json)
      VALUES (?, ?, ?, 'private', ?, ?, ?, ?, '${DEMO}')`),
    twitter: sqlite.prepare(`INSERT OR IGNORE INTO twitter_dms
      (conversation_id, message_id, sender_id, sender_handle, sender_name, text, created_at, account_id, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'demo', '${DEMO}')`),
    gmail: sqlite.prepare(`INSERT OR IGNORE INTO gmail_messages
      (gmail_id, thread_id, account_id, from_address, from_name, subject, snippet, internal_date, raw_headers)
      VALUES (?, ?, 'demo', ?, ?, ?, ?, ?, '${DEMO}')`),
  };

  // messages per weekday-ish day, per service
  const volumes: Array<[keyof typeof insertMsg, number]> = [
    ['slack', 34], ['discord', 22], ['telegram', 14], ['gmail', 11], ['twitter', 3],
  ];
  let msgId = 0;
  const msgTotals: Record<string, number> = {};
  const chats: Record<string, string[]> = {
    slack:    ['#engineering', '#general', '#launch-week', '#design', 'DM · Maya'],
    discord:  ['dev-chat', 'announcements', 'off-topic', 'support'],
    telegram: ['Family', 'Trip planning', 'Alerts', 'Marco'],
    twitter:  ['dm-1', 'dm-2', 'dm-3'],
    gmail:    ['inbox'],
  };

  const insertAll = sqlite.transaction(() => {
    for (let d = DAYS - 1; d >= 0; d--) {
      for (const [svc, base] of volumes) {
        const n = dailyCount(base, d);
        msgTotals[svc] = (msgTotals[svc] ?? 0) + n;
        for (let i = 0; i < n; i++) {
          const id = `demo-${++msgId}`;
          const ts = iso(timeOnDay(d));
          const who = pick(senders);
          const text = pick(snippets);
          const chat = pick(chats[svc]);
          if (svc === 'slack')    insertMsg.slack.run(id, chat, chat, `U${who}`, who, text, ts);
          if (svc === 'discord')  insertMsg.discord.run(id, chat, chat, `D${who}`, who, text, ts);
          if (svc === 'telegram') insertMsg.telegram.run(msgId, chats.telegram.indexOf(chat) + 1000, chat, msgId, who, text, ts);
          if (svc === 'twitter')  insertMsg.twitter.run(chat, id, `T${who}`, who.toLowerCase(), who, text, ts);
          if (svc === 'gmail')    insertMsg.gmail.run(id, `demo-t-${msgId % 37}`, `${who.toLowerCase()}@example.com`, who, text, text, ts);
        }
      }
    }

    // sync_state rows drive the per-service chat counts on /api/status
    const insState = sqlite.prepare(`INSERT INTO sync_state
      (source, account_id, chat_id, chat_name, last_message_ts, last_fetched_at, message_count)
      VALUES (?, 'demo', ?, ?, ?, ?, ?)`);
    for (const [svc] of volumes) {
      for (const chat of chats[svc]) {
        insState.run(svc, `demo-${svc}-${chat}`, chat, iso(NOW - rand() * DAY), iso(NOW - rand() * DAY),
          Math.round((msgTotals[svc] ?? 0) / chats[svc].length));
      }
    }

    // sync runs — mostly success, occasional failure
    const insRun = sqlite.prepare(`INSERT INTO sync_runs
      (source, sync_type, status, chats_visited, chats_with_new, messages_saved, requests_made, error_message, started_at, finished_at)
      VALUES (?, 'incremental', ?, ?, ?, ?, ?, 'demo-seed', ?, ?)`);
    for (let d = Math.min(DAYS, 29); d >= 0; d--) {
      for (const [svc] of volumes) {
        const runs = 2 + Math.floor(rand() * 3);
        for (let r = 0; r < runs; r++) {
          const failed = rand() < 0.04;
          const start = timeOnDay(d);
          insRun.run(svc, failed ? 'error' : 'success', 4 + Math.floor(rand() * 8),
            Math.floor(rand() * 4), dailyCount(8, d), 3 + Math.floor(rand() * 20),
            iso(start), iso(start + 20_000 + rand() * 90_000));
        }
      }
    }

    // outbox history + a few pending approvals
    const insOutbox = sqlite.prepare(`INSERT INTO outbox
      (source, recipient_id, recipient_name, content, status, requester, idempotency_key, created_at, approved_at, sent_at)
      VALUES (?, ?, ?, ?, ?, 'api', ?, ?, ?, ?)`);
    let obId = 0;
    for (let d = Math.min(DAYS, 29); d >= 0; d--) {
      const n = Math.round(dailyCount(3, d) / 2);
      for (let i = 0; i < n; i++) {
        const created = timeOnDay(d);
        const who = pick(senders);
        const roll = rand();
        const status = roll < 0.72 ? 'sent' : roll < 0.86 ? 'approved' : 'rejected';
        insOutbox.run(pick(['slack', 'telegram', 'discord']), `U${who}`, who,
          pick(snippets), status, `demo-${++obId}`, iso(created),
          status === 'rejected' ? null : iso(created + 600_000),
          status === 'sent' ? iso(created + 900_000) : null);
      }
    }
    const pendingItems: Array<[string, string, string, number]> = [
      ['slack', 'Maya', 'Confirmed — I’ll have the summary doc over to you before the 3pm sync.', 22],
      ['telegram', 'Marco', 'Booked the Thursday slot. Sending the calendar invite now.', 51],
      ['gmail', 'Ana Ortiz', 'Re: Q3 vendor renewal — draft reply attached for your review.', 140],
    ];
    for (const [svc, who, text, minsAgo] of pendingItems) {
      insOutbox.run(svc, `U${who}`, who, text, 'pending', `demo-${++obId}`,
        iso(NOW - minsAgo * 60_000), null, null);
    }

    // API keys + audit_log 'api' rows drive the agent-traffic panel
    const insKey = sqlite.prepare(`INSERT INTO api_keys (name, key_hash, key_prefix, created_at, last_used_at)
      VALUES (?, ?, 'demo', ?, ?)`);
    const k1 = insKey.run('personal-agent', `demo-hash-${NOW}-1`, iso(NOW - 80 * DAY), iso(NOW)).lastInsertRowid;
    const k2 = insKey.run('scheduler', `demo-hash-${NOW}-2`, iso(NOW - 40 * DAY), iso(NOW - DAY)).lastInsertRowid;
    const insAudit = sqlite.prepare(`INSERT INTO audit_log (action, service, actor, api_key_id, detail, timestamp)
      VALUES (?, ?, 'api', ?, '${DEMO}', ?)`);
    for (let d = Math.min(DAYS, 89); d >= 0; d--) {
      const n = dailyCount(26, d);
      for (let i = 0; i < n; i++) {
        insAudit.run(rand() < 0.8 ? 'read' : 'send_request', pick(['slack', 'telegram', 'gmail', 'discord']),
          rand() < 0.7 ? k1 : k2, iso(timeOnDay(d)));
      }
    }
  });

  insertAll();
  console.log(`Seeded ~${msgId} messages over ${DAYS} days, plus sync runs, outbox, api keys, and audit rows.`);
}

if (process.argv.includes('--clean')) {
  clean();
} else {
  seed();
}
