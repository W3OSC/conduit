/**
 * SmbSync — SMB2 file share integration.
 *
 * Provides access to Windows/Samba SMB2 network shares via the @marsaud/smb2
 * library. Supports listing directories, reading files, and write operations
 * (create, overwrite, rename, delete files/directories).
 *
 * Reads execute directly. Writes go through the outbox and execute on approval.
 *
 * Multiple named shares are supported (multi-share, like Obsidian vaults).
 * Each share has its own SmbSync instance managed by ConnectionManager.
 */

import SMB2 from '@marsaud/smb2';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SmbConfig {
  id: number;
  name: string;      // friendly label, e.g. "NAS Documents"
  host: string;      // SMB server hostname or IP, e.g. "192.168.1.10"
  share: string;     // share name, e.g. "documents" (no slashes — we build the UNC path)
  domain?: string | null;
  username: string;
  password: string;
}

export interface SmbEntry {
  name: string;
  path: string;       // relative path from share root (using forward slashes)
  type: 'file' | 'directory';
}

// Write actions — go through the outbox, executed on approval.
// shareId identifies which share to target (required for multi-share setups).
export type SmbWriteAction =
  | { action: 'create_file';    path: string; content: string; shareId?: number }
  | { action: 'write_file';     path: string; content: string; shareId?: number }
  | { action: 'delete_file';    path: string; shareId?: number }
  | { action: 'rename_file';    oldPath: string; newPath: string; shareId?: number }
  | { action: 'create_directory'; path: string; shareId?: number };

// ── Constants ─────────────────────────────────────────────────────────────────

const CONNECTION_TIMEOUT_MS = 15_000;
const LIST_LIMIT = 10; // max entries returned by testConnection top-level listing

// ── SmbSync ───────────────────────────────────────────────────────────────────

export class SmbSync {
  public connected = false;
  public accountInfo: { displayName: string } | null = null;

  private config: SmbConfig | null = null;
  private client: SMB2 | null = null;

  // ── Connection ─────────────────────────────────────────────────────────────

