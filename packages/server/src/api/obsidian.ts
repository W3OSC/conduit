/**
 * Obsidian Vault API — REST routes for vault configuration, sync, and file operations.
 *
 * Configuration & sync:
 *   GET    /api/obsidian/config             — get vault config (no secrets)
 *   POST   /api/obsidian/config             — create or update vault config
 *   DELETE /api/obsidian/config             — remove vault config (deletes local clone)
 *   POST   /api/obsidian/config/clone       — trigger initial git clone
 *   GET    /api/obsidian/config/ssh-key     — get generated SSH public key
 *   POST   /api/obsidian/config/generate-ssh-key  — generate new SSH key pair
 *   POST   /api/obsidian/sync              — trigger manual sync (fetch + pull)
 *   GET    /api/obsidian/sync/status       — current sync status
 *
 * File reads (direct, no outbox):
 *   GET    /api/obsidian/files              — list all files as tree
 *   GET    /api/obsidian/files/*            — read file contents
 *
 * Writes go through /api/outbox with source: 'obsidian'
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from '../db/client.js';
import { obsidianVaultConfig } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { ObsidianVaultSync } from '../sync/obsidian.js';

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDataDir(): string {
  // data/ directory relative to project root
  return process.env.DATA_DIR || path.join(__dirname, '../../../../data');
}

function getVaultBaseDir(): string {
  return path.join(getDataDir(), 'vault');
}

// ── Config helpers ─────────────────────────────────────────────────────────────

function getVaultConfig() {
  const db = getDb();
  return db.select().from(obsidianVaultConfig).get();
}

function stripSecrets(row: ReturnType<typeof getVaultConfig>) {
  if (!row) return null;
  const { httpsToken, sshPrivateKey, ...safe } = row;
  return {
    ...safe,
    hasHttpsToken: !!httpsToken,
    hasSshPrivateKey: !!sshPrivateKey,
  };
}

// ── GET /obsidian/config ────────────────────────────────────────────────────

router.get('/config', optionalAuth, (_req, res) => {
  const row = getVaultConfig();
  if (!row) {
    res.json({ configured: false });
    return;
  }
  res.json({ configured: true, vault: stripSecrets(row) });
});

// ── POST /obsidian/config ───────────────────────────────────────────────────

router.post('/config', optionalAuth, async (req, res) => {
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

  const localPath = path.join(getVaultBaseDir(), name.replace(/[^a-zA-Z0-9_-]/g, '_'));

  const existing = getVaultConfig();
  if (existing) {
    // Update existing config
    const updated = db.update(obsidianVaultConfig).set({
      name,
      remoteUrl: remote_url,
      authType: auth_type,
      httpsToken: https_token ?? existing.httpsToken,
      sshPrivateKey: ssh_private_key ?? existing.sshPrivateKey,
      sshPublicKey: ssh_public_key ?? existing.sshPublicKey,
      branch,
      updatedAt: new Date().toISOString(),
    }).where(eq(obsidianVaultConfig.id, existing.id)).returning().get();

    res.json({ configured: true, vault: stripSecrets(updated) });
  } else {
    // Create new config
    const created = db.insert(obsidianVaultConfig).values({
      name,
      remoteUrl: remote_url,
      authType: auth_type,
      httpsToken: https_token ?? null,
      sshPrivateKey: ssh_private_key ?? null,
      sshPublicKey: ssh_public_key ?? null,
      localPath,
      branch,
      syncStatus: 'idle',
    }).returning().get();

    res.json({ configured: true, vault: stripSecrets(created) });
  }
});

// ── DELETE /obsidian/config ─────────────────────────────────────────────────

router.delete('/config', optionalAuth, async (req, res) => {
  const db = getDb();
  const row = getVaultConfig();
  if (!row) {
    res.status(404).json({ error: 'No vault configured' });
    return;
  }

  // Disconnect from connection manager
  const manager = getConnectionManager();
  manager.disconnectObsidian();

  // Remove local clone if requested
  const { delete_local = false } = req.body as { delete_local?: boolean };
  if (delete_local && row.localPath && fs.existsSync(row.localPath)) {
    fs.rmSync(row.localPath, { recursive: true, force: true });
  }

  db.delete(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, row.id)).run();
  res.json({ success: true });
});

// ── POST /obsidian/config/generate-ssh-key ──────────────────────────────────

router.post('/config/generate-ssh-key', optionalAuth, async (_req, res) => {
  try {
    const { privateKey, publicKey } = await ObsidianVaultSync.generateSshKeyPair();

    // Store in DB if a vault config exists
    const db = getDb();
    const row = getVaultConfig();
    if (row) {
      db.update(obsidianVaultConfig).set({
        sshPrivateKey: privateKey,
        sshPublicKey: publicKey,
        updatedAt: new Date().toISOString(),
      }).where(eq(obsidianVaultConfig.id, row.id)).run();
    }

    res.json({ publicKey });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: `Failed to generate SSH key: ${err}` });
  }
});

// ── GET /obsidian/config/ssh-key ────────────────────────────────────────────

router.get('/config/ssh-key', optionalAuth, (_req, res) => {
  const row = getVaultConfig();
  if (!row?.sshPublicKey) {
    res.status(404).json({ error: 'No SSH key generated. Use POST /api/obsidian/config/generate-ssh-key first.' });
    return;
  }
  res.json({ publicKey: row.sshPublicKey });
});

// ── POST /obsidian/config/clone ─────────────────────────────────────────────

router.post('/config/clone', optionalAuth, async (_req, res) => {
  const row = getVaultConfig();
  if (!row) {
    res.status(400).json({ error: 'No vault configured. Create a config first.' });
    return;
  }

  const manager = getConnectionManager();

  // Respond immediately and run clone async
  res.json({ success: true, message: 'Clone started' });

  try {
    await manager.cloneObsidianVault(row);
  } catch (e) {
    console.error('[obsidian] Clone failed:', e);
  }
});

// ── GET /obsidian/sync/status ───────────────────────────────────────────────

router.get('/sync/status', optionalAuth, (_req, res) => {
  const row = getVaultConfig();
  if (!row) {
    res.json({ configured: false });
    return;
  }
  res.json({
    configured: true,
    syncStatus: row.syncStatus,
    lastSyncedAt: row.lastSyncedAt,
    lastCommitHash: row.lastCommitHash,
    error: row.syncError,
  });
});

// ── POST /obsidian/sync ─────────────────────────────────────────────────────

router.post('/sync', optionalAuth, async (_req, res) => {
  const manager = getConnectionManager();
  const obsidian = manager.getObsidian();

  if (!obsidian) {
    const row = getVaultConfig();
    if (!row) {
      res.status(400).json({ error: 'No vault configured' });
      return;
    }
    // Try to connect first
    await manager.connectObsidian();
    const obs2 = manager.getObsidian();
    if (!obs2) {
      res.status(503).json({ error: 'Vault not connected. Ensure vault is cloned first.' });
      return;
    }
  }

  // Respond immediately, run sync async
  res.json({ success: true, message: 'Sync started' });

  try {
    await manager.getObsidian()!.sync();
  } catch (e) {
    console.error('[obsidian] Manual sync failed:', e);
  }
});

// ── GET /obsidian/files ─────────────────────────────────────────────────────

router.get('/files', optionalAuth, async (_req, res) => {
  const manager = getConnectionManager();
  const obsidian = manager.getObsidian();

  if (!obsidian) {
    res.status(503).json({ error: 'Vault not connected' });
    return;
  }

  try {
    const files = await obsidian.listFiles();
    res.json({ files });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: err });
  }
});

// ── GET /obsidian/files/* ───────────────────────────────────────────────────
// Read a file by relative path. The path comes after /files/ in the URL.

router.get('/files/*', optionalAuth, async (req, res) => {
  const manager = getConnectionManager();
  const obsidian = manager.getObsidian();

  if (!obsidian) {
    res.status(503).json({ error: 'Vault not connected' });
    return;
  }

  // Express wildcard captures everything after /files/
  const rawPath = (req.params as Record<string, string>)['0'] || '';
  const filePath = decodeURIComponent(rawPath);

  if (!filePath) {
    res.status(400).json({ error: 'File path is required' });
    return;
  }

  try {
    const content = await obsidian.readFile(filePath);
    res.json({ path: filePath, content });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const status = err.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err });
  }
});

export default router;
