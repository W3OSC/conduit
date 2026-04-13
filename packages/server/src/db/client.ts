import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as schema from './schema.js';
import { permissions, settings, syncRuns } from './schema.js';
import { eq, isNull, and } from 'drizzle-orm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDbPath(): string {
  return (
    process.env.DATABASE_PATH ||
    path.join(__dirname, '../../../../data/conduit.db')
  );
}

function getMigrationsPath(): string {
  return path.join(__dirname, '../../drizzle');
}

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb() {
  if (!_db) {
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    _sqlite = new Database(dbPath);
    // Enable WAL mode for better concurrent read performance
    _sqlite.pragma('journal_mode = WAL');
    _sqlite.pragma('foreign_keys = ON');
    _db = drizzle(_sqlite, { schema });
  }
  return _db;
}

export function getSqlite(): Database.Database {
  if (!_sqlite) getDb();
  return _sqlite!;
}

export async function runMigrations(): Promise<void> {
  const db = getDb();
  migrate(db, { migrationsFolder: getMigrationsPath() });
  console.log('[db] Migrations applied');
  cleanupOrphanedSyncs();
  await seedDefaults();
}

/**
 * On startup, any sync runs that were left in 'running' state are orphaned —
 * the server process that started them is gone. Mark them as 'cancelled' so
 * they don't appear as active syncs in the UI indefinitely.
 */
function cleanupOrphanedSyncs(): void {
  const db = getDb();
  const orphaned = db.select().from(syncRuns)
    .where(and(eq(syncRuns.status, 'running'), isNull(syncRuns.finishedAt)))
    .all();

  if (orphaned.length === 0) return;

  db.update(syncRuns)
    .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
    .where(and(eq(syncRuns.status, 'running'), isNull(syncRuns.finishedAt)))
    .run();

  console.log(`[db] Marked ${orphaned.length} orphaned sync run(s) as cancelled`);
}

async function seedDefaults(): Promise<void> {
  const db = getDb();

  // Seed default permissions for each service
  const services = ['slack', 'discord', 'telegram', 'gmail', 'calendar', 'twitter', 'notion', 'obsidian'] as const;
  for (const service of services) {
    const existing = db
      .select()
      .from(permissions)
      .where(eq(permissions.service, service))
      .get();
    if (!existing) {
      // Obsidian, Notion, and Twitter write/outbox is off by default — must be explicitly enabled
      const sendEnabled = !(['obsidian', 'notion', 'twitter'] as const).includes(service as 'obsidian' | 'notion' | 'twitter');
      db.insert(permissions)
        .values({
          service,
          readEnabled: true,
          sendEnabled,
          requireApproval: true,
          directSendFromUi: false,
          markReadEnabled: false,
        })
        .run();
    }
  }

  // Seed default settings
  const defaultSettings: Record<string, unknown> = {
    appName: 'Conduit',
    apiPort: 3101,
    incrementalIntervalMinutes: { slack: 5, discord: 30, telegram: 5 },
    uiPort: 3101,
  };

  for (const [key, value] of Object.entries(defaultSettings)) {
    const existing = db.select().from(settings).where(eq(settings.key, key)).get();
    if (!existing) {
      db.insert(settings).values({ key, value: JSON.stringify(value) }).run();
    }
  }

  console.log('[db] Default data seeded');
}

export { schema };