  /**
   * Connect to an SMB share and verify access by listing the root directory.
   * Returns true on success.
   */
  async connect(config: SmbConfig): Promise<boolean> {
    this.disconnect();
    this.config = config;

    try {
      const client = this.buildClient(config);
      // Verify access by listing root — throws on auth failure or unreachable host
      await withTimeout(client.readdir(''), CONNECTION_TIMEOUT_MS, 'Connection timed out');
      this.client = client;
      this.connected = true;
      this.accountInfo = { displayName: `${config.name} (\\\\${config.host}\\${config.share})` };
      console.log(`[smb:${config.id}] Connected to \\\\${config.host}\\${config.share}`);
      return true;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`[smb:${config.id}] Connection failed:`, err);
      this.connected = false;
      this.client = null;
      this.accountInfo = null;
      throw e;
    }
  }

  disconnect(): void {
    if (this.client) {
      try { this.client.disconnect(); } catch { /* ignore disconnect errors */ }
      this.client = null;
    }
    this.connected = false;
    this.accountInfo = null;
    this.config = null;
  }

  // ── Directory listing ──────────────────────────────────────────────────────

  /**
   * List entries in a directory on the SMB share.
   * @param dirPath  Relative path from share root (use '' or '/' for root).
   *                 Forward slashes are converted to backslashes for SMB.
   * @param withStats  When true, distinguishes files from directories via stat.
   */
  async listDirectory(dirPath = ''): Promise<SmbEntry[]> {
    const client = this.assertConnected();
    const smbPath = toSmbPath(dirPath);

    const names = await withTimeout(
      client.readdir(smbPath, { stats: true }),
      CONNECTION_TIMEOUT_MS,
      'Directory listing timed out',
    ) as Array<{ name: string; isDirectory(): boolean }>;

    return names.map((entry) => {
      const relativePath = smbPath
        ? `${smbPath}\\${entry.name}`.replace(/\\/g, '/')
        : entry.name;
      return {
        name: entry.name,
        path: relativePath,
        type: entry.isDirectory() ? 'directory' : 'file',
      } as SmbEntry;
    });
  }

  // ── File read ──────────────────────────────────────────────────────────────

  /**
   * Read the contents of a file on the SMB share.
   * @param filePath  Relative path from share root (forward slashes OK).
   */
  async readFile(filePath: string): Promise<Buffer> {
    const client = this.assertConnected();
    validatePath(filePath);
    const smbPath = toSmbPath(filePath);
    return withTimeout(
      client.readFile(smbPath) as Promise<Buffer>,
      CONNECTION_TIMEOUT_MS,
      `Read timed out: ${filePath}`,
    );
  }

  // ── Write actions (called on outbox approval) ──────────────────────────────

  async executeAction(action: SmbWriteAction): Promise<string> {
    const client = this.assertConnected();

    switch (action.action) {
      case 'create_file': {
        validatePath(action.path);
        const smbPath = toSmbPath(action.path);
        const exists = await client.exists(smbPath);
        if (exists) {
          throw new Error(`File already exists: ${action.path}. Use write_file to overwrite.`);
        }
        // Ensure parent directory exists
        await ensureParentDir(client, smbPath);
        await withTimeout(
          client.writeFile(smbPath, action.content, { encoding: 'utf8' }),
          CONNECTION_TIMEOUT_MS,
          `Write timed out: ${action.path}`,
        );
        console.log(`[smb:${this.config!.id}] Created: ${action.path}`);
        return JSON.stringify({ path: action.path, action: 'created' });
      }

      case 'write_file': {
        validatePath(action.path);
        const smbPath = toSmbPath(action.path);
        // Ensure parent directory exists
        await ensureParentDir(client, smbPath);
        await withTimeout(
          client.writeFile(smbPath, action.content, { encoding: 'utf8' }),
          CONNECTION_TIMEOUT_MS,
          `Write timed out: ${action.path}`,
        );
        console.log(`[smb:${this.config!.id}] Written: ${action.path}`);
        return JSON.stringify({ path: action.path, action: 'written' });
      }

      case 'delete_file': {
        validatePath(action.path);
        const smbPath = toSmbPath(action.path);
        const exists = await client.exists(smbPath);
        if (!exists) {
          throw new Error(`File not found: ${action.path}`);
        }
        await withTimeout(
          client.unlink(smbPath),
          CONNECTION_TIMEOUT_MS,
          `Delete timed out: ${action.path}`,
        );
        console.log(`[smb:${this.config!.id}] Deleted: ${action.path}`);
        return JSON.stringify({ path: action.path, action: 'deleted' });
      }

      case 'rename_file': {
        validatePath(action.oldPath);
        validatePath(action.newPath);
        const oldSmbPath = toSmbPath(action.oldPath);
        const newSmbPath = toSmbPath(action.newPath);
        const exists = await client.exists(oldSmbPath);
        if (!exists) {
          throw new Error(`Source file not found: ${action.oldPath}`);
        }
        await ensureParentDir(client, newSmbPath);
        await withTimeout(
          client.rename(oldSmbPath, newSmbPath, { replace: false }),
          CONNECTION_TIMEOUT_MS,
          `Rename timed out: ${action.oldPath}`,
        );
        console.log(`[smb:${this.config!.id}] Renamed: ${action.oldPath} → ${action.newPath}`);
        return JSON.stringify({ oldPath: action.oldPath, newPath: action.newPath, action: 'renamed' });
      }

      case 'create_directory': {
        validatePath(action.path);
        const smbPath = toSmbPath(action.path);
        const exists = await client.exists(smbPath);
        if (exists) {
          throw new Error(`Directory already exists: ${action.path}`);
        }
        await withTimeout(
          client.mkdir(smbPath),
          CONNECTION_TIMEOUT_MS,
          `mkdir timed out: ${action.path}`,
        );
        console.log(`[smb:${this.config!.id}] Created directory: ${action.path}`);
        return JSON.stringify({ path: action.path, action: 'directory_created' });
      }

      default: {
        const _exhaustive: never = action;
        throw new Error(`Unknown SMB action: ${(_exhaustive as SmbWriteAction).action}`);
      }
    }
  }

  // ── Static: connection test ────────────────────────────────────────────────

  /**
   * Test connectivity to an SMB share without storing state.
   * Lists up to LIST_LIMIT top-level entries on success.
   * Returns { success: true, entries: string[] } or { success: false, error: string }.
   */
  static async testConnection(
    config: Omit<SmbConfig, 'id' | 'name'>,
  ): Promise<{ success: boolean; entries?: string[]; error?: string }> {
    let client: SMB2 | null = null;
    try {
      client = buildSmbClient(config);
      const raw = await withTimeout(
        client.readdir('', { stats: true }),
        CONNECTION_TIMEOUT_MS,
        'Connection timed out after 15 seconds',
      ) as Array<{ name: string; isDirectory(): boolean }>;

      const entries = raw
        .slice(0, LIST_LIMIT)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

      return { success: true, entries };
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      return { success: false, error: friendlyError(raw) };
    } finally {
      if (client) {
        try { client.disconnect(); } catch { /* ignore */ }
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private assertConnected(): SMB2 {
    if (!this.client || !this.connected) {
      throw new Error('SMB share not connected');
    }
    return this.client;
  }

  private buildClient(config: SmbConfig): SMB2 {
    return buildSmbClient(config);
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────────

function buildSmbClient(config: Omit<SmbConfig, 'id' | 'name'>): SMB2 {
  return new SMB2({
    share: `\\\\${config.host}\\${config.share}`,
    domain: config.domain ?? 'WORKGROUP',
    username: config.username,
    password: config.password,
    // Keep connection open for the lifetime of the sync instance.
    // We call disconnect() explicitly on shutdown.
    autoCloseTimeout: 0,
  });
}

/**
 * Convert a forward-slash relative path to a backslash SMB path.
 * Strips leading slashes.
 */
function toSmbPath(filePath: string): string {
  return filePath
    .replace(/^\/+/, '')          // strip leading slashes
    .replace(/\//g, '\\');        // forward → backslash
}

/**
 * Basic path traversal protection. Rejects paths containing '..'.
 */
function validatePath(filePath: string): void {
  if (filePath.includes('..')) {
    throw new Error(`Path traversal attempt detected: ${filePath}`);
  }
}

/**
 * Ensure all parent directories of a given SMB path exist, creating them if needed.
 */
async function ensureParentDir(client: SMB2, smbPath: string): Promise<void> {
  const parts = smbPath.split('\\').filter(Boolean);
  if (parts.length <= 1) return; // file is at share root, no parent to create

  // Walk from root, creating directories as needed
  let current = '';
  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}\\${parts[i]}` : parts[i];
    const exists = await client.exists(current);
    if (!exists) {
      await client.mkdir(current);
    }
  }
}

/**
 * Race a promise against a hard timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/**
 * Extract a human-readable error message from raw SMB/network error strings.
 */
function friendlyError(raw: string): string {
  // NT status codes → human messages
  if (raw.includes('STATUS_LOGON_FAILURE') || raw.includes('logon failure')) {
    return 'Authentication failed — check your username and password';
  }
  if (raw.includes('STATUS_ACCESS_DENIED') || raw.includes('access denied')) {
    return 'Access denied — the user may not have permission to access this share';
  }
  if (raw.includes('STATUS_BAD_NETWORK_NAME') || raw.includes('bad network name')) {
    return 'Share not found — check the share name';
  }
  if (raw.includes('ECONNREFUSED')) {
    return 'Connection refused — check the host address and that SMB (port 445) is accessible';
  }
  if (raw.includes('ENOTFOUND') || raw.includes('ENOENT')) {
    return 'Host not found — check the host address';
  }
  if (raw.includes('ETIMEDOUT') || raw.includes('timed out')) {
    return 'Connection timed out — check the host address and network connectivity';
  }
  // Trim long error strings
  return raw.split('\n')[0].slice(0, 200);
}
