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
 *   GET    /api/smb/shares/:id/download/*     — download raw file as browser download
 *   POST   /api/smb/shares/:id/upload         — upload a file (multipart/form-data, ?path=dir)
 *
 * Writes go through POST /api/outbox with source: 'smb' and { shareId } in the JSON payload.
 */

import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/client.js';
import { smbShareConfig } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { optionalAuth, uiOnlyAuth, type AuthedRequest } from '../auth/middleware.js';
import { requireRead, resolveSmbPathPermission, resolveEffectiveFineGrained } from './permissions-utils.js';
import type { SmbFineGrained } from '../db/schema.js';
import { getConnectionManager } from '../connections/manager.js';
import { SmbSync } from '../sync/smb.js';
import {
  z, intParam, requiredString, trimmedString, wildcardPath,
  bodyOf, paramsOf, queryOf, validateBody, validateParams, validateQuery,
} from './validate.js';
import { documentRoute } from './openapi-registry.js';

// Multer: store uploads in memory (max 100 MB per file)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

type ShareRow = typeof smbShareConfig.$inferSelect;

/** Strip password before sending to client. */
function stripSecrets(row: ShareRow) {
  const { password, ...safe } = row;
  void password; // explicitly unused
  return { ...safe, hasPassword: true };
}

// ── Request schemas ───────────────────────────────────────────────────────────

const ShareIdParam = z.object({ id: intParam('share') });

const ShareFileParams = z.object({
  id: intParam('share'),
  path: wildcardPath.openapi({ description: 'Share-relative file path.' }),
});

const CreateShareBody = z.object({
  name: trimmedString('name'),
  host: trimmedString('host'),
  share: trimmedString('share'),
  domain: z.string().optional(),
  username: trimmedString('username'),
  // NOT trimmed: a password may legitimately begin or end with whitespace.
  password: requiredString('password'),
});

const UpdateShareBody = z.object({
  name: z.string().optional(),
  host: z.string().optional(),
  share: z.string().optional(),
  domain: z.string().nullable().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});

const DirQuery = z.object({
  path: z.string().default('').openapi({ description: 'Directory within the share (default: root).' }),
});

