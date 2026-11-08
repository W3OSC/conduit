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
  /** Current checkout branch ('' when git is unavailable). */
  branch: string;
  /** Uncommitted changes present (auto-update never touches a dirty tree). */
  dirty: boolean;
  /** Why auto-update will not run right now (null = it will when behind). */
  autoUpdateBlocked: string | null;
}

/**
 * Pure auto-apply gate — Meridian's rule: only a CLEAN checkout of the
 * DEFAULT branch self-updates; anything else just reports "blocked" and is
 * never touched. Returns null when auto-apply may proceed.
 */
export function autoUpdateBlockReason(s: {
  isDocker: boolean;
  branch: string;
  defaultBranch: string;
  dirty: boolean;
  enabled: boolean;
}): string | null {
  if (!s.enabled) return 'disabled (CONDUIT_AUTO_UPDATE=0)';
  if (s.isDocker) return 'docker image — rebuild to update';
  if (!s.branch) return 'not a git checkout';
  if (s.branch !== s.defaultBranch) return `checkout is on ${s.branch}, not ${s.defaultBranch}`;
  if (s.dirty) return 'working tree has uncommitted changes';
  return null;
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
  const enabled = process.env.CONDUIT_AUTO_UPDATE !== '0';
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

    const branch = await git('rev-parse --abbrev-ref HEAD').catch(() => '');
    const dirty = (await git('status --porcelain').catch(() => 'unknown')) !== '';
    // origin/HEAD → "origin/main" → "main"
    const defaultBranch = (await git('rev-parse --abbrev-ref origin/HEAD').catch(() => 'origin/main'))
      .replace(/^origin\//, '');

    const status: UpdateStatus = {
      version,
      hasUpdate: commitsBehind > 0,
      commitsBehind,
      latestCommitSha,
      isDocker,
      branch,
      dirty,
      autoUpdateBlocked: autoUpdateBlockReason({ isDocker, branch, defaultBranch, dirty, enabled }),
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
      branch: '',
      dirty: false,
      autoUpdateBlocked: 'git unavailable',
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
 * Auto-apply a pending update when the gate allows it (clean checkout of the
 * default branch, not Docker, not disabled). The pull itself makes `tsx watch`
 * restart the server on the new code; when dependencies changed, a detached
 * shell finishes `npm install` across that restart and then re-touches the
 * entry file so the watcher reloads once more with modules in place. Under a
 * plain `node dist` + CONDUIT_SUPERVISED=1, the process exits 0 instead and
 * the supervisor relaunches it.
 */
async function maybeAutoApply(status: UpdateStatus): Promise<void> {
  if (!status.hasUpdate || status.autoUpdateBlocked) return;

  const lockfileChanged = await git('diff --name-only HEAD..origin/HEAD')
    .then((out) => out.split('\n').some((f) => f.trim().endsWith('package-lock.json')))
    .catch(() => true); // unknown → assume yes, an extra npm install is harmless

  console.log(
    `[update] auto-applying ${status.commitsBehind} commit(s) → ${status.latestCommitSha}` +
    (lockfileChanged ? ' (dependencies changed — npm install will follow)' : ''),
  );
  const result = await applyUpdate();
  if (!result.success) {
    console.warn('[update] auto-apply pull failed:', result.message);
    return;
  }
  broadcast({ type: 'update:applied', data: { ...status, autoApplied: true } });

  if (lockfileChanged) {
    // Detached so it survives the tsx-watch restart the pull just triggered.
    const { spawn } = await import('child_process');
    const child = spawn(
      'sh',
      ['-c', 'npm install >> /tmp/conduit-self-update.log 2>&1; touch packages/server/src/index.ts'],
      { cwd: REPO_ROOT, detached: true, stdio: 'ignore' },
    );
    child.unref();
  }

  if (process.env.CONDUIT_SUPERVISED === '1') {
    console.log('[update] supervised mode — exiting 0 for relaunch');
    process.exit(0);
  }
}

/**
 * Start a background poller that checks for updates every `intervalMs` ms
 * (CONDUIT_UPDATE_INTERVAL_SECS overrides; default 5 min). Broadcasts
 * `update:available`, then auto-applies when the checkout is a clean default
 * branch — a feature branch or dirty tree is never touched, it just reports
 * blocked in /api/update/status. Also performs an initial check on startup.
 */
export function startUpdatePoller(intervalMs?: number): void {
  const envSecs = parseInt(process.env.CONDUIT_UPDATE_INTERVAL_SECS ?? '', 10);
  const interval = intervalMs ?? (Number.isFinite(envSecs) && envSecs >= 30 ? envSecs * 1000 : 300_000);

  const tick = async () => {
    try {
      const status = await checkForUpdates();
      if (status?.hasUpdate) {
        broadcast({ type: 'update:available', data: status });
        if (status.autoUpdateBlocked) {
          console.log(
            `[update] ${status.commitsBehind} commit(s) behind but auto-update blocked: ${status.autoUpdateBlocked}`,
          );
        }
        await maybeAutoApply(status);
      }
    } catch { /* ignore */ }
  };

  // Initial check shortly after startup (don't block the server boot)
  setTimeout(tick, 15_000); // 15 s after boot to let connections settle

  pollTimer = setInterval(tick, interval);

  // Don't let this timer keep the process alive if everything else shuts down
  if (pollTimer.unref) pollTimer.unref();

  console.log(`[update] Update poller started (interval: ${interval / 60_000} min, auto-apply ${process.env.CONDUIT_AUTO_UPDATE !== '0' ? 'on' : 'off'})`);
}


