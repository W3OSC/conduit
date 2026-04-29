/**
 * SMB File Share API — multi-share REST routes for share configuration and file operations.
 *
 * Share management:
 *   GET    /api/smb/shares                    — list all configured shares (no passwords)
 *   POST   /api/smb/shares                    — create a new share config
 *   GET    /api/smb/shares/:id                — get a single share config (no password)
 *   PUT    /api/smb/shares/:id                — update a share config
 *   DELETE /api/smb/shares/:id                — remove a share config
 *
 * Per-share operations:
 *   POST   /api/smb/shares/:id/test           — test connection + return top 10 entries
 *   POST   /api/smb/shares/:id/connect        — connect this share
 *   POST   /api/smb/shares/:id/disconnect     — disconnect this share
 *   GET    /api/smb/shares/:id/status         — current connection status
 *
 * File operations:
 *   GET    /api/smb/shares/:id/files          — list directory (?path=subfolder)
 *   GET    /api/smb/shares/:id/files/*        — read file contents (path in URL)
 *
 * Writes go through POST /api/outbox with source: 'smb' and { shareId } in the JSON payload.
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { smbShareConfig } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth, uiOnlyAuth } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { SmbSync } from '../sync/smb.js';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

type ShareRow = typeof smbShareConfig.$inferSelect;

/** Strip password before sending to client. */
function stripSecrets(row: ShareRow) {
  const { password, ...safe } = row;
  void password; // explicitly unused
  return { ...safe, hasPassword: true };
}

function parseShareId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return isNaN(id) ? null : id;
}

// ── GET /smb/shares — list all shares ─────────────────────────────────────────

router.get('/shares', optionalAuth, (_req, res) => {
  const db = getDb();
  const manager = getConnectionManager();
  const rows = db.select().from(smbShareConfig).all();
  const shares = rows.map((row) => {
    const status = manager.getSmbShareStatus(row.id);
    return { ...stripSecrets(row), connectionStatus: status };
  });
  res.json({ shares });
});

// ── POST /smb/shares — create a new share ─────────────────────────────────────

router.post('/shares', uiOnlyAuth, (req, res) => {
  const db = getDb();
  const { name, host, share, domain, username, password } = req.body as {
    name?: string;
    host?: string;
    share?: string;
    domain?: string;
    username?: string;
    password?: string;
  };

  if (!name || !host || !share || !username || !password) {
    return res.status(400).json({ error: 'name, host, share, username, and password are required' });
  }

  const result = db.insert(smbShareConfig)
    .values({
      name: name.trim(),
      host: host.trim(),
      share: share.trim(),
      domain: domain?.trim() || null,
      username: username.trim(),
      password,
    })
    .returning()
    .get();

  res.status(201).json(stripSecrets(result));
});

// ── GET /smb/shares/:id — get a single share ──────────────────────────────────