documentRoute({ method: 'get', path: '/smb/shares/{id}', params: ShareIdParam });
documentRoute({ method: 'get', path: '/smb/shares/{id}/status', params: ShareIdParam });
documentRoute({ method: 'get', path: '/smb/shares/{id}/files', params: ShareIdParam, query: DirQuery });
documentRoute({ method: 'get', path: '/smb/shares/{id}/files/{path}', params: ShareFileParams });
documentRoute({
  method: 'get',
  path: '/smb/shares/{id}/download/{path}',
  params: ShareFileParams,
  summary: 'Download the raw bytes of a file on an SMB share',
  description: 'Returns the file as a binary attachment with a guessed Content-Type. Use GET /smb/shares/{id}/files/{path} to read text content instead.',
  responses: {
    200: { description: 'Raw file bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    403: { description: 'Reading this path is not permitted for this API key' },
    404: { description: 'File not found on the share' },
    503: { description: 'Share not connected' },
  },
});
documentRoute({ method: 'post', path: '/smb/shares/{id}/test', params: ShareIdParam });
documentRoute({ method: 'post', path: '/smb/shares/{id}/connect', params: ShareIdParam });
documentRoute({ method: 'post', path: '/smb/shares/{id}/disconnect', params: ShareIdParam });
documentRoute({ method: 'post', path: '/smb/shares', body: CreateShareBody });

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

router.post('/shares', uiOnlyAuth, validateBody(CreateShareBody), (req, res) => {
  const db = getDb();
  const { name, host, share, domain, username, password } = bodyOf(CreateShareBody, req);

  const result = db.insert(smbShareConfig)
    .values({
      name,
      host,
      share,
      domain: domain?.trim() || null,
      username,
      password,
    })
    .returning()
    .get();

  res.status(201).json(stripSecrets(result));
});

// ── GET /smb/shares/:id — get a single share ──────────────────────────────────

router.get('/shares/:id', optionalAuth, validateParams(ShareIdParam), (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

  const db = getDb();
  const manager = getConnectionManager();
  const row = db.select().from(smbShareConfig).where(eq(smbShareConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Share not found' });

  const status = manager.getSmbShareStatus(id);
  res.json({ ...stripSecrets(row), connectionStatus: status });
});

// ── PUT /smb/shares/:id — update a share ──────────────────────────────────────

router.put('/shares/:id', uiOnlyAuth, validateParams(ShareIdParam), validateBody(UpdateShareBody), (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

  const db = getDb();
  const row = db.select().from(smbShareConfig).where(eq(smbShareConfig.id, id)).get();
  if (!row) return res.status(404).json({ error: 'Share not found' });

  const { name, host, share, domain, username, password } = bodyOf(UpdateShareBody, req);

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

router.delete('/shares/:id', uiOnlyAuth, validateParams(ShareIdParam), (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

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

router.post('/shares/:id/test', optionalAuth, validateParams(ShareIdParam), async (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

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

router.post('/shares/:id/connect', optionalAuth, validateParams(ShareIdParam), async (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

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

router.post('/shares/:id/disconnect', optionalAuth, validateParams(ShareIdParam), (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

  const manager = getConnectionManager();
  manager.disconnectSmbShare(id);
  res.json({ success: true });
});

// ── GET /smb/shares/:id/status — connection status ────────────────────────────

router.get('/shares/:id/status', optionalAuth, validateParams(ShareIdParam), (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

  const manager = getConnectionManager();
  res.json(manager.getSmbShareStatus(id));
});

// ── GET /smb/shares/:id/files — list directory ────────────────────────────────

router.get('/shares/:id/files', optionalAuth, requireRead('smb'), validateParams(ShareIdParam), validateQuery(DirQuery), async (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

  const manager = getConnectionManager();
  const sync = manager.getSmbShare(id);
  if (!sync) return res.status(503).json({ error: 'Share not connected' });

  const dirPath = queryOf(DirQuery, req).path;

  try {
    let entries = await sync.listDirectory(dirPath);

    // Path allowlist for API keys: keep entries inside an allowed prefix, plus
    // directories that are ancestors of one (so the allowed subtree is reachable).
    const apiKeyId = (req as AuthedRequest).apiKey?.id;
    if (apiKeyId) {
      const fg = resolveEffectiveFineGrained('smb', apiKeyId) as SmbFineGrained | null;
      if (fg?.readEnabled === false) {
        return res.status(403).json({ error: 'SMB read access is not permitted for this API key' });
      }
      const readPaths = fg?.readPaths ?? [];
      if (readPaths.length > 0) {
        entries = entries.filter((e) =>
          readPaths.some((prefix) => e.path.startsWith(prefix) || prefix.startsWith(e.path + '/')),
        );
      }
    }

    res.json({ path: dirPath || '/', entries });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── GET /smb/shares/:id/files/* — read file contents ─────────────────────────

router.get('/shares/:id/files/*path', optionalAuth, requireRead('smb'), validateParams(ShareFileParams), async (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

  const filePath = paramsOf(ShareFileParams, req).path;
  if (!filePath) return res.status(400).json({ error: 'File path is required' });

  if (!resolveSmbPathPermission(filePath, 'read', (req as AuthedRequest).apiKey?.id)) {
    return res.status(403).json({ error: `Reading "${filePath}" is not permitted for this API key` });
  }

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

// ── GET /smb/shares/:id/download/* — download raw file as browser blob ────────

router.get('/shares/:id/download/*path', optionalAuth, requireRead('smb'), validateParams(ShareFileParams), async (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

  const filePath = paramsOf(ShareFileParams, req).path;
  if (!filePath) return res.status(400).json({ error: 'File path is required' });

  if (!resolveSmbPathPermission(filePath, 'read', (req as AuthedRequest).apiKey?.id)) {
    return res.status(403).json({ error: `Reading "${filePath}" is not permitted for this API key` });
  }

  const manager = getConnectionManager();
  const sync = manager.getSmbShare(id);
  if (!sync) return res.status(503).json({ error: 'Share not connected' });

  try {
    const content = await sync.readFile(filePath);
    const fileName = filePath.split('/').pop() ?? filePath;
    // Detect MIME type from extension
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
      zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
      txt: 'text/plain', md: 'text/markdown', json: 'application/json',
      csv: 'text/csv', html: 'text/html', xml: 'application/xml',
    };
    const contentType = mimeMap[ext] ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Length', String(content.length));
    res.send(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not found') || msg.includes('STATUS_OBJECT_NAME_NOT_FOUND')) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }
    res.status(500).json({ error: msg });
  }
});

// ── POST /smb/shares/:id/upload — upload a file to the share ─────────────────

router.post('/shares/:id/upload', uiOnlyAuth, upload.single('file'), validateParams(ShareIdParam), validateQuery(DirQuery), async (req, res) => {
  const { id } = paramsOf(ShareIdParam, req);

  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file provided' });

  const manager = getConnectionManager();
  const sync = manager.getSmbShare(id);
  if (!sync) return res.status(503).json({ error: 'Share not connected' });

  // Target directory path within the share (default: root)
  const dirPath = queryOf(DirQuery, req).path.replace(/\\/g, '/').replace(/^\/*/, '');
  const targetPath = dirPath ? `${dirPath}/${file.originalname}` : file.originalname;

  try {
    // Write the raw buffer directly to the SMB share (bypasses the string-only outbox path)
    await sync.writeFileBuffer(targetPath, file.buffer);
    res.status(201).json({ success: true, path: targetPath });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('LIMIT_FILE_SIZE')) {
      return res.status(413).json({ error: 'File too large (max 100 MB)' });
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
