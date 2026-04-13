/**
 * ObsidianVaultSync — git-backed Obsidian vault integration.
 *
 * Manages a local clone of a git repository that contains an Obsidian vault
 * (synced via the obsidian-git plugin). Handles:
 *   - Initial clone (HTTPS with PAT or SSH)
 *   - Periodic sync (git fetch + pull --ff-only)
 *   - File reads (with ensureInSync() guard)
 *   - File writes (with isInSync() guard → commit → push)
 *
 * Reads bypass the outbox and execute directly.
 * Writes go through the outbox and execute on approval.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { getDb } from '../db/client.js';
import { obsidianVaultConfig } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { broadcast } from '../websocket/hub.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VaultConfig {
  id: number;
  name: string;
  remoteUrl: string;
  authType: 'https' | 'ssh';
  httpsToken?: string | null;
  sshPrivateKey?: string | null;
  sshPublicKey?: string | null;
  localPath: string;
  branch: string;
  lastSyncedAt?: string | null;
}

export interface VaultFileEntry {
  path: string;       // relative path from vault root
  name: string;       // filename
  type: 'file' | 'directory';
  children?: VaultFileEntry[];
  extension?: string;
}

// Write actions — go through the outbox, executed on approval
export type ObsidianWriteAction =
  | { action: 'create_file'; path: string; content: string }
  | { action: 'write_file'; path: string; content: string }
  | { action: 'rename_file'; oldPath: string; newPath: string }
  | { action: 'delete_file'; path: string };

// ── Constants ─────────────────────────────────────────────────────────────────

const SYNC_STALE_MS = 4 * 60 * 1000; // 4 minutes — stale threshold before force-sync on read
const IGNORED_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const IGNORED_FILES = new Set(['.gitignore', '.DS_Store', 'Thumbs.db']);

// ── ObsidianVaultSync ─────────────────────────────────────────────────────────

export class ObsidianVaultSync {
  public connected = false;
  private config: VaultConfig | null = null;
  private git: SimpleGit | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSyncedAt: Date | null = null;
  private isSyncing = false;

  // ── Connection ─────────────────────────────────────────────────────────────

  /**
   * Initialize with an existing local clone.
   * If the local path doesn't exist yet, `clone()` must be called first.
   */
  async connect(config: VaultConfig): Promise<boolean> {
    this.config = config;

    if (!fs.existsSync(config.localPath)) {
      console.log(`[obsidian] Local path does not exist yet: ${config.localPath}`);
      return false;
    }

    try {
      const git = this.buildGit(config);
      // Verify it's a git repo
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        console.error(`[obsidian] Path exists but is not a git repo: ${config.localPath}`);
        return false;
      }
      this.git = git;
      this.connected = true;
      this.lastSyncedAt = config.lastSyncedAt ? new Date(config.lastSyncedAt) : null;
      console.log(`[obsidian] Connected to vault at ${config.localPath}`);
      return true;
    } catch (e) {
      console.error('[obsidian] Connect failed:', e);
      return false;
    }
  }

  /**
   * Clone the remote repository into localPath.
   * Handles both HTTPS (with optional PAT) and SSH (with private key).
   * Broadcasts discrete phase events via WebSocket during the clone process.
   */
  async clone(config: VaultConfig, onPhase?: (phase: string, message: string) => void): Promise<void> {
    this.config = config;

    const emitPhase = (phase: string, message: string) => {
      broadcast({ type: 'connection:status', data: { service: 'obsidian', status: 'connecting', mode: 'cloning', phase, message } });
      onPhase?.(phase, message);
    };

    fs.mkdirSync(path.dirname(config.localPath), { recursive: true });

    if (fs.existsSync(config.localPath)) {
      // Already exists — verify it's a repo
      const git = this.buildGit(config);
      const isRepo = await git.checkIsRepo().catch(() => false);
      if (isRepo) {
        console.log(`[obsidian] Repo already exists at ${config.localPath}, skipping clone`);
        this.git = git;
        this.connected = true;
        return;
      }
      // Exists but not a repo — remove and re-clone
      fs.rmSync(config.localPath, { recursive: true, force: true });
    }

    console.log(`[obsidian] Cloning ${config.remoteUrl} → ${config.localPath}`);
    emitPhase('connecting', 'Connecting to repository...');

    const remoteUrl = this.buildAuthenticatedUrl(config);
    const baseGit = this.buildBaseGit(config);

    emitPhase('cloning', 'Cloning repository...');

    await baseGit.clone(remoteUrl, config.localPath, ['--branch', config.branch]);

    emitPhase('finalizing', 'Finalizing...');

    this.git = this.buildGit(config);
    this.connected = true;
    console.log(`[obsidian] Clone complete`);
  }

  disconnect(): void {
    this.stopPolling();
    this.git = null;
    this.connected = false;
    this.config = null;
    this.lastSyncedAt = null;
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  /**
   * Fetch + pull --ff-only from remote.
   * Returns the new HEAD commit hash on success.
   */
  async sync(): Promise<string> {
    const git = this.assertConnected();
    const config = this.config!;

    if (this.isSyncing) {
      throw new Error('Sync already in progress');
    }

    this.isSyncing = true;
    this.updateDbStatus('syncing');
    broadcast({ type: 'connection:status', data: { service: 'obsidian', status: 'connecting', mode: 'syncing' } });

    try {
      // Configure remote with auth on every sync (token may have changed)
      await this.configureRemote(git, config);

      await git.fetch(['origin', config.branch]);
      await git.pull('origin', config.branch, ['--ff-only']);

      const log = await git.log({ maxCount: 1 });
      const commitHash = log.latest?.hash ?? '';

      this.lastSyncedAt = new Date();
      this.isSyncing = false;

      this.updateDbStatus('idle', { lastSyncedAt: this.lastSyncedAt.toISOString(), lastCommitHash: commitHash });
      broadcast({ type: 'connection:status', data: { service: 'obsidian', status: 'connected', lastSync: this.lastSyncedAt.toISOString() } });
      console.log(`[obsidian] Synced to ${commitHash.slice(0, 8)}`);
      return commitHash;
    } catch (e) {
      this.isSyncing = false;
      const err = e instanceof Error ? e.message : String(e);
      this.updateDbStatus('error', { syncError: err });
      broadcast({ type: 'connection:status', data: { service: 'obsidian', status: 'error', error: err } });
      throw e;
    }
  }

  /**
   * Check if the local repo is in sync with the remote (no unpulled commits).
   * Runs a `git fetch` first to ensure FETCH_HEAD is current.
   */
  async isInSync(): Promise<boolean> {
    const git = this.assertConnected();
    const config = this.config!;

    try {
      await this.configureRemote(git, config);
      await git.fetch(['origin', config.branch]);
      const localHead = await git.revparse(['HEAD']);
      const remoteHead = await git.revparse([`origin/${config.branch}`]);
      return localHead.trim() === remoteHead.trim();
    } catch {
      return false;
    }
  }

  /**
   * Ensure vault is in sync before a read operation.
   * Syncs if last sync was > SYNC_STALE_MS ago or never synced.
   */
  async ensureInSync(): Promise<void> {
    const now = Date.now();
    const isStale = !this.lastSyncedAt || (now - this.lastSyncedAt.getTime()) > SYNC_STALE_MS;
    if (isStale) {
      await this.sync();
    }
  }

  // ── File reads ─────────────────────────────────────────────────────────────

  /**
   * List all files in the vault as a tree structure.
   * Excludes .git/, .obsidian/, and other non-content directories.
   */
  async listFiles(): Promise<VaultFileEntry[]> {
    await this.ensureInSync();
    const config = this.config!;
    return this.walkDirectory(config.localPath, config.localPath);
  }

  /**
   * Read the contents of a file by relative path.
   */
  async readFile(relativePath: string): Promise<string> {
    await this.ensureInSync();
    const config = this.config!;
    const fullPath = this.resolvePath(config.localPath, relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return fs.readFileSync(fullPath, 'utf-8');
  }

  // ── Write actions (called on outbox approval) ──────────────────────────────

  async executeAction(action: ObsidianWriteAction): Promise<string> {
    const git = this.assertConnected();
    const config = this.config!;

    // Safety check: must be in sync before writing
    const inSync = await this.isInSync();
    if (!inSync) {
      throw new Error('Vault is not in sync with remote. Please wait for sync and try again.');
    }

    switch (action.action) {
      case 'create_file': {
        const fullPath = this.resolvePath(config.localPath, action.path);
        if (fs.existsSync(fullPath)) {
          throw new Error(`File already exists: ${action.path}. Use write_file to overwrite.`);
        }
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, action.content, 'utf-8');
        await git.add(fullPath);
        await git.commit(`Create ${action.path}\n\n[via Conduit]`);
        await this.pushWithAuth(git, config);
        return JSON.stringify({ path: action.path, action: 'created' });
      }

      case 'write_file': {
        const fullPath = this.resolvePath(config.localPath, action.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, action.content, 'utf-8');
        await git.add(fullPath);
        await git.commit(`Update ${action.path}\n\n[via Conduit]`);
        await this.pushWithAuth(git, config);
        return JSON.stringify({ path: action.path, action: 'written' });
      }

      case 'rename_file': {
        const oldFull = this.resolvePath(config.localPath, action.oldPath);
        const newFull = this.resolvePath(config.localPath, action.newPath);
        if (!fs.existsSync(oldFull)) {
          throw new Error(`Source file not found: ${action.oldPath}`);
        }
        fs.mkdirSync(path.dirname(newFull), { recursive: true });
        await git.mv(oldFull, newFull);
        await git.commit(`Rename ${action.oldPath} → ${action.newPath}\n\n[via Conduit]`);
        await this.pushWithAuth(git, config);
        return JSON.stringify({ oldPath: action.oldPath, newPath: action.newPath, action: 'renamed' });
      }

      case 'delete_file': {
        const fullPath = this.resolvePath(config.localPath, action.path);
        if (!fs.existsSync(fullPath)) {
          throw new Error(`File not found: ${action.path}`);
        }
        await git.rm([fullPath]);
        await git.commit(`Delete ${action.path}\n\n[via Conduit]`);
        await this.pushWithAuth(git, config);
        return JSON.stringify({ path: action.path, action: 'deleted' });
      }

      default: {
        const _exhaustive: never = action;
        throw new Error(`Unknown Obsidian action: ${(_exhaustive as ObsidianWriteAction).action}`);
      }
    }
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  startPolling(intervalMs: number): void {
    if (this.pollingTimer) return;
    this.pollingTimer = setInterval(async () => {
      try {
        await this.sync();
      } catch (e) {
        console.error('[obsidian] Polling sync failed:', e);
      }
    }, intervalMs);
    console.log(`[obsidian] Polling every ${intervalMs / 1000}s`);
  }

  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(): { syncStatus: string; lastSyncedAt: string | null; lastCommitHash: string | null; error?: string } {
    if (!this.config) return { syncStatus: 'idle', lastSyncedAt: null, lastCommitHash: null };

    const db = getDb();
    const row = db.select().from(obsidianVaultConfig).where(eq(obsidianVaultConfig.id, this.config.id)).get();
    return {
      syncStatus: row?.syncStatus ?? 'idle',
      lastSyncedAt: row?.lastSyncedAt ?? null,
      lastCommitHash: row?.lastCommitHash ?? null,
      error: row?.syncError ?? undefined,
    };
  }

  // ── SSH key generation ─────────────────────────────────────────────────────

  /**
   * Test connectivity to the remote repository without cloning.
   * Runs `git ls-remote` with the configured credentials.
   * Returns { success: true } or { success: false, error: string }.
   */
  static async testConnection(config: Pick<VaultConfig, 'remoteUrl' | 'authType' | 'httpsToken' | 'sshPrivateKey'>): Promise<{ success: boolean; error?: string }> {
    const TEST_TIMEOUT_MS = 15_000;

    // Validate that credentials are present before even trying
    if (config.authType === 'ssh' && !config.sshPrivateKey) {
      return { success: false, error: 'No SSH key found. Generate an SSH key first.' };
    }
    if (config.authType === 'https' && !config.httpsToken) {
      return { success: false, error: 'No personal access token saved. Enter and save your token first.' };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-test-'));
    try {
      const options: Partial<SimpleGitOptions> = {
        baseDir: tmpDir,
        binary: 'git',
        maxConcurrentProcesses: 1,
        // Abort git subprocess if it takes too long
        timeout: { block: TEST_TIMEOUT_MS },
      };
      const git = simpleGit(options);

      // Disable interactive prompts so git fails fast instead of hanging
      git.env({
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      });

      // Build authenticated URL / env
      let remoteUrl = config.remoteUrl;

      if (config.authType === 'ssh' && config.sshPrivateKey) {
        const keyPath = path.join(tmpDir, 'id');
        fs.writeFileSync(keyPath, config.sshPrivateKey, { mode: 0o600 });
        git.env({
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          GIT_SSH_COMMAND: `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10`,
        });
      } else if (config.authType === 'https' && config.httpsToken) {
        try {
          const url = new URL(config.remoteUrl);
          url.password = config.httpsToken;
          url.username = 'x-token';
          remoteUrl = url.toString();
        } catch { /* not a valid URL — use as-is */ }
      }

      // Race the git operation against a hard timeout
      const testPromise = git.listRemote(['--heads', remoteUrl]);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connection timed out after 15 seconds')), TEST_TIMEOUT_MS),
      );

      await Promise.race([testPromise, timeoutPromise]);
      return { success: true };
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Extract the most human-readable part of the git error
      const match = raw.match(/(?:fatal|error): (.+)/i);
      const error = match ? match[1].trim() : raw.split('\n')[0].trim();
      return { success: false, error };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Compute the SHA256 fingerprint of an SSH public key string.
   * Returns a string like "SHA256:ZXi+15yL..." or null on failure.
   */
  static async getPublicKeyFingerprint(publicKey: string): Promise<string | null> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-fp-'));
    const keyPath = path.join(tmpDir, 'key.pub');
    try {
      fs.writeFileSync(keyPath, publicKey.trim() + '\n', 'utf-8');
      const { stdout } = await execFileAsync('ssh-keygen', ['-l', '-E', 'sha256', '-f', keyPath]);
      // stdout: "256 SHA256:xxxx comment (ED25519)"
      const match = stdout.match(/SHA256:\S+/);
      return match ? match[0] : null;
    } catch {
      return null;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Generate a new Ed25519 SSH key pair.
   * Returns { privateKey, publicKey } as PEM strings.
   * Requires the system `ssh-keygen` utility.
   */
  static async generateSshKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-ssh-'));
    const keyPath = path.join(tmpDir, 'id_ed25519');

    try {
      await execFileAsync('ssh-keygen', [
        '-t', 'ed25519',
        '-C', 'conduit@obsidian-vault',
        '-f', keyPath,
        '-N', '',  // no passphrase
      ]);
      const privateKey = fs.readFileSync(keyPath, 'utf-8');
      const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf-8');
      return { privateKey, publicKey };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private assertConnected(): SimpleGit {
    if (!this.git) throw new Error('Obsidian vault not connected');
    return this.git;
  }

  /**
   * Build a SimpleGit instance configured for the given vault.
   * For SSH auth, writes the private key to a temp file and sets GIT_SSH_COMMAND.
   */
  private buildGit(config: VaultConfig): SimpleGit {
    const options: Partial<SimpleGitOptions> = {
      baseDir: config.localPath,
      binary: 'git',
      maxConcurrentProcesses: 1,
    };

    const git = simpleGit(options);

    if (config.authType === 'ssh' && config.sshPrivateKey) {
      git.env({ ...process.env, ...this.buildSshEnv(config.sshPrivateKey) });
    }

    return git;
  }

  /**
   * Build a base SimpleGit instance for operations that don't have a local dir yet (clone).
   */
  private buildBaseGit(config: VaultConfig): SimpleGit {
    const options: Partial<SimpleGitOptions> = {
      baseDir: path.dirname(config.localPath),
      binary: 'git',
      maxConcurrentProcesses: 1,
    };

    const git = simpleGit(options);

    if (config.authType === 'ssh' && config.sshPrivateKey) {
      git.env({ ...process.env, ...this.buildSshEnv(config.sshPrivateKey) });
    }

    return git;
  }

  /**
   * Build GIT_SSH_COMMAND env that uses a temp SSH key file.
   * We write the key each time to avoid stale file issues.
   */
  private buildSshEnv(privateKey: string): Record<string, string> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-ssh-'));
    const keyPath = path.join(tmpDir, 'id');
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    return {
      GIT_SSH_COMMAND: `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o BatchMode=yes`,
    };
  }

  /**
   * Build authenticated HTTPS URL with embedded PAT.
   * For SSH, the URL is used as-is (auth comes from GIT_SSH_COMMAND).
   */
  private buildAuthenticatedUrl(config: VaultConfig): string {
    if (config.authType === 'ssh') {
      return config.remoteUrl;
    }
    if (config.httpsToken) {
      try {
        const url = new URL(config.remoteUrl);
        url.password = config.httpsToken;
        url.username = 'x-token';
        return url.toString();
      } catch {
        // Not a valid URL — return as-is
        return config.remoteUrl;
      }
    }
    return config.remoteUrl;
  }

  /**
   * Configure the 'origin' remote to use authenticated URL.
   * Called before fetch/pull to ensure fresh credentials.
   */
  private async configureRemote(git: SimpleGit, config: VaultConfig): Promise<void> {
    const authenticatedUrl = this.buildAuthenticatedUrl(config);
    try {
      await git.remote(['set-url', 'origin', authenticatedUrl]);
    } catch {
      // Remote may not exist in a newly cloned repo — add it
      await git.remote(['add', 'origin', authenticatedUrl]);
    }
  }

  /**
   * Push to remote with authentication configured.
   */
  private async pushWithAuth(git: SimpleGit, config: VaultConfig): Promise<void> {
    await this.configureRemote(git, config);
    await git.push('origin', config.branch);
    // Update sync state after a successful push
    this.lastSyncedAt = new Date();
    const log = await git.log({ maxCount: 1 });
    const commitHash = log.latest?.hash ?? '';
    this.updateDbStatus('idle', { lastSyncedAt: this.lastSyncedAt.toISOString(), lastCommitHash: commitHash });
  }

  /**
   * Update the vault config row in the DB with current sync status.
   */
  private updateDbStatus(
    status: string,
    extra?: { lastSyncedAt?: string; lastCommitHash?: string; syncError?: string },
  ): void {
    if (!this.config) return;
    try {
      const db = getDb();
      db.update(obsidianVaultConfig)
        .set({
          syncStatus: status,
          syncError: extra?.syncError ?? (status === 'idle' ? null : undefined),
          lastSyncedAt: extra?.lastSyncedAt,
          lastCommitHash: extra?.lastCommitHash,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(obsidianVaultConfig.id, this.config.id))
        .run();
    } catch (e) {
      console.error('[obsidian] Failed to update DB status:', e);
    }
  }

  /**
   * Resolve a relative vault path to an absolute path,
   * with path traversal protection.
   */
  private resolvePath(vaultRoot: string, relativePath: string): string {
    // Normalize and strip leading slashes/dots
    const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const full = path.resolve(vaultRoot, normalized);

    // Ensure the resolved path is within the vault
    if (!full.startsWith(path.resolve(vaultRoot))) {
      throw new Error(`Path traversal attempt detected: ${relativePath}`);
    }
    return full;
  }

  /**
   * Recursively walk the vault directory, returning a tree of file entries.
   */
  private walkDirectory(dirPath: string, vaultRoot: string): VaultFileEntry[] {
    const entries: VaultFileEntry[] = [];

    let items: string[];
    try {
      items = fs.readdirSync(dirPath);
    } catch {
      return entries;
    }

    for (const item of items.sort()) {
      if (IGNORED_FILES.has(item)) continue;
      if (item.startsWith('.')) {
        // Check if it's an ignored directory (like .git, .obsidian)
        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && IGNORED_DIRS.has(item)) continue;
        if (item.startsWith('.') && !IGNORED_DIRS.has(item)) {
          // Allow hidden files that aren't in ignored set (e.g., .canvas files)
        }
      }

      const fullPath = path.join(dirPath, item);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const relativePath = path.relative(vaultRoot, fullPath).replace(/\\/g, '/');

      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(item)) continue;
        const children = this.walkDirectory(fullPath, vaultRoot);
        entries.push({
          path: relativePath,
          name: item,
          type: 'directory',
          children,
        });
      } else {
        const ext = path.extname(item).toLowerCase();
        entries.push({
          path: relativePath,
          name: item,
          type: 'file',
          extension: ext,
        });
      }
    }

    return entries;
  }
}
