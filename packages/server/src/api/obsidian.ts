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
import { optionalAuth, uiOnlyAuth, trackAiCall, type AuthedRequest } from '../auth/middleware.js';
import { requireRead, resolveEffectiveFineGrained } from './permissions-utils.js';
import type { ObsidianFineGrained } from '../db/schema.js';
import { getConnectionManager } from '../connections/manager.js';
import { ObsidianVaultSync, type VaultFileEntry } from '../sync/obsidian.js';
import { validateGitRemoteUrl } from '../auth/ssrf.js';
import {
  z, intParam, requiredString, wildcardPath,
  bodyOf, paramsOf, validateBody, validateParams,
} from './validate.js';
import { documentRoute } from './openapi-registry.js';

const router = Router();

// ── Request schemas ───────────────────────────────────────────────────────────

const VaultIdParam = z.object({ id: intParam('vault') });

const VaultFileParams = z.object({
  id: intParam('vault'),
  path: wildcardPath.openapi({ description: 'Vault-relative file path.' }),
});

const CreateVaultBody = z.object({
  name: requiredString('name'),
  remote_url: requiredString('remote_url').openapi({ description: 'git remote (https or ssh).' }),
  auth_type: z.enum(['https', 'ssh']).default('https'),
  https_token: z.string().optional(),
  ssh_private_key: z.string().optional(),
  ssh_public_key: z.string().optional(),
  branch: z.string().default('main'),
});

const UpdateVaultBody = z.object({
  name: z.string().optional(),
  remote_url: z.string().optional(),
  auth_type: z.enum(['https', 'ssh']).optional(),
  https_token: z.string().optional(),
  ssh_private_key: z.string().optional(),
  ssh_public_key: z.string().optional(),
  branch: z.string().optional(),
});

const DeleteVaultBody = z.object({
  delete_local: z.boolean().default(false)
    .openapi({ description: 'Also remove the local clone from disk.' }),
});

for (const specPath of [
  '/obsidian/vaults/{id}',
  '/obsidian/vaults/{id}/ssh-key',
  '/obsidian/vaults/{id}/sync-status',
  '/obsidian/vaults/{id}/files',
] as const) {
  documentRoute({ method: 'get', path: specPath, params: VaultIdParam });
}
for (const specPath of [
  '/obsidian/vaults/{id}/test',
  '/obsidian/vaults/{id}/generate-ssh-key',
  '/obsidian/vaults/{id}/clone',
  '/obsidian/vaults/{id}/sync',
] as const) {
  documentRoute({ method: 'post', path: specPath, params: VaultIdParam });
}
documentRoute({ method: 'get', path: '/obsidian/vaults/{id}/files/{path}', params: VaultFileParams });
documentRoute({ method: 'post', path: '/obsidian/vaults', body: CreateVaultBody });
documentRoute({ method: 'put', path: '/obsidian/vaults/{id}', params: VaultIdParam, body: UpdateVaultBody });
documentRoute({ method: 'delete', path: '/obsidian/vaults/{id}', params: VaultIdParam, body: DeleteVaultBody, bodyRequired: false });

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

