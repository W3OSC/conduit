import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { broadcast } from '../websocket/hub.js';

const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root: src/update/ → ../../.. (server package root) → ../../.. (monorepo root)
// In Docker dist/update/ → ../../.. is /app (same structure since .git is copied there)
const REPO_ROOT = path.resolve(__dirname, '../../..');

// Version file written by the Docker builder stage so the runtime image
// can serve a version string even if git describe fails.
const VERSION_FILE = path.join(REPO_ROOT, '.version');

export interface UpdateStatus {
  version: string;
  hasUpdate: boolean;
  commitsBehind: number;
  latestCommitSha: string;
  isDocker: boolean;
}

let cachedVersion: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastKnownStatus: UpdateStatus | null = null;

/** Run a shell command in the repo root directory. */
async function git(args: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, { cwd: REPO_ROOT });
  return stdout.trim();
}

/**
 * Compute the current app version via `git describe --tags --always`.
 * Falls back to the .version file (written by the Docker builder), then
 * to the APP_VERSION env var, then to 'unknown'.
 * The result is cached after first successful resolution.
 */
export async function getAppVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;

  // Try live git describe first (works locally and in Docker if .git is present)
  try {
    const version = await git('describe --tags --always --dirty=-modified');
    cachedVersion = version;
    return cachedVersion;
  } catch { /* git not available or no .git */ }

  // Fall back to the baked-in .version file (Docker runtime image)
  if (existsSync(VERSION_FILE)) {
    try {
      const version = readFileSync(VERSION_FILE, 'utf8').trim();
      if (version) {
        cachedVersion = version;
        return cachedVersion;
      }
    } catch { /* ignore */ }
  }

  // Fall back to APP_VERSION env var (set by Dockerfile ARG/ENV)
  if (process.env.APP_VERSION) {
    cachedVersion = process.env.APP_VERSION;
    return cachedVersion;
  }

  cachedVersion = 'unknown';
  return cachedVersion;
}

/**
 * Check whether the remote has commits that are not in HEAD.
 * Runs `git fetch origin` then counts commits ahead on the remote.
 * Returns null if git is unavailable (e.g. no .git directory).
 */
export async function checkForUpdates(): Promise<UpdateStatus | null> {
  const isDocker = process.env.DOCKER === 'true';
  const version = await getAppVersion();

  try {
    // Fetch without updating local refs so we don't disturb the working tree
    await git('fetch origin');

    const countStr = await git('rev-list HEAD..origin/HEAD --count');
    const commitsBehind = parseInt(countStr, 10) || 0;

    let latestCommitSha = '';
    try {
      latestCommitSha = await git('rev-parse --short origin/HEAD');
    } catch { /* ignore */ }

    const status: UpdateStatus = {
      version,
      hasUpdate: commitsBehind > 0,
      commitsBehind,
      latestCommitSha,
      isDocker,
    };

    lastKnownStatus = status;
    return status;
  } catch (err) {
    // git not available or no remote — return a no-update status so the
    // version string is still served, just without update checking.
    console.warn('[update] Could not check for updates:', err instanceof Error ? err.message : err);
    const status: UpdateStatus = {
      version,
      hasUpdate: false,
      commitsBehind: 0,
      latestCommitSha: '',
      isDocker,
    };
    lastKnownStatus = status;
    return status;
  }
}

/** Return the last known status without hitting git again. */
export function getLastKnownStatus(): UpdateStatus | null {
  return lastKnownStatus;
}

/**
 * Pull the latest commits from the remote using --ff-only to avoid
 * accidental merges. Invalidates the cached version so the next call
 * to getAppVersion() re-runs git describe.
 */
export async function applyUpdate(): Promise<{ success: boolean; message: string }> {
  try {
    const output = await git('pull --ff-only origin HEAD');
    // Bust the version cache so the next status call reflects the new HEAD
    cachedVersion = null;
    lastKnownStatus = null;
    return { success: true, message: output || 'Pulled latest changes.' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }
}

/**
 * Start a background poller that checks for updates every `intervalMs` ms.
 * Broadcasts a `update:available` WebSocket event when new commits are found.
 * Also performs an initial check immediately on startup.
 */
export function startUpdatePoller(intervalMs = 3_600_000): void {
  // Initial check shortly after startup (don't block the server boot)
  setTimeout(async () => {
    try {
      const status = await checkForUpdates();
      if (status?.hasUpdate) {
        broadcast({ type: 'update:available', data: status });
      }
    } catch { /* ignore */ }
  }, 15_000); // 15 s after boot to let connections settle

  pollTimer = setInterval(async () => {
    try {
      const status = await checkForUpdates();
      if (status?.hasUpdate) {
        broadcast({ type: 'update:available', data: status });
      }
    } catch { /* ignore */ }
  }, intervalMs);

  // Don't let this timer keep the process alive if everything else shuts down
  if (pollTimer.unref) pollTimer.unref();

  console.log(`[update] Update poller started (interval: ${intervalMs / 60_000} min)`);
}


