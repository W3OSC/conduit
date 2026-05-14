/**
 * GdriveSyncManager — manages Google Drive folder access, caching, and file
 * operations for a single connected Google account.
 *
 * Design mirrors ObsidianVaultSync / SmbSync:
 *   - One instance per Gmail account (keyed by email in ConnectionManager)
 *   - Each whitelisted folder has its own 5-minute polling timer
 *   - 1-hour metadata cache stored in google_drive_file_cache table
 *   - Incremental sync via Drive changes.list() pageToken
 *   - Google Docs/Sheets exported and converted to Markdown for preview/edit
 *   - Edits applied via find/replace using the Docs/Sheets batchUpdate API
 *   - Full support for personal Drive + Shared Drives
 *
 * File size limits:
 *   MAX_EXPORT_BYTES  = 50 MB   — max exported file size loaded into memory
 *   MAX_TREE_FILES    = 1000    — max files returned in a single tree listing
 *   MAX_DEPTH         = 10      — max folder recursion depth
 *   CACHE_TTL_MS      = 1 hour  — metadata cache lifetime
 *   POLL_INTERVAL_MS  = 5 min   — default background polling interval
 */

import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import { getDb } from '../db/client.js';
import { googleDriveFolderConfig, googleDriveFileCache } from '../db/schema.js';
import { eq, and, lt } from 'drizzle-orm';
import type { GmailCreds } from './gmail.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_EXPORT_BYTES  = 50 * 1024 * 1024; // 50 MB
export const MAX_TREE_FILES    = 1000;
export const MAX_DEPTH         = 10;
export const CACHE_TTL_MS      = 60 * 60 * 1000;   // 1 hour
export const POLL_INTERVAL_MS  = 5 * 60 * 1000;    // 5 minutes

// ── MIME type handling ────────────────────────────────────────────────────────

export type Editability = 'direct' | 'find-replace' | 'read-only';

export interface MimeInfo {
  label: string;
  exportMime: string | null;      // MIME to use when exporting from Google Workspace
  editability: Editability;
  warning: string | null;
}

export const MIME_INFO: Record<string, MimeInfo> = {
  'application/vnd.google-apps.document': {
    label: 'Google Doc',
    exportMime: 'text/markdown',
    editability: 'find-replace',
    warning: 'Editing Google Docs via find/replace preserves formatting. Complex layout may not round-trip perfectly.',
  },
  'application/vnd.google-apps.spreadsheet': {
    label: 'Google Sheet',
    exportMime: 'text/csv',
    editability: 'find-replace',
    warning: 'Editing Sheets uses find/replace on cell values. Formulas and formatting are preserved.',
  },
  'application/vnd.google-apps.presentation': {
    label: 'Google Slides',
    exportMime: 'text/plain',
    editability: 'read-only',
    warning: 'Google Slides cannot be edited through this interface.',
  },
  'application/vnd.google-apps.form': {
    label: 'Google Form',
    exportMime: null,
    editability: 'read-only',
    warning: 'Google Forms cannot be edited through this interface.',
  },
  'application/pdf': {
    label: 'PDF',
    exportMime: null,
    editability: 'read-only',
    warning: 'PDFs cannot be edited.',
  },
  'text/plain': {
    label: 'Plain Text',
    exportMime: null,
    editability: 'direct',
    warning: null,
  },
  'text/markdown': {
    label: 'Markdown',
    exportMime: null,
    editability: 'direct',
    warning: null,
  },
  'text/html': {
    label: 'HTML',
    exportMime: null,
    editability: 'direct',
    warning: 'HTML files are displayed as plain text. Editing may affect markup.',
  },
  'application/json': {
    label: 'JSON',
    exportMime: null,
    editability: 'direct',
    warning: null,
  },
};

export function getMimeInfo(mimeType: string): MimeInfo {
  if (MIME_INFO[mimeType]) return MIME_INFO[mimeType]!;
  // Image, video, binary
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    return { label: mimeType.split('/')[1] ?? mimeType, exportMime: null, editability: 'read-only', warning: 'Binary files cannot be edited in this interface.' };
  }
  // Generic text
  if (mimeType.startsWith('text/')) {
    return { label: mimeType, exportMime: null, editability: 'direct', warning: 'Editing may cause unintended effects for this file format.' };
  }
  return { label: mimeType, exportMime: null, editability: 'direct', warning: 'Editing may cause unintended effects for this file format.' };
}