router.get('/shares/:id', optionalAuth, (req, res) => {
  const id = parseShareId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid share ID' });

  const db = getDb();
  const manager = getConnectionManager();
  const row = db.select().from(smbShareConfig).where(eq(smbShareConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Share not found' });

  const status = manager.getSmbShareStatus(id);
  res.json({ ...stripSecrets(row), connectionStatus: status });
});

// ── PUT /smb/shares/:id — update a share ──────────────────────────────────────

router.put('/shares/:id', uiOnlyAuth, (req, res) => {
  const id = parseShareId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid share ID' });

  const db = getDb();
  const row = db.select().from(smbShareConfig).where(eq(smbShareConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Share not found' });

  const { name, host, share, domain, username, password } = req.body as Partial<{
    name: string; host: string; share: string; domain: string | null;
    username: string; password: string;
  }>;

  const updates: Partial<typeof smbShareConfig.$inferInsert> & { updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  };
  if (name !== undefined)     updates.name     = name.trim();
  if (host !== undefined)     updates.host     = host.trim();
  if (share !== undefined)    updates.share    = share.trim();
  if (domain !== undefined)   updates.domain   = domain?.trim() || null;
  if (username !== undefined) updates.username = username.trim();
  if (password !== undefined) updates.password = password;

  const updated = db.update(smbShareConfig)
    .set(updates)
    .where(eq(smbShareConfig.id, id))
    .returning()
    .get();

  res.json(stripSecrets(updated));
});

// ── DELETE /smb/shares/:id — remove a share ───────────────────────────────────

router.delete('/shares/:id', uiOnlyAuth, (req, res) => {
  const id = parseShareId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid share ID' });

  const db = getDb();
  const row = db.select().from(smbShareConfig).where(eq(smbShareConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Share not found' });

  // Disconnect the live instance before removing the config
  const manager = getConnectionManager();
  manager.disconnectSmbShare(id);

  db.delete(smbShareConfig).where(eq(smbShareConfig.id, id)).run();
  res.json({ success: true });
});

// ── POST /smb/shares/:id/test — test connection ───────────────────────────────

router.post('/shares/:id/test', optionalAuth, async (req, res) => {
  const id = parseShareId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid share ID' });

  const db = getDb();
  const row = db.select().from(smbShareConfig).where(eq(smbShareConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Share not found' });

  try {
    const result = await SmbSync.testConnection({
      host: row.host,
      share: row.share,
      domain: row.domain,
      username: row.username,
      password: row.password,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /smb/shares/:id/connect — connect a share ───────────────────────────

router.post('/shares/:id/connect', optionalAuth, async (req, res) => {
  const id = parseShareId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid share ID' });

  const db = getDb();
  const row = db.select().from(smbShareConfig).where(eq(smbShareConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Share not found' });

  const manager = getConnectionManager();
  try {
    await manager.connectSmbShare(id);
    res.json({ success: true, status: manager.getSmbShareStatus(id) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── POST /smb/shares/:id/disconnect — disconnect a share ──────────────────────

router.post('/shares/:id/disconnect', optionalAuth, (req, res) => {
  const id = parseShareId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid share ID' });

  const manager = getConnectionManager();
  manager.disconnectSmbShare(id);
  res.json({ success: true });
});

// ── GET /smb/shares/:id/status — connection status ────────────────────────────

router.get('/shares/:id/status', optionalAuth, (req, res) => {
  const id = parseShareId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid share ID' });

  const manager = getConnectionManager();
  res.json(manager.getSmbShareStatus(id));
});

// ── GET /smb/shares/:id/files — list directory ────────────────────────────────

router.get('/shares/:id/files', optionalAuth, async (req, res) => {
  const id = parseShareId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid share ID' });

  const manager = getConnectionManager();
  const sync = manager.getSmbShare(id);
  if (!sync) return res.status(503).json({ error: 'Share not connected' });

  const dirPath = (req.query['path'] as string | undefined) ?? '';

  try {
    const entries = await sync.listDirectory(dirPath);
    res.json({ path: dirPath || '/', entries });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /smb/shares/:id/files/* — read file contents ─────────────────────────

router.get('/shares/:id/files/*path', optionalAuth, async (req, res) => {
  const id = parseShareId(req.params['id'] as string);
  if (id === null) return res.status(400).json({ error: 'Invalid share ID' });

  const filePath = (req.params as Record<string, string>)['path'] ?? '';
  if (!filePath) return res.status(400).json({ error: 'File path is required' });

  const manager = getConnectionManager();
  const sync = manager.getSmbShare(id);
  if (!sync) return res.status(503).json({ error: 'Share not connected' });

  try {
    const content = await sync.readFile(filePath);
    // Detect binary vs text
    const isBinary = detectBinary(content);
    if (isBinary) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filePath.split('/').pop()}"`);
      res.send(content);
    } else {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(content.toString('utf-8'));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found') || msg.includes('STATUS_OBJECT_NAME_NOT_FOUND')) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }
    res.status(500).json({ error: msg });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Heuristic binary detection — checks the first 8KB for null bytes.
 */
function detectBinary(buf: Buffer): boolean {
  const sample = buf.slice(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export default router;
