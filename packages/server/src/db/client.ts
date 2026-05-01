import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as schema from './schema.js';
import { permissions, settings, syncRuns, obsidianVaultConfig } from './schema.js';
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
  migrateVaultPaths();
  await seedDefaults();
}

/**
 * Multi-vault migration: rename existing vault directories from name-based paths
 * (data/vault/<name>) to id-based paths (data/vault/<id>).
 * Safe to run multiple times — skips vaults already on id-based paths.
 */
function migrateVaultPaths(): void {
  const db = getDb();
  const vaults = db.select().from(obsidianVaultConfig).all();
  if (vaults.length === 0) return;

  const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../../../data');
  const vaultBase = path.join(dataDir, 'vault');

  for (const vault of vaults) {
    const idBasedPath = path.join(vaultBase, String(vault.id));
    if (vault.localPath === idBasedPath) continue; // already migrated

    // Rename the directory on disk if the old path exists
    if (fs.existsSync(vault.localPath) && !fs.existsSync(idBasedPath)) {
      try {
        fs.mkdirSync(vaultBase, { recursive: true });
        fs.renameSync(vault.localPath, idBasedPath);
        console.log(`[db] Migrated vault ${vault.id} (${vault.name}): ${vault.localPath} → ${idBasedPath}`);
      } catch (e) {
        console.error(`[db] Failed to rename vault directory for vault ${vault.id}:`, e);
        // Don't update DB if rename failed — leave consistent
        continue;
      }
    } else if (!fs.existsSync(vault.localPath) && !fs.existsSync(idBasedPath)) {
      // Not cloned yet — just update the path in DB
      console.log(`[db] Updating uncloned vault ${vault.id} (${vault.name}) path to id-based`);
    } else if (fs.existsSync(idBasedPath)) {
      // Already renamed on disk but DB not updated
      console.log(`[db] Updating vault ${vault.id} (${vault.name}) DB path (dir already at id-based path)`);
    }

    // Update DB record
    db.update(obsidianVaultConfig)
      .set({ localPath: idBasedPath, updatedAt: new Date().toISOString() })
      .where(eq(obsidianVaultConfig.id, vault.id))
      .run();
  }
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
  const services = ['slack', 'discord', 'telegram', 'gmail', 'calendar', 'twitter', 'notion', 'obsidian', 'smb'] as const;
  for (const service of services) {
    const existing = db
      .select()
      .from(permissions)
      .where(eq(permissions.service, service))
      .get();
    if (!existing) {
      // Obsidian, Notion, Twitter, and SMB write/outbox is off by default — must be explicitly enabled
      const sendEnabled = !(['obsidian', 'notion', 'twitter', 'smb'] as const).includes(service as 'obsidian' | 'notion' | 'twitter' | 'smb');
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