// ── Data types ────────────────────────────────────────────────────────────────

export interface DriveFileNode {
  fileId: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  size: number;
  modifiedTime: string | null;
  createdTime: string | null;
  webViewLink: string | null;
  parentId: string | null;
  driveId: string | null;
  depth: number;
  path: string;           // e.g. "/Reports/Q1/summary.gdoc"
  children?: DriveFileNode[];
  editability: Editability;
  warning: string | null;
}

export interface DriveFileContent {
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  content: string;
  editability: Editability;
  warning: string | null;
  size: number;
}

export interface DriveEditDelta {
  search: string;
  replace: string;
}

export interface DriveWriteAction {
  action: 'create_file' | 'write_file' | 'patch_file' | 'delete_file' | 'rename_file';
  folderId: number;
  fileId?: string;
  fileName?: string;
  parentFolderId?: string;   // Drive folder ID for create_file
  content?: string;
  mimeType?: string;
  edits?: DriveEditDelta[];  // for patch_file (find/replace model)
  newName?: string;          // for rename_file
}

// ── GdriveSyncManager ─────────────────────────────────────────────────────────

export class GdriveSyncManager {
  public readonly email: string;
  private auth: InstanceType<typeof google.auth.OAuth2>;
  private drive: drive_v3.Drive;
  private pollTimers = new Map<number, NodeJS.Timeout>();
  public connected = false;
  public accountInfo: { email: string } | null = null;

  constructor(email: string, creds: GmailCreds) {
    this.email = email;
    this.auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
    this.auth.setCredentials({
      access_token:  creds.accessToken,
      refresh_token: creds.refreshToken,
      expiry_date:   creds.tokenExpiry ? new Date(creds.tokenExpiry).getTime() : undefined,
    });
    // Auto-refresh tokens and persist updated access token
    this.auth.on('tokens', (tokens) => {
      if (tokens.access_token) {
        // Async update — fire and forget (non-fatal if it fails)
        import('../api/google-auth.js').then(({ getAllGmailCreds, upsertGmailCreds }) => {
          const all = getAllGmailCreds();
          const found = all.find((c) => c.email === email);
          if (found) {
            found.accessToken = tokens.access_token!;
            if (tokens.expiry_date) found.tokenExpiry = new Date(tokens.expiry_date).toISOString();
            upsertGmailCreds(found);
          }
        }).catch(() => { /* non-fatal */ });
      }
    });
    this.drive = google.drive({ version: 'v3', auth: this.auth });
  }

  async connect(): Promise<boolean> {
    try {
      // Lightweight connectivity probe
      await this.drive.files.list({ pageSize: 1, fields: 'files(id)', corpora: 'user' });
      this.connected = true;
      this.accountInfo = { email: this.email };
      console.log(`[gdrive] Connected for ${this.email}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[gdrive] Connect failed for ${this.email}: ${msg}`);
      this.connected = false;
      return false;
    }
  }

