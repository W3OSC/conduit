/**
 * Google Drive API — multi-folder REST routes for Drive folder configuration
 * and file operations.
 *
 * Folder management:
 *   GET    /api/gdrive/accounts                       — list connected Gmail accounts that have Drive access
 *   GET    /api/gdrive/available-folders?email=&driveType=  — folders available to add (from Google API)
 *   GET    /api/gdrive/folders                        — list all whitelisted folder configs
 *   POST   /api/gdrive/folders                        — add a new whitelisted folder
 *   GET    /api/gdrive/folders/:id                    — get a single folder config
 *   PUT    /api/gdrive/folders/:id                    — update folder config (rename)
 *   DELETE /api/gdrive/folders/:id                    — remove folder from whitelist
 *   POST   /api/gdrive/folders/:id/sync               — trigger manual sync (force cache refresh)
 *   POST   /api/gdrive/folders/:id/test               — verify Drive access
 *
 * File operations:
 *   GET    /api/gdrive/folders/:id/files              — get file tree for folder
 *   GET    /api/gdrive/folders/:id/files/*            — read file contents (with format conversion)
 *
 * Writes go through POST /api/outbox with source: 'gdrive'.
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { googleDriveFolderConfig, googleDriveFileCache } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth, uiOnlyAuth } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseFolderId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return isNaN(id) ? null : id;
}

// ── GET /gdrive/accounts ───────────────────────────────────────────────────────
// Lists all Gmail accounts that have an active GdriveSyncManager instance.

router.get('/accounts', optionalAuth, (_req, res) => {
  const manager = getConnectionManager();
  const accounts = manager.getGdriveAccounts();
  res.json({ accounts });
});

// ── GET /gdrive/available-folders ─────────────────────────────────────────────
// Fetches the list of folders available to whitelist from Google's API.

router.get('/available-folders', optionalAuth, async (req, res) => {
  const email     = (req.query['email'] as string | undefined)?.trim();
  const driveType = ((req.query['driveType'] as string | undefined) ?? 'personal') as 'personal' | 'shared';

  if (!email) return res.status(400).json({ error: 'email query parameter is required' });

  const manager = getConnectionManager();
  const gdrive = manager.getGdrive(email);
  if (!gdrive) return res.status(404).json({ error: `No active Drive connection for ${email}` });

  try {
    const folders = await gdrive.listAvailableFolders(driveType);
    res.json({ folders });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /gdrive/folders — list all whitelisted folders ────────────────────────

router.get('/folders', optionalAuth, (_req, res) => {
  const db = getDb();
  const manager = getConnectionManager();
  const rows = db.select().from(googleDriveFolderConfig).all();
  const folders = rows.map((row) => ({
    ...row,
    connectionStatus: manager.getGdriveFolderStatus(row.id),
  }));
  res.json({ folders });
});

// ── POST /gdrive/folders — whitelist a new folder ─────────────────────────────

router.post('/folders', uiOnlyAuth, async (req, res) => {
  const { email, folderId, folderName, driveType, driveId } = req.body as {
    email?: string;
    folderId?: string;
    folderName?: string;
    driveType?: string;
    driveId?: string;
  };

  if (!email || !folderId || !folderName) {
    return res.status(400).json({ error: 'email, folderId, and folderName are required' });
  }

  const db = getDb();
  const result = db.insert(googleDriveFolderConfig)
    .values({
      email:      email.trim(),
      folderId:   folderId.trim(),
      folderName: folderName.trim(),
      driveType:  (driveType === 'shared' ? 'shared' : 'personal'),
      driveId:    driveId?.trim() || null,
      syncStatus: 'idle',
    })
    .returning()
    .get();

  // Kick off an initial sync in the background
  const manager = getConnectionManager();
  const gdrive = manager.getGdrive(email.trim());
  if (gdrive) {
    gdrive.syncFolder(result.id).catch((e) => console.error(`[gdrive:${result.id}] Initial sync failed:`, e));
    manager.startGdriveFolderPolling(result.id, email.trim());
  }

  res.status(201).json({ ...result, connectionStatus: manager.getGdriveFolderStatus(result.id) });
});

// ── GET /gdrive/folders/:id — get a single folder ─────────────────────────────

router.get('/folders/:id', optionalAuth, (req, res) => {
  const id = parseFolderId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid folder ID' });

  const db = getDb();
  const manager = getConnectionManager();
  const row = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Folder not found' });

  res.json({ ...row, connectionStatus: manager.getGdriveFolderStatus(id) });
});

// ── PUT /gdrive/folders/:id — rename / update a folder ────────────────────────

router.put('/folders/:id', uiOnlyAuth, (req, res) => {
  const id = parseFolderId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid folder ID' });

  const db = getDb();
  const row = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Folder not found' });

  const { folderName } = req.body as { folderName?: string };
  const updates: Partial<typeof googleDriveFolderConfig.$inferInsert> & { updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  };
  if (folderName) updates.folderName = folderName.trim();

  const updated = db.update(googleDriveFolderConfig)
    .set(updates)
    .where(eq(googleDriveFolderConfig.id, id))
    .returning()
    .get();

  const manager = getConnectionManager();
  res.json({ ...updated, connectionStatus: manager.getGdriveFolderStatus(id) });
});

// ── DELETE /gdrive/folders/:id — remove a folder from the whitelist ───────────

router.delete('/folders/:id', uiOnlyAuth, (req, res) => {
  const id = parseFolderId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid folder ID' });

  const db = getDb();
  const row = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Folder not found' });

  const manager = getConnectionManager();
  manager.stopGdriveFolderPolling(id);

  // Delete cached files and the config
  db.delete(googleDriveFileCache).where(eq(googleDriveFileCache.folderConfigId, id)).run();
  db.delete(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, id)).run();

  res.json({ success: true });
});

// ── POST /gdrive/folders/:id/test — verify access ────────────────────────────

router.post('/folders/:id/test', optionalAuth, async (req, res) => {
  const id = parseFolderId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid folder ID' });

  const db = getDb();
  const row = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Folder not found' });

  const manager = getConnectionManager();
  const gdrive = manager.getGdrive(row.email);
  if (!gdrive) return res.status(503).json({ error: `No active Drive connection for ${row.email}` });

  try {
    const folders = await gdrive.listAvailableFolders('personal');
    const found = folders.some((f) => f.folderId === row.folderId);
    res.json({
      accessible: true,
      folderFound: found,
      message: found
        ? `Folder "${row.folderName}" is accessible`
        : `Folder ID ${row.folderId} not found in listing — it may be a root or shared folder`,
    });
  } catch (e) {
    res.json({ accessible: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /gdrive/folders/:id/sync — trigger manual cache refresh ──────────────

router.post('/folders/:id/sync', optionalAuth, async (req, res) => {
  const id = parseFolderId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid folder ID' });

  const db = getDb();
  const row = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Folder not found' });

  const manager = getConnectionManager();
  const gdrive = manager.getGdrive(row.email);
  if (!gdrive) return res.status(503).json({ error: `No active Drive connection for ${row.email}` });

  try {
    await gdrive.syncFolder(id);
    const updated = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, id)).get();
    res.json({ success: true, folder: updated });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /gdrive/folders/:id/files — get file tree ─────────────────────────────

router.get('/folders/:id/files', optionalAuth, async (req, res) => {
  const id = parseFolderId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid folder ID' });

  const db = getDb();
  const row = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Folder not found' });

  const manager = getConnectionManager();
  const gdrive = manager.getGdrive(row.email);
  if (!gdrive) return res.status(503).json({ error: `No active Drive connection for ${row.email}` });

  const forceRefresh = req.query['refresh'] === 'true';

  try {
    const files = await gdrive.getFileTree(id, !forceRefresh);
    res.json({ folderId: id, folderName: row.folderName, files });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /gdrive/folders/:id/files/* — read file contents ──────────────────────

router.get('/folders/:id/files/*path', optionalAuth, async (req, res) => {
  const id = parseFolderId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid folder ID' });

  // The path parameter holds the Google Drive file ID (after the /files/ prefix)
  const fileId = (req.params as Record<string, string>)['path'] ?? '';
  if (!fileId) return res.status(400).json({ error: 'File ID is required' });

  const db = getDb();
  const row = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Folder not found' });

  // Verify file belongs to this folder (security check via cache)
  const cached = db.select().from(googleDriveFileCache)
    .where(eq(googleDriveFileCache.fileId, fileId))
    .get();
  if (cached && cached.folderConfigId !== id) {
    return res.status(403).json({ error: 'File does not belong to this folder config' });
  }

  const manager = getConnectionManager();
  const gdrive = manager.getGdrive(row.email);
  if (!gdrive) return res.status(503).json({ error: `No active Drive connection for ${row.email}` });

  try {
    const result = await gdrive.readFile(fileId, cached?.mimeType);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found') || msg.includes('404')) {
      return res.status(404).json({ error: `File not found: ${fileId}` });
    }
    res.status(500).json({ error: msg });
  }
});

export default router;
