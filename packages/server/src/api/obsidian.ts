/**
 * Obsidian Vault API — multi-vault REST routes for vault configuration, sync, and file operations.
 *
 * Vault management:
 *   GET    /api/obsidian/vaults                    — list all configured vaults
 *   POST   /api/obsidian/vaults                    — create a new vault config
 *   GET    /api/obsidian/vaults/:id                — get a single vault config (no secrets)
 *   PUT    /api/obsidian/vaults/:id                — update a vault config
 *   DELETE /api/obsidian/vaults/:id                — remove a vault config (optionally deletes local clone)
 *
 * Per-vault operations:
 *   POST   /api/obsidian/vaults/:id/test           — test git remote connectivity
 *   POST   /api/obsidian/vaults/:id/generate-ssh-key — generate new SSH key pair
 *   GET    /api/obsidian/vaults/:id/ssh-key         — get generated SSH public key
 *   GET    /api/obsidian/vaults/:id/ssh-fingerprint  — get SHA256 fingerprint of stored SSH key
 *   POST   /api/obsidian/vaults/:id/clone           — trigger initial git clone
 *   GET    /api/obsidian/vaults/:id/sync-status     — current sync status
 *   POST   /api/obsidian/vaults/:id/sync            — trigger manual sync (fetch + pull)
 *   GET    /api/obsidian/vaults/:id/files            — list all files as tree
 *   GET    /api/obsidian/vaults/:id/files/*          — read file contents
 *
 * Writes go through /api/outbox with source: 'obsidian' and { vaultId } in the JSON payload
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from '../db/client.js';
import { obsidianVaultConfig } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth, trackAiCall } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { ObsidianVaultSync } from '../sync/obsidian.js';
import { validateGitRemoteUrl } from '../auth/ssrf.js';

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDataDir(): string {
  return process.env.DATA_DIR || path.join(__dirname, '../../../../data');
}

function getVaultBaseDir(): string {
  return path.join(getDataDir(), 'vault');
}

// ── Config helpers ─────────────────────────────────────────────────────────────

type VaultRow = typeof obsidianVaultConfig.$inferSelect;

function stripSecrets(row: VaultRow) {
  const { httpsToken, sshPrivateKey, ...safe } = row;
  return {
    ...safe,
    hasHttpsToken: !!httpsToken,
    hasSshPrivateKey: !!sshPrivateKey,
  };
}

function parseVaultId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return isNaN(id) ? null : id;
}

// ── GET /obsidian/vaults — list all vaults ─────────────────────────────────

router.get('/vaults', optionalAuth, (_req, res) => {
  const db = getDb();
  const manager = getConnectionManager();
  const rows = db.select().from(obsidianVaultConfig).all();
  const vaults = rows.map((row) => {
    const status = manager.getObsidianVaultStatus(row.id);
    return { ...stripSecrets(row), connectionStatus: status };
  });
  res.json({ vaults });
});

// ── POST /obsidian/vaults — create a new vault ─────────────────────────────

router.post('/vaults', optionalAuth, async (req, res) => {
  const db = getDb();
  const {
    name,
    remote_url,
    auth_type = 'https',
    https_token,
    ssh_private_key,
    ssh_public_key,
    branch = 'main',
  } = req.body as {
    name: string;
    remote_url: string;
    auth_type?: 'https' | 'ssh';
    https_token?: string;
    ssh_private_key?: string;
    ssh_public_key?: string;
    branch?: string;
  };

  if (!name || !remote_url) {
    res.status(400).json({ error: 'name and remote_url are required' });
    return;
  }

  const ssrfCheck = validateGitRemoteUrl(remote_url);
  if (!ssrfCheck.ok) {
    res.status(400).json({ error: ssrfCheck.error });
    return;
  }

  // Insert first to get the auto-increment id, then set localPath based on id
  const created = db.insert(obsidianVaultConfig).values({
    name,
    remoteUrl: remote_url,
    authType: auth_type,
    httpsToken: https_token ?? null,
    sshPrivateKey: ssh_private_key ?? null,
    sshPublicKey: ssh_public_key ?? null,
    localPath: 'pending', // placeholder — updated immediately below
    branch,
    syncStatus: 'idle',
  }).returning().get();

  const localPath = path.join(getVaultBaseDir(), String(created.id));
  const final = db.update(obsidianVaultConfig)
    .set({ localPath, updatedAt: new Date().toISOString() })
    .where(eq(obsidianVaultConfig.id, created.id))
    .returning().get();

  res.status(201).json({ vault: stripSecrets(final) });
});

// ── GET /obsidian/vaults/:id — get a single vault ─────────────────────────

router.get('/vaults/:id', optionalAuth, (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const db = getDb();
  const manager = getConnectionManager();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row) { res.status(404).json({ error: 'Vault not found' }); return; }

  const status = manager.getObsidianVaultStatus(id);
  res.json({ vault: { ...stripSecrets(row), connectionStatus: status } });
});

// ── PUT /obsidian/vaults/:id — update a vault ─────────────────────────────

router.put('/vaults/:id', optionalAuth, async (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const db = getDb();
  const existing = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!existing) { res.status(404).json({ error: 'Vault not found' }); return; }

  const {
    name,
    remote_url,
    auth_type,
    https_token,
    ssh_private_key,
    ssh_public_key,
    branch,
  } = req.body as {
    name?: string;
    remote_url?: string;
    auth_type?: 'https' | 'ssh';
    https_token?: string;
    ssh_private_key?: string;
    ssh_public_key?: string;
    branch?: string;
  };

  if (remote_url) {
    const ssrfCheck = validateGitRemoteUrl(remote_url);
    if (!ssrfCheck.ok) { res.status(400).json({ error: ssrfCheck.error }); return; }
  }

  const updated = db.update(obsidianVaultConfig).set({
    name:         name         ?? existing.name,
    remoteUrl:    remote_url   ?? existing.remoteUrl,
    authType:     auth_type    ?? existing.authType,
    httpsToken:   https_token  !== undefined ? https_token : existing.httpsToken,
    sshPrivateKey: ssh_private_key !== undefined ? ssh_private_key : existing.sshPrivateKey,
    sshPublicKey:  ssh_public_key  !== undefined ? ssh_public_key  : existing.sshPublicKey,
    branch:       branch       ?? existing.branch,
    updatedAt: new Date().toISOString(),
  }).where(eq(obsidianVaultConfig.id, id)).returning().get();

  res.json({ vault: stripSecrets(updated) });
});

// ── DELETE /obsidian/vaults/:id — remove a vault ──────────────────────────

router.delete('/vaults/:id', optionalAuth, async (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const db = getDb();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row) { res.status(404).json({ error: 'Vault not found' }); return; }

  const manager = getConnectionManager();
  manager.disconnectObsidianVault(id);

  const { delete_local = false } = req.body as { delete_local?: boolean };
  if (delete_local && row.localPath && fs.existsSync(row.localPath)) {
    fs.rmSync(row.localPath, { recursive: true, force: true });
  }

  db.delete(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).run();
  res.json({ success: true });
});

// ── POST /obsidian/vaults/:id/test ────────────────────────────────────────

router.post('/vaults/:id/test', optionalAuth, async (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const db = getDb();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row) { res.status(404).json({ error: 'Vault not found' }); return; }

  try {
    const result = await ObsidianVaultSync.testConnection({
      remoteUrl: row.remoteUrl,
      authType: (row.authType as 'https' | 'ssh') ?? 'https',
      httpsToken: row.httpsToken,
      sshPrivateKey: row.sshPrivateKey,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /obsidian/vaults/:id/generate-ssh-key ────────────────────────────

router.post('/vaults/:id/generate-ssh-key', optionalAuth, async (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const db = getDb();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row) { res.status(404).json({ error: 'Vault not found' }); return; }

  try {
    const { privateKey, publicKey } = await ObsidianVaultSync.generateSshKeyPair();
    db.update(obsidianVaultConfig).set({
      sshPrivateKey: privateKey,
      sshPublicKey: publicKey,
      updatedAt: new Date().toISOString(),
    }).where(eq(obsidianVaultConfig.id, id)).run();

    const fingerprint = await ObsidianVaultSync.getPublicKeyFingerprint(publicKey);
    res.json({ publicKey, fingerprint });
  } catch (e) {
    res.status(500).json({ error: `Failed to generate SSH key: ${e instanceof Error ? e.message : String(e)}` });
  }
});

// ── GET /obsidian/vaults/:id/ssh-key ──────────────────────────────────────

router.get('/vaults/:id/ssh-key', optionalAuth, (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const db = getDb();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row?.sshPublicKey) {
    res.status(404).json({ error: 'No SSH key generated for this vault.' });
    return;
  }
  res.json({ publicKey: row.sshPublicKey });
});

// ── GET /obsidian/vaults/:id/ssh-fingerprint ──────────────────────────────

router.get('/vaults/:id/ssh-fingerprint', optionalAuth, async (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const db = getDb();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row?.sshPublicKey) {
    res.status(404).json({ error: 'No SSH key generated for this vault.' });
    return;
  }
  const fingerprint = await ObsidianVaultSync.getPublicKeyFingerprint(row.sshPublicKey);
  res.json({ fingerprint });
});

// ── POST /obsidian/vaults/:id/clone ───────────────────────────────────────

router.post('/vaults/:id/clone', optionalAuth, async (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const db = getDb();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row) { res.status(404).json({ error: 'Vault not found' }); return; }

  const manager = getConnectionManager();

  // Respond immediately and run clone async
  res.json({ success: true, message: 'Clone started' });

  try {
    await manager.cloneObsidianVault(row);
  } catch (e) {
    console.error(`[obsidian:${id}] Clone failed:`, e);
  }
});

// ── GET /obsidian/vaults/:id/sync-status ──────────────────────────────────

router.get('/vaults/:id/sync-status', optionalAuth, (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const db = getDb();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row) { res.status(404).json({ error: 'Vault not found' }); return; }

  res.json({
    vaultId: id,
    syncStatus: row.syncStatus,
    lastSyncedAt: row.lastSyncedAt,
    lastCommitHash: row.lastCommitHash,
    error: row.syncError,
  });
});

// ── POST /obsidian/vaults/:id/sync ────────────────────────────────────────

router.post('/vaults/:id/sync', optionalAuth, async (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const manager = getConnectionManager();
  let sync = manager.getObsidian(id);

  if (!sync) {
    const db = getDb();
    const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
    if (!row) { res.status(404).json({ error: 'Vault not found' }); return; }

    await manager.connectObsidianVault(id);
    sync = manager.getObsidian(id);
    if (!sync) {
      res.status(503).json({ error: 'Vault not connected. Ensure vault is cloned first.' });
      return;
    }
  }

  // Respond immediately, run sync async
  res.json({ success: true, message: 'Sync started' });

  try {
    await sync.sync();
  } catch (e) {
    console.error(`[obsidian:${id}] Manual sync failed:`, e);
  }
});

// ── GET /obsidian/vaults/:id/files ────────────────────────────────────────

router.get('/vaults/:id/files', optionalAuth, trackAiCall, async (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const manager = getConnectionManager();
  const sync = manager.getObsidian(id);

  if (!sync) {
    res.status(503).json({ error: `Vault ${id} not connected` });
    return;
  }

  try {
    const files = await sync.listFiles();
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /obsidian/vaults/:id/files/* ─────────────────────────────────────

router.get('/vaults/:id/files/*path', optionalAuth, trackAiCall, async (req, res) => {
  const id = parseVaultId(req.params['id'] as string);
  if (id === null) { res.status(400).json({ error: 'Invalid vault id' }); return; }

  const manager = getConnectionManager();
  const sync = manager.getObsidian(id);

  if (!sync) {
    res.status(503).json({ error: `Vault ${id} not connected` });
    return;
  }

  const rawPath = (req.params as Record<string, string>)['path'] || '';
  const filePath = decodeURIComponent(rawPath);

  if (!filePath) {
    res.status(400).json({ error: 'File path is required' });
    return;
  }

  try {
    const content = await sync.readFile(filePath);
    res.json({ path: filePath, content });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const status = err.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err });
  }
});

export default router;
