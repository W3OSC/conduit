import { Router } from 'express';
import {
  checkForUpdates,
  applyUpdate,
  getLastKnownStatus,
  getAppVersion,
} from '../update/checker.js';

const router = Router();

/**
 * GET /api/update/status
 * Returns the current version string and whether an update is available.
 * Uses the cached last-known status to avoid a git fetch on every page load.
 * The background poller keeps this fresh hourly.
 */
router.get('/status', async (_req, res) => {
  try {
    // Return cached status immediately if available (no blocking git fetch)
    const cached = getLastKnownStatus();
    if (cached) {
      return res.json(cached);
    }
    // First request after boot — perform the check now (poller hasn't run yet)
    const status = await checkForUpdates();
    return res.json(status ?? {
      version: await getAppVersion(),
      hasUpdate: false,
      commitsBehind: 0,
      latestCommitSha: '',
      isDocker: process.env.DOCKER === 'true',
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /api/update/apply
 * Runs `git pull --ff-only origin HEAD`.
 * For Docker: code is pulled but the image must be rebuilt to take effect.
 * For local: code is pulled and the user should restart the server.
 */
router.post('/apply', async (_req, res) => {
  try {
    const result = await applyUpdate();
    const isDocker = process.env.DOCKER === 'true';

    if (result.success) {
      const followUp = isDocker
        ? 'Run `docker compose up --build` to rebuild and apply the changes.'
        : 'Restart the server (`npm run dev` or `node dist/index.js`) to apply the changes.';
      return res.json({ success: true, message: result.message, followUp });
    }

    return res.status(500).json({ success: false, message: result.message });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