router.post('/vaults', uiOnlyAuth, validateBody(CreateVaultBody), async (req, res) => {
  const db = getDb();
  const {
    name, remote_url, auth_type, https_token, ssh_private_key, ssh_public_key, branch,
  } = bodyOf(CreateVaultBody, req);

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

router.get('/vaults/:id', optionalAuth, validateParams(VaultIdParam), (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

  const db = getDb();
  const manager = getConnectionManager();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row) { res.status(404).json({ error: 'Vault not found' }); return; }

  const status = manager.getObsidianVaultStatus(id);
  res.json({ vault: { ...stripSecrets(row), connectionStatus: status } });
});

// ── PUT /obsidian/vaults/:id — update a vault ─────────────────────────────

router.put('/vaults/:id', uiOnlyAuth, validateParams(VaultIdParam), validateBody(UpdateVaultBody), async (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

  const db = getDb();
  const existing = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!existing) { res.status(404).json({ error: 'Vault not found' }); return; }

  const {
    name, remote_url, auth_type, https_token, ssh_private_key, ssh_public_key, branch,
  } = bodyOf(UpdateVaultBody, req);

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

router.delete('/vaults/:id', uiOnlyAuth, validateParams(VaultIdParam), validateBody(DeleteVaultBody), async (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

  const db = getDb();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row) { res.status(404).json({ error: 'Vault not found' }); return; }

  const manager = getConnectionManager();
  manager.disconnectObsidianVault(id);

  const { delete_local } = bodyOf(DeleteVaultBody, req);
  if (delete_local && row.localPath && fs.existsSync(row.localPath)) {
    fs.rmSync(row.localPath, { recursive: true, force: true });
  }

  db.delete(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).run();
  res.json({ success: true });
});

// ── POST /obsidian/vaults/:id/test ────────────────────────────────────────

router.post('/vaults/:id/test', uiOnlyAuth, validateParams(VaultIdParam), async (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

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

router.post('/vaults/:id/generate-ssh-key', uiOnlyAuth, validateParams(VaultIdParam), async (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

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

router.get('/vaults/:id/ssh-key', optionalAuth, validateParams(VaultIdParam), (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

  const db = getDb();
  const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, id)).get();
  if (!row?.sshPublicKey) {
    res.status(404).json({ error: 'No SSH key generated for this vault.' });
    return;
  }
  res.json({ publicKey: row.sshPublicKey });
});

// ── GET /obsidian/vaults/:id/ssh-fingerprint ──────────────────────────────

router.get('/vaults/:id/ssh-fingerprint', optionalAuth, validateParams(VaultIdParam), async (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

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

router.post('/vaults/:id/clone', uiOnlyAuth, validateParams(VaultIdParam), async (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

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

router.get('/vaults/:id/sync-status', optionalAuth, validateParams(VaultIdParam), (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

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

router.post('/vaults/:id/sync', optionalAuth, validateParams(VaultIdParam), async (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

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

/**
 * Read-path allowlist filtering for API keys. A directory survives when it is
 * inside an allowed prefix, or is an ancestor of one (so the agent can walk
 * down to the allowed subtree). Files must be inside an allowed prefix.
 */
function readPathAllowlist(apiKeyId: number | null | undefined): string[] | null {
  if (!apiKeyId) return null;
  const fg = resolveEffectiveFineGrained('obsidian', apiKeyId) as ObsidianFineGrained | null;
  const paths = fg?.readPaths;
  return paths && paths.length > 0 ? paths : null;
}

function isPathReadable(filePath: string, allowlist: string[] | null): boolean {
  if (!allowlist) return true;
  return allowlist.some((prefix) => filePath.startsWith(prefix));
}

function filterVaultTree(entries: VaultFileEntry[], allowlist: string[]): VaultFileEntry[] {
  const out: VaultFileEntry[] = [];
  for (const entry of entries) {
    if (entry.type === 'file') {
      if (allowlist.some((prefix) => entry.path.startsWith(prefix))) out.push(entry);
      continue;
    }
    const dirWithin = allowlist.some((prefix) => entry.path.startsWith(prefix));
    const dirAncestor = allowlist.some((prefix) => prefix.startsWith(entry.path + '/'));
    if (!dirWithin && !dirAncestor) continue;
    const children = entry.children
      ? (dirWithin ? entry.children : filterVaultTree(entry.children, allowlist))
      : entry.children;
    out.push({ ...entry, children });
  }
  return out;
}

router.get('/vaults/:id/files', optionalAuth, requireRead('obsidian'), trackAiCall, validateParams(VaultIdParam), async (req, res) => {
  const { id } = paramsOf(VaultIdParam, req);

  const manager = getConnectionManager();
  const sync = manager.getObsidian(id);

  if (!sync) {
    res.status(503).json({ error: `Vault ${id} not connected` });
    return;
  }

  try {
    let files = await sync.listFiles();
    const allowlist = readPathAllowlist((req as AuthedRequest).apiKey?.id);
    if (allowlist) files = filterVaultTree(files, allowlist);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /obsidian/vaults/:id/files/* ─────────────────────────────────────

router.get('/vaults/:id/files/*path', optionalAuth, requireRead('obsidian'), trackAiCall, validateParams(VaultFileParams), async (req, res) => {
  const { id, path: rawPath } = paramsOf(VaultFileParams, req);

  const manager = getConnectionManager();
  const sync = manager.getObsidian(id);

  if (!sync) {
    res.status(503).json({ error: `Vault ${id} not connected` });
    return;
  }

  const filePath = decodeURIComponent(rawPath);

  if (!filePath) {
    res.status(400).json({ error: 'File path is required' });
    return;
  }

  const allowlist = readPathAllowlist((req as AuthedRequest).apiKey?.id);
  if (!isPathReadable(filePath, allowlist)) {
    res.status(403).json({ error: `Reading "${filePath}" is not permitted for this API key` });
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