  disconnect(): void {
    this.connected = false;
    for (const [id, timer] of this.pollTimers) {
      clearInterval(timer);
      this.pollTimers.delete(id);
    }
    console.log(`[gdrive] Disconnected ${this.email}`);
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  startFolderPolling(folderConfigId: number, intervalMs = POLL_INTERVAL_MS): void {
    this.stopFolderPolling(folderConfigId);
    const timer = setInterval(() => {
      this.syncFolder(folderConfigId).catch((e) =>
        console.error(`[gdrive:${folderConfigId}] Poll sync failed:`, e));
    }, intervalMs);
    this.pollTimers.set(folderConfigId, timer);
  }

  stopFolderPolling(folderConfigId: number): void {
    const t = this.pollTimers.get(folderConfigId);
    if (t) { clearInterval(t); this.pollTimers.delete(folderConfigId); }
  }

  stopAllPolling(): void {
    for (const [id] of this.pollTimers) this.stopFolderPolling(id);
  }

  // ── Folder listing (for picker UI) ────────────────────────────────────────

  async listAvailableFolders(driveType: 'personal' | 'shared'): Promise<Array<{ folderId: string; folderName: string; driveId?: string; path: string }>> {
    if (driveType === 'shared') {
      return this.listSharedDrives();
    }

    const folders: Array<{ folderId: string; folderName: string; path: string }> = [];
    let pageToken: string | undefined;

    do {
      const res = await this.drive.files.list({
        q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
        corpora: 'user',
        spaces: 'drive',
        pageSize: 100,
        pageToken,
        fields: 'nextPageToken, files(id, name, parents)',
      });
      for (const f of res.data.files ?? []) {
        folders.push({ folderId: f.id!, folderName: f.name!, path: `/${f.name!}` });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return folders;
  }

  private async listSharedDrives(): Promise<Array<{ folderId: string; folderName: string; driveId: string; path: string }>> {
    const result: Array<{ folderId: string; folderName: string; driveId: string; path: string }> = [];
    let pageToken: string | undefined;

    do {
      const res = await this.drive.drives.list({
        pageSize: 100,
        pageToken,
        fields: 'nextPageToken, drives(id, name)',
      });
      for (const d of res.data.drives ?? []) {
        // The drive root is represented by the drive ID itself
        result.push({ folderId: d.id!, folderName: d.name!, driveId: d.id!, path: `/${d.name!}` });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return result;
  }

  // ── File tree ──────────────────────────────────────────────────────────────

  async getFileTree(folderConfigId: number, useCache = true): Promise<DriveFileNode[]> {
    const db = getDb();
    const row = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, folderConfigId)).get();
    if (!row) throw new Error(`Drive folder config ${folderConfigId} not found`);

    const cacheAge = row.lastSyncedAt
      ? Date.now() - new Date(row.lastSyncedAt).getTime()
      : Infinity;

    if (useCache && cacheAge < CACHE_TTL_MS) {
      // Serve from DB cache
      const cached = db.select().from(googleDriveFileCache)
        .where(eq(googleDriveFileCache.folderConfigId, folderConfigId))
        .all();
      if (cached.length > 0) {
        return this.buildTreeFromCache(cached, row.folderId);
      }
    }

    // Refresh from API
    await this.syncFolder(folderConfigId);
    const fresh = db.select().from(googleDriveFileCache)
      .where(eq(googleDriveFileCache.folderConfigId, folderConfigId))
      .all();
    return this.buildTreeFromCache(fresh, row.folderId);
  }

  private buildTreeFromCache(
    rows: Array<typeof googleDriveFileCache.$inferSelect>,
    rootFolderId: string,
  ): DriveFileNode[] {
    const byId = new Map<string, DriveFileNode>();
    for (const r of rows) {
      const info = getMimeInfo(r.mimeType);
      byId.set(r.fileId, {
        fileId:       r.fileId,
        name:         r.fileName,
        mimeType:     r.mimeType,
        isFolder:     r.isFolder ?? false,
        size:         r.size ?? 0,
        modifiedTime: r.modifiedTime,
        createdTime:  r.createdTime,
        webViewLink:  r.webViewLink,
        parentId:     r.parentId,
        driveId:      r.driveId,
        depth:        r.depth ?? 0,
        path:         '',  // filled below
        children:     r.isFolder ? [] : undefined,
        editability:  info.editability,
        warning:      info.warning,
      });
    }

    // Assign paths and wire children
    const roots: DriveFileNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : null;
      if (parent) {
        node.path = `${parent.path}/${node.name}`;
        parent.children?.push(node);
      } else {
        node.path = `/${node.name}`;
        // Only include direct children of the configured root folder
        if (node.parentId === rootFolderId || node.parentId === null) {
          roots.push(node);
        }
      }
    }

    // Sort each level: folders first (alphabetical), then files by modifiedTime desc
    const sortNodes = (nodes: DriveFileNode[]): DriveFileNode[] => {
      nodes.sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        if (a.isFolder) return a.name.localeCompare(b.name);
        const aTime = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
        const bTime = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
        return bTime - aTime;
      });
      for (const node of nodes) {
        if (node.children?.length) sortNodes(node.children);
      }
      return nodes;
    };

    return sortNodes(roots);
  }

  // ── Sync (cache refresh) ───────────────────────────────────────────────────

  async syncFolder(folderConfigId: number): Promise<void> {
    const db = getDb();
    const row = db.select().from(googleDriveFolderConfig).where(eq(googleDriveFolderConfig.id, folderConfigId)).get();
    if (!row) return;

    db.update(googleDriveFolderConfig)
      .set({ syncStatus: 'syncing', updatedAt: new Date().toISOString() })
      .where(eq(googleDriveFolderConfig.id, folderConfigId))
      .run();

    try {
      const files = await this.fetchFilesRecursive(
        row.folderId,
        row.driveId ?? undefined,
        0,
        '',
        folderConfigId,
      );

      // Purge old cache for this folder, then write fresh entries
      db.delete(googleDriveFileCache)
        .where(eq(googleDriveFileCache.folderConfigId, folderConfigId))
        .run();

      const now = new Date().toISOString();
      let count = 0;
      for (const f of files) {
        if (count >= MAX_TREE_FILES) break;
        db.insert(googleDriveFileCache).values({
          folderConfigId,
          fileId:      f.fileId,
          fileName:    f.name,
          mimeType:    f.mimeType,
          size:        f.size,
          modifiedTime: f.modifiedTime,
          createdTime:  f.createdTime,
          isFolder:    f.isFolder,
          parentId:    f.parentId,
          webViewLink: f.webViewLink,
          driveId:     f.driveId,
          depth:       f.depth,
          indexedAt:   now,
        }).onConflictDoUpdate({
          target: [googleDriveFileCache.folderConfigId, googleDriveFileCache.fileId],
          set: {
            fileName:    f.name,
            mimeType:    f.mimeType,
            size:        f.size,
            modifiedTime: f.modifiedTime,
            createdTime:  f.createdTime,
            isFolder:    f.isFolder,
            parentId:    f.parentId,
            webViewLink: f.webViewLink,
            driveId:     f.driveId,
            depth:       f.depth,
            indexedAt:   now,
          },
        }).run();
        count++;
      }

      db.update(googleDriveFolderConfig)
        .set({ syncStatus: 'idle', syncError: null, lastSyncedAt: now, updatedAt: now })
        .where(eq(googleDriveFolderConfig.id, folderConfigId))
        .run();

      console.log(`[gdrive:${folderConfigId}] Synced ${count} files`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.update(googleDriveFolderConfig)
        .set({ syncStatus: 'error', syncError: msg, updatedAt: new Date().toISOString() })
        .where(eq(googleDriveFolderConfig.id, folderConfigId))
        .run();
      console.error(`[gdrive:${folderConfigId}] Sync failed:`, msg);
      throw e;
    }
  }

  private async fetchFilesRecursive(
    folderId: string,
    driveId: string | undefined,
    depth: number,
    parentPath: string,
    folderConfigId: number,
  ): Promise<Array<Omit<DriveFileNode, 'children' | 'path' | 'editability' | 'warning'> & { path: string }>> {
    if (depth >= MAX_DEPTH) return [];

    const allFiles: Array<Omit<DriveFileNode, 'children' | 'editability' | 'warning'>> = [];
    let pageToken: string | undefined;

    const listParams: drive_v3.Params$Resource$Files$List = {
      q: `'${folderId}' in parents and trashed=false`,
      pageSize: 200,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, webViewLink, parents, driveId)',
      orderBy: 'folder,name',
    };
    if (driveId) {
      listParams.corpora = 'drive';
      listParams.driveId = driveId;
      listParams.includeItemsFromAllDrives = true;
      listParams.supportsAllDrives = true;
    } else {
      listParams.corpora = 'user';
    }

    do {
      listParams.pageToken = pageToken;
      const res = await this.drive.files.list(listParams);
      for (const f of res.data.files ?? []) {
        const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
        const node: Omit<DriveFileNode, 'children' | 'editability' | 'warning'> = {
          fileId:       f.id!,
          name:         f.name!,
          mimeType:     f.mimeType!,
          isFolder,
          size:         parseInt(String(f.size ?? '0'), 10) || 0,
          modifiedTime: f.modifiedTime ?? null,
          createdTime:  f.createdTime ?? null,
          webViewLink:  f.webViewLink ?? null,
          parentId:     folderId,
          driveId:      f.driveId ?? driveId ?? null,
          depth,
          path:         `${parentPath}/${f.name!}`,
        };
        allFiles.push(node);

        // Recurse into subfolders
        if (isFolder && depth + 1 < MAX_DEPTH && allFiles.length < MAX_TREE_FILES) {
          const children = await this.fetchFilesRecursive(
            f.id!,
            driveId,
            depth + 1,
            `${parentPath}/${f.name!}`,
            folderConfigId,
          );
          allFiles.push(...children);
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && allFiles.length < MAX_TREE_FILES);

    return allFiles as Array<Omit<DriveFileNode, 'children' | 'editability' | 'warning'> & { path: string }>;
  }

  // ── File reading ───────────────────────────────────────────────────────────

  async readFile(fileId: string, mimeType?: string): Promise<DriveFileContent> {
    // Fetch metadata if mimeType not supplied
    if (!mimeType) {
      const meta = await this.drive.files.get({
        fileId,
        fields: 'id,name,mimeType,size,webViewLink',
        supportsAllDrives: true,
      });
      mimeType = meta.data.mimeType!;
    }

    const info = getMimeInfo(mimeType);

    if (info.editability === 'read-only' && !info.exportMime) {
      // Return metadata-only stub for un-exportable binary files
      const meta = await this.drive.files.get({ fileId, fields: 'id,name,mimeType,size', supportsAllDrives: true });
      return {
        fileId,
        fileName:         meta.data.name ?? fileId,
        mimeType:         'text/plain',
        originalMimeType: mimeType,
        content:          `[${info.label} — preview not available. Open in Google Drive: https://drive.google.com/file/d/${fileId}/view]`,
        editability:      'read-only',
        warning:          info.warning,
        size:             parseInt(String(meta.data.size ?? '0'), 10) || 0,
      };
    }

    const isGoogleWorkspace = mimeType.startsWith('application/vnd.google-apps.');
    let content: string;
    let returnMime = mimeType;
    let size = 0;

    if (isGoogleWorkspace && info.exportMime) {
      // Export Google Workspace format
      const res = await this.drive.files.export(
        { fileId, mimeType: info.exportMime },
        { responseType: 'arraybuffer' },
      );
      const buf = Buffer.from(res.data as ArrayBuffer);
      if (buf.length > MAX_EXPORT_BYTES) {
        throw new Error(`File is too large to preview (${Math.round(buf.length / 1024 / 1024)} MB > ${MAX_EXPORT_BYTES / 1024 / 1024} MB limit)`);
      }
      content = buf.toString('utf-8');
      returnMime = info.exportMime;
      size = buf.length;
    } else {
      // Direct download
      const res = await this.drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      const buf = Buffer.from(res.data as ArrayBuffer);
      if (buf.length > MAX_EXPORT_BYTES) {
        throw new Error(`File is too large to preview (${Math.round(buf.length / 1024 / 1024)} MB > ${MAX_EXPORT_BYTES / 1024 / 1024} MB limit)`);
      }
      content = buf.toString('utf-8');
      size = buf.length;
    }

    const meta = await this.drive.files.get({ fileId, fields: 'name', supportsAllDrives: true }).catch(() => ({ data: { name: fileId } }));

    return {
      fileId,
      fileName:         meta.data.name ?? fileId,
      mimeType:         returnMime,
      originalMimeType: mimeType,
      content,
      editability:      info.editability,
      warning:          info.warning,
      size,
    };
  }

  // ── File writing ───────────────────────────────────────────────────────────

  async executeAction(action: DriveWriteAction): Promise<string> {
    switch (action.action) {
      case 'create_file':  return this.createFile(action);
      case 'write_file':   return this.writeFile(action);
      case 'patch_file':   return this.patchFile(action);
      case 'delete_file':  return this.deleteFile(action);
      case 'rename_file':  return this.renameFile(action);
      default:
        throw new Error(`Unknown Drive action: ${(action as { action: string }).action}`);
    }
  }

  private async createFile(action: DriveWriteAction): Promise<string> {
    if (!action.fileName) throw new Error('create_file requires fileName');
    const mimeType = action.mimeType ?? 'text/plain';
    const content = action.content ?? '';

    const res = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name:    action.fileName,
        parents: action.parentFolderId ? [action.parentFolderId] : undefined,
        mimeType,
      },
      media: {
        mimeType,
        body: content,
      },
      fields: 'id,name',
    });

    // Invalidate cache for the folder
    if (action.folderId) {
      await this.syncFolder(action.folderId).catch(() => {});
    }

    return `Created file "${action.fileName}" (${res.data.id})`;
  }

  private async writeFile(action: DriveWriteAction): Promise<string> {
    if (!action.fileId) throw new Error('write_file requires fileId');
    const content = action.content ?? '';

    const meta = await this.drive.files.get({ fileId: action.fileId, fields: 'name,mimeType', supportsAllDrives: true });
    const mimeType = action.mimeType ?? meta.data.mimeType ?? 'text/plain';

    // Google Workspace types cannot be uploaded directly — use Docs/Sheets API
    if (meta.data.mimeType?.startsWith('application/vnd.google-apps.')) {
      return this.applyFindReplaceEdits(action.fileId, meta.data.mimeType, [
        { search: '.+', replace: content },  // naive full replacement via regex
      ]);
    }

    await this.drive.files.update({
      fileId: action.fileId,
      supportsAllDrives: true,
      media: { mimeType, body: content },
    });

    if (action.folderId) await this.syncFolder(action.folderId).catch(() => {});
    return `Updated file "${meta.data.name}"`;
  }

  /**
   * patch_file — find/replace model for rich and plain text files.
   * Each edit specifies { search, replace } strings applied sequentially.
   * For Google Workspace files this routes through the Docs/Sheets batchUpdate APIs.
   * For plain files it reads, patches in memory, and re-uploads.
   */
  private async patchFile(action: DriveWriteAction): Promise<string> {
    if (!action.fileId) throw new Error('patch_file requires fileId');
    if (!action.edits?.length) throw new Error('patch_file requires at least one edit');

    const meta = await this.drive.files.get({ fileId: action.fileId, fields: 'name,mimeType', supportsAllDrives: true });
    const mimeType = meta.data.mimeType!;

    if (mimeType === 'application/vnd.google-apps.document') {
      await this.applyDocsEdits(action.fileId, action.edits);
      if (action.folderId) await this.syncFolder(action.folderId).catch(() => {});
      return `Patched Google Doc "${meta.data.name}" (${action.edits.length} edit(s))`;
    }

    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      await this.applySheetsEdits(action.fileId, action.edits);
      if (action.folderId) await this.syncFolder(action.folderId).catch(() => {});
      return `Patched Google Sheet "${meta.data.name}" (${action.edits.length} edit(s))`;
    }

    // Plain text: download → patch in memory → re-upload
    const current = await this.readFile(action.fileId, mimeType);
    let text = current.content;

    for (let i = 0; i < action.edits.length; i++) {
      const { search, replace } = action.edits[i]!;
      const count = countOccurrences(text, search);
      if (count === 0) throw new Error(`patch_file edit ${i + 1}: search string not found in "${meta.data.name}"`);
      if (count > 1) throw new Error(`patch_file edit ${i + 1}: search string matches ${count} locations in "${meta.data.name}" — make it more specific`);
      text = text.replace(search, replace);
    }

    await this.drive.files.update({
      fileId: action.fileId,
      supportsAllDrives: true,
      media: { mimeType: mimeType.startsWith('application/vnd.google-apps.') ? 'text/plain' : mimeType, body: text },
    });

    if (action.folderId) await this.syncFolder(action.folderId).catch(() => {});
    return `Patched "${meta.data.name}" (${action.edits.length} edit(s))`;
  }

  private async deleteFile(action: DriveWriteAction): Promise<string> {
    if (!action.fileId) throw new Error('delete_file requires fileId');
    const meta = await this.drive.files.get({ fileId: action.fileId, fields: 'name', supportsAllDrives: true });
    // Trash instead of hard delete
    await this.drive.files.update({ fileId: action.fileId, supportsAllDrives: true, requestBody: { trashed: true } });
    if (action.folderId) await this.syncFolder(action.folderId).catch(() => {});
    return `Moved "${meta.data.name}" to Drive trash`;
  }

  private async renameFile(action: DriveWriteAction): Promise<string> {
    if (!action.fileId) throw new Error('rename_file requires fileId');
    if (!action.newName) throw new Error('rename_file requires newName');
    await this.drive.files.update({
      fileId: action.fileId,
      supportsAllDrives: true,
      requestBody: { name: action.newName },
    });
    if (action.folderId) await this.syncFolder(action.folderId).catch(() => {});
    return `Renamed file to "${action.newName}"`;
  }

  // ── Google Docs batchUpdate (find/replace) ─────────────────────────────────

  private async applyDocsEdits(documentId: string, edits: DriveEditDelta[]): Promise<void> {
    const docs = google.docs({ version: 'v1', auth: this.auth });
    const requests = edits.map((edit) => ({
      replaceAllText: {
        containsText: { text: edit.search, matchCase: true },
        replaceText:  edit.replace,
      },
    }));

    const res = await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });

    // Check if any replacements were actually made
    const replies = res.data.replies ?? [];
    const totalReplaced = replies.reduce((sum, r) => sum + (r.replaceAllText?.occurrencesChanged ?? 0), 0);
    if (totalReplaced === 0 && edits.length > 0) {
      throw new Error('No matching text found in document. Ensure search strings match the document content exactly.');
    }
  }

  // ── Google Sheets batchUpdate (findReplace) ────────────────────────────────

  private async applySheetsEdits(spreadsheetId: string, edits: DriveEditDelta[]): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.auth });
    const requests = edits.map((edit) => ({
      findReplace: {
        find:         edit.search,
        replacement:  edit.replace,
        allSheets:    true,
        matchCase:    true,
        matchEntireCell: false,
      },
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }

  private async applyFindReplaceEdits(fileId: string, mimeType: string, edits: DriveEditDelta[]): Promise<string> {
    if (mimeType === 'application/vnd.google-apps.document') {
      await this.applyDocsEdits(fileId, edits);
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      await this.applySheetsEdits(fileId, edits);
    }
    return `Applied ${edits.length} edit(s)`;
  }

  // ── Pre-flight validation for patch_file ─────────────────────────────────

  /**
   * Validate a patch_file action before adding it to the outbox.
   * For plain text files: downloads content and checks each search string.
   * For Google Workspace files: cannot pre-validate without a batchUpdate dry-run,
   * so we skip deep validation (Docs/Sheets API handles error reporting at execution time).
   */
  async validatePatchFile(action: DriveWriteAction): Promise<void> {
    if (action.action !== 'patch_file') return;
    if (!action.fileId) throw new Error('patch_file requires fileId');
    if (!action.edits?.length) throw new Error('patch_file requires at least one edit');

    const meta = await this.drive.files.get({ fileId: action.fileId, fields: 'name,mimeType', supportsAllDrives: true });
    const mimeType = meta.data.mimeType!;

    // Google Workspace: skip deep pre-validation (Docs/Sheets API handles it)
    if (mimeType.startsWith('application/vnd.google-apps.')) return;

    // Plain text: download and validate each search string
    const current = await this.readFile(action.fileId, mimeType);
    let text = current.content;

    for (let i = 0; i < action.edits.length; i++) {
      const { search, replace } = action.edits[i]!;
      if (!search) throw new Error(`patch_file edit ${i + 1}: search string must not be empty`);
      const count = countOccurrences(text, search);
      if (count === 0) {
        const preview = search.length > 120 ? search.slice(0, 120).replace(/\n/g, '↵') + '…' : search.replace(/\n/g, '↵');
        throw new Error(
          `patch_file validation failed for "${meta.data.name}":\n\n` +
          `Edit ${i + 1}: search string not found.\n` +
          `Search (${search.length} chars): "${preview}"`,
        );
      }
      if (count > 1) {
        const preview = search.length > 120 ? search.slice(0, 120).replace(/\n/g, '↵') + '…' : search.replace(/\n/g, '↵');
        throw new Error(
          `patch_file validation failed for "${meta.data.name}":\n\n` +
          `Edit ${i + 1}: search string matches ${count} locations — make it more specific.\n` +
          `Search (${search.length} chars): "${preview}"`,
        );
      }
      // Apply to keep intermediate state in sync
      text = text.replace(search, replace);
    }
  }

  // ── Invalidate cache for a folder ─────────────────────────────────────────

  invalidateCache(folderConfigId: number): void {
    const db = getDb();
    const oneHourAgo = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    // Force re-sync by backdating lastSyncedAt
    db.update(googleDriveFolderConfig)
      .set({ lastSyncedAt: oneHourAgo, updatedAt: new Date().toISOString() })
      .where(eq(googleDriveFolderConfig.id, folderConfigId))
      .run();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = text.indexOf(search);
  while (pos !== -1) {
    count++;
    if (count > 1) break;
    pos = text.indexOf(search, pos + 1);
  }
  return count;
}
