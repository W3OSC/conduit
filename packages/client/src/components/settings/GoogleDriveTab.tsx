import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown, RefreshCw, Loader2, AlertTriangle, Plus, Trash2, X, ExternalLink, ArrowRight,
  HardDrive, FolderOpen, FolderPlus, ChevronRight as ChevronRightIcon, File, Folder,
} from 'lucide-react';
import {
  api, type GoogleDriveFolderConfig, type DriveFileNode, type DriveAvailableFolder,
  type DriveEditDelta,
} from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import { SectionHeader } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Google Drive Tab — multi-folder list + file browser + editor
// ─────────────────────────────────────────────────────────────────────────────

function mimeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/vnd.google-apps.folder': 'Folder',
    'text/plain': 'Text',
    'text/markdown': 'Markdown',
    'application/json': 'JSON',
    'application/pdf': 'PDF',
  };
  return map[mimeType] ?? mimeType.split('/').pop() ?? mimeType;
}

function DriveFileTreeNode({
  node,
  depth = 0,
  onSelect,
  selectedId,
}: {
  node: DriveFileNode;
  depth?: number;
  onSelect: (node: DriveFileNode) => void;
  selectedId: string | null;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const isSelected = selectedId === node.fileId;

  if (node.isFolder) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            'w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors rounded',
            isSelected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary/60',
          )}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          {expanded ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRightIcon className="w-3 h-3 flex-shrink-0" />}
          <Folder className="w-3 h-3 flex-shrink-0 text-amber-400" />
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {expanded && node.children?.map((child) => (
          <DriveFileTreeNode key={child.fileId} node={child} depth={depth + 1} onSelect={onSelect} selectedId={selectedId} />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelect(node)}
      className={cn(
        'w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors rounded',
        isSelected ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
      )}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <span className="w-3 h-3 flex-shrink-0" />
      <File className="w-3 h-3 flex-shrink-0" />
      <span className="truncate">{node.name}</span>
      {node.warning && <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0 text-amber-500 ml-auto" />}
    </button>
  );
}

function DriveFileViewer({
  folderId,
  node,
  onClose,
}: {
  folderId: number;
  node: DriveFileNode;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: fileData, isLoading, error } = useQuery({
    queryKey: ['gdrive-file', folderId, node.fileId],
    queryFn: () => api.gdriveReadFile(folderId, node.fileId),
    staleTime: 5 * 60 * 1000,
  });

  // Edit / patch state
  const [editMode, setEditMode] = useState(false);
  const [editorContent, setEditorContent] = useState('');
  const [searchStr, setSearchStr] = useState('');
  const [replaceStr, setReplaceStr] = useState('');
  const [pendingEdits, setPendingEdits] = useState<DriveEditDelta[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (fileData) setEditorContent(fileData.content);
  }, [fileData]);

  const isRichDoc = node.editability === 'find-replace';
  const isReadOnly = node.editability === 'read-only';

  const addEditDelta = () => {
    if (!searchStr.trim()) return;
    setPendingEdits((prev) => [...prev, { search: searchStr, replace: replaceStr }]);
    setSearchStr('');
    setReplaceStr('');
  };

  const removeEditDelta = (i: number) => {
    setPendingEdits((prev) => prev.filter((_, idx) => idx !== i));
  };

  const applyPreview = () => {
    if (!fileData) return;
    let text = fileData.content;
    for (const edit of pendingEdits) {
      text = text.replace(edit.search, edit.replace);
    }
    setEditorContent(text);
  };

  const submitEdits = async () => {
    if (!fileData) return;
    setSubmitting(true);
    setEditError(null);
    try {
      const action = isRichDoc
        ? { action: 'patch_file' as const, folderId, fileId: node.fileId, edits: pendingEdits }
        : { action: 'patch_file' as const, folderId, fileId: node.fileId, edits: [{ search: fileData.content, replace: editorContent }] };
      const content = JSON.stringify(action);
      await fetch('/api/outbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ source: 'gdrive', recipient_id: String(folderId), content }),
      });
      qc.invalidateQueries({ queryKey: ['outbox'] });
      setEditMode(false);
      setPendingEdits([]);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/20 flex-shrink-0">
        <File className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-xs font-medium truncate flex-1">{node.name}</span>
        <span className="text-[10px] text-muted-foreground">{mimeLabel(node.mimeType)}</span>
        {!isReadOnly && !editMode && (
          <button
            onClick={() => setEditMode(true)}
            className="text-[10px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            Edit
          </button>
        )}
        <button onClick={onClose} className="p-0.5 rounded hover:bg-secondary/70 text-muted-foreground transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Warning banner */}
      {node.warning && (
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 flex-shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-400">{node.warning}</p>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {isLoading && (
          <div className="flex items-center justify-center py-8 flex-1">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && (
          <div className="p-4 text-xs text-red-400">{error instanceof Error ? error.message : 'Failed to load file'}</div>
        )}
        {fileData && !editMode && (
          <pre className="flex-1 overflow-auto p-3 text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-words leading-relaxed">
            {fileData.content}
          </pre>
        )}
        {fileData && editMode && (
          <div className="flex-1 flex flex-col overflow-hidden p-3 gap-3">
            {isRichDoc ? (
              <>
                <p className="text-[11px] text-muted-foreground">
                  Rich document editing uses find/replace. Changes are applied via the Google Docs/Sheets API,
                  preserving formatting. Add each edit below, preview the result, then queue for approval.
                </p>
                {/* Find/replace input */}
                <div className="flex flex-col gap-1.5 p-2 rounded-lg bg-secondary/30 border border-border">
                  <input
                    className="text-xs bg-background border border-border rounded px-2 py-1 w-full"
                    placeholder="Find (exact match)…"
                    value={searchStr}
                    onChange={(e) => setSearchStr(e.target.value)}
                  />
                  <input
                    className="text-xs bg-background border border-border rounded px-2 py-1 w-full"
                    placeholder="Replace with…"
                    value={replaceStr}
                    onChange={(e) => setReplaceStr(e.target.value)}
                  />
                  <button
                    onClick={addEditDelta}
                    disabled={!searchStr.trim()}
                    className="self-end text-[10px] px-2 py-0.5 rounded bg-secondary border border-border hover:bg-secondary/80 transition-colors disabled:opacity-50"
                  >
                    + Add Edit
                  </button>
                </div>
                {/* Pending edits list */}
                {pendingEdits.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Queued Edits</p>
                    {pendingEdits.map((edit, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] bg-secondary/20 rounded px-2 py-1">
                        <span className="text-amber-400 font-mono truncate flex-1">"{edit.search}"</span>
                        <ArrowRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        <span className="text-emerald-400 font-mono truncate flex-1">"{edit.replace}"</span>
                        <button onClick={() => removeEditDelta(i)} className="text-muted-foreground hover:text-red-400 transition-colors flex-shrink-0">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={applyPreview}
                      className="self-start text-[10px] px-2 py-0.5 rounded bg-secondary border border-border hover:bg-secondary/80 transition-colors"
                    >
                      Preview Changes
                    </button>
                  </div>
                )}
                {/* Preview */}
                <pre className="flex-1 overflow-auto text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-words leading-relaxed bg-secondary/10 rounded p-2 border border-border">
                  {editorContent}
                </pre>
              </>
            ) : (
              <textarea
                className="flex-1 text-[11px] font-mono bg-secondary/10 border border-border rounded p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40 text-foreground leading-relaxed"
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
              />
            )}
            {/* Error */}
            {editError && <p className="text-[11px] text-red-400">{editError}</p>}
            {/* Actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => { setEditMode(false); setPendingEdits([]); if (fileData) setEditorContent(fileData.content); }}
                className="text-[11px] px-3 py-1 rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitEdits}
                disabled={submitting || (isRichDoc ? pendingEdits.length === 0 : editorContent === fileData?.content)}
                className="text-[11px] px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1"
              >
                {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
                Queue for Approval
              </button>
            </div>
          </div>
        )}
      </div>

      {/* External link */}
      {node.webViewLink && (
        <div className="flex-shrink-0 px-3 py-1.5 border-t border-border bg-secondary/10">
          <a
            href={node.webViewLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-primary hover:underline flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" />
            Open in Google Drive
          </a>
        </div>
      )}
    </div>
  );
}

function AddDriveFolderForm({
  onCreated,
}: {
  onCreated: (folder: GoogleDriveFolderConfig) => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [driveType, setDriveType] = useState<'personal' | 'shared'>('personal');
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [availableFolders, setAvailableFolders] = useState<DriveAvailableFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<DriveAvailableFolder | null>(null);
  const [folderName, setFolderName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: accounts } = useQuery({
    queryKey: ['gdrive-accounts'],
    queryFn: () => api.gdriveAccounts(),
  });

  const fetchFolders = async () => {
    if (!email) return;
    setLoadingFolders(true);
    setError(null);
    try {
      const res = await api.gdriveAvailableFolders(email, driveType);
      setAvailableFolders(res.folders);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch folders');
    } finally {
      setLoadingFolders(false);
    }
  };

  const submit = async () => {
    if (!email || !selectedFolder) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.addGdriveFolder({
        email,
        folderId: selectedFolder.folderId,
        folderName: folderName || selectedFolder.folderName,
        driveType,
        driveId: selectedFolder.driveId,
      });
      qc.invalidateQueries({ queryKey: ['gdrive-folders'] });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add folder');
    } finally {
      setSaving(false);
    }
  };

  const accountList = accounts?.accounts ?? [];

  return (
    <div className="p-4 flex flex-col gap-3">
      <SectionHeader icon={FolderPlus} title="Add Google Drive Folder" subtitle="Select a folder from your connected Google account to whitelist for access" />

      {accountList.length === 0 ? (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
          <p className="text-xs text-amber-400">No connected Google accounts. Connect a Google account via the Email &amp; Calendar tab first.</p>
        </div>
      ) : (
        <>
          {/* Account picker */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Google Account</label>
            <select
              className="text-xs bg-background border border-border rounded px-2 py-1.5"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setAvailableFolders([]); setSelectedFolder(null); }}
            >
              <option value="">Select account…</option>
              {accountList.map((a) => (
                <option key={a.email} value={a.email}>{a.email}</option>
              ))}
            </select>
          </div>

          {/* Drive type */}
          <div className="flex gap-2">
            {(['personal', 'shared'] as const).map((t) => (
              <button
                key={t}
                onClick={() => { setDriveType(t); setAvailableFolders([]); setSelectedFolder(null); }}
                className={cn(
                  'flex-1 text-xs py-1.5 rounded-lg border transition-colors',
                  driveType === t ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'personal' ? 'My Drive' : 'Shared Drives'}
              </button>
            ))}
          </div>

          {/* Fetch folders button */}
          <button
            onClick={fetchFolders}
            disabled={!email || loadingFolders}
            className="text-xs px-3 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/80 transition-colors disabled:opacity-50 flex items-center gap-2 self-start"
          >
            {loadingFolders ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {availableFolders.length > 0 ? 'Refresh Folders' : 'Browse Folders'}
          </button>

          {/* Folder picker */}
          {availableFolders.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Select Folder</label>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-secondary/10 flex flex-col">
                {availableFolders.map((f) => (
                  <button
                    key={f.folderId}
                    onClick={() => { setSelectedFolder(f); setFolderName(f.folderName); }}
                    className={cn(
                      'flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
                      selectedFolder?.folderId === f.folderId ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary/60',
                    )}
                  >
                    <Folder className="w-3 h-3 text-amber-400 flex-shrink-0" />
                    <span className="truncate">{f.folderName}</span>
                    <span className="text-muted-foreground ml-auto text-[10px]">{f.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Display name */}
          {selectedFolder && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Display Name</label>
              <input
                className="text-xs bg-background border border-border rounded px-2 py-1.5"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="Friendly name for this folder"
              />
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            onClick={submit}
            disabled={!selectedFolder || saving}
            className="text-xs px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2 self-start"
          >
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            Add Folder
          </button>
        </>
      )}
    </div>
  );
}

function GdriveFolderDetailPanel({
  folder,
  onDeleted,
}: {
  folder: GoogleDriveFolderConfig;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(folder.folderName);
  const [syncError, setSyncError] = useState<string | null>(null);

  const { data: treeData, isLoading: treeLoading, refetch: refetchTree } = useQuery({
    queryKey: ['gdrive-tree', folder.id],
    queryFn: () => api.gdriveFileTree(folder.id),
    staleTime: 5 * 60 * 1000,
  });

  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      await api.syncGdriveFolder(folder.id);
      await refetchTree();
      qc.invalidateQueries({ queryKey: ['gdrive-folders'] });
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Remove "${folder.folderName}" from Drive connections? Files in Google Drive will not be deleted.`)) return;
    setDeleting(true);
    try {
      await api.deleteGdriveFolder(folder.id);
      qc.invalidateQueries({ queryKey: ['gdrive-folders'] });
      onDeleted();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to remove folder');
    } finally {
      setDeleting(false);
    }
  };

  const handleRename = async () => {
    if (!newName.trim() || newName === folder.folderName) { setRenaming(false); return; }
    try {
      await api.updateGdriveFolder(folder.id, { folderName: newName.trim() });
      qc.invalidateQueries({ queryKey: ['gdrive-folders'] });
      setRenaming(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to rename folder');
    }
  };

  const statusColor = folder.syncStatus === 'idle' ? 'bg-emerald-500' : folder.syncStatus === 'syncing' ? 'bg-amber-500 animate-pulse' : 'bg-red-500';

  const files = treeData?.files ?? [];

  return (
    <div className="flex flex-col">
      {/* Folder header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/10 flex-shrink-0">
        <HardDrive className="w-3.5 h-3.5 text-muted-foreground" />
        {renaming ? (
          <input
            className="text-xs bg-background border border-border rounded px-2 py-0.5 flex-1"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(false); }}
            autoFocus
          />
        ) : (
          <span
            className="text-xs font-medium flex-1 cursor-pointer hover:text-primary transition-colors"
            onDoubleClick={() => setRenaming(true)}
            title="Double-click to rename"
          >
            {folder.folderName}
          </span>
        )}
        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', statusColor)} title={folder.syncStatus} />
        <span className="text-[10px] text-muted-foreground">{folder.driveType === 'shared' ? 'Shared Drive' : 'My Drive'}</span>
        <button onClick={handleSync} disabled={syncing} className="p-0.5 rounded hover:bg-secondary/70 text-muted-foreground hover:text-foreground transition-colors" title="Sync now">
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
        <button onClick={handleDelete} disabled={deleting} className="p-0.5 rounded hover:bg-secondary/70 text-muted-foreground hover:text-red-400 transition-colors" title="Remove folder">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {folder.syncError && (
        <div className="px-3 py-1.5 bg-red-500/10 border-b border-red-500/20 text-[11px] text-red-400 flex-shrink-0">
          {folder.syncError}
        </div>
      )}
      {syncError && (
        <div className="px-3 py-1.5 bg-red-500/10 border-b border-red-500/20 text-[11px] text-red-400 flex-shrink-0">
          {syncError}
        </div>
      )}

      {/* Sync timestamp */}
      {folder.lastSyncedAt && (
        <div className="px-3 py-1 text-[10px] text-muted-foreground flex-shrink-0 border-b border-border/50">
          Last synced {timeAgo(folder.lastSyncedAt)}
          {files.length > 0 && ` · ${files.length} top-level item${files.length !== 1 ? 's' : ''}`}
        </div>
      )}

      {/* File tree — fixed height, scrollable */}
      <div className="overflow-y-auto py-1" style={{ height: '260px' }}>
        {treeLoading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {!treeLoading && files.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground italic">
            {folder.lastSyncedAt ? 'No files found' : 'Click sync to load files'}
          </p>
        )}
        {files.map((node) => (
          <DriveFileTreeNode
            key={node.fileId}
            node={node}
            depth={0}
            onSelect={() => {}}
            selectedId={null}
          />
        ))}
      </div>

      {/* Hint to browse files in the Files tab */}
      <div className="px-3 py-2 border-t border-border/50 flex items-center gap-2">
        <FolderOpen className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        <p className="text-[11px] text-muted-foreground">
          To browse and open files, visit the{' '}
          <a href="/files" className="text-primary hover:underline">Files tab</a>.
        </p>
      </div>
    </div>
  );
}

export function GoogleDriveTab() {
  const { data: foldersData, isLoading } = useQuery({
    queryKey: ['gdrive-folders'],
    queryFn: () => api.listGdriveFolders(),
    staleTime: 10000,
  });

  const folders = foldersData?.folders ?? [];
  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null);

  useEffect(() => {
    if (!isLoading && selectedId === null) {
      setSelectedId(folders.length > 0 ? folders[0]!.id : 'new');
    }
  }, [isLoading, folders, selectedId]);

  const selectedFolder = selectedId !== null && selectedId !== 'new'
    ? folders.find((f) => f.id === selectedId) ?? null
    : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex gap-0 min-h-[400px]">
      {/* Left: folder list */}
      <div className="w-48 flex-shrink-0 border-r border-border flex flex-col">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Folders</span>
          <button
            onClick={() => setSelectedId('new')}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
            title="Add folder"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {folders.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground italic">No folders yet</p>
          )}
          {folders.map((f) => {
            const syncSt = f.syncStatus;
            const isSelected = selectedId === f.id;
            return (
              <button
                key={f.id}
                onClick={() => setSelectedId(f.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                  isSelected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary/60',
                )}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0',
                  syncSt === 'idle' ? 'bg-emerald-500' : syncSt === 'error' ? 'bg-red-500' : 'bg-amber-500 animate-pulse',
                )} />
                <span className="truncate font-medium">{f.folderName}</span>
              </button>
            );
          })}
        </div>
        <div className="border-t border-border p-2">
          <button
            onClick={() => setSelectedId('new')}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors',
              selectedId === 'new' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            <Plus className="w-3.5 h-3.5 flex-shrink-0" />
            Add Folder
          </button>
        </div>
      </div>

      {/* Right: detail / new form */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedId === 'new' && (
          <AddDriveFolderForm onCreated={(f) => setSelectedId(f.id)} />
        )}
        {selectedFolder && (
          <GdriveFolderDetailPanel
            key={selectedFolder.id}
            folder={selectedFolder}
            onDeleted={() => setSelectedId(folders.length > 1 ? folders.find((f) => f.id !== selectedFolder.id)?.id ?? 'new' : 'new')}
          />
        )}
        {selectedId !== 'new' && !selectedFolder && folders.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
            <HardDrive className="w-8 h-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No Drive folders configured. Click Add Folder to get started.</p>
            <p className="text-xs text-muted-foreground">You need a connected Google account first.</p>
          </div>
        )}
      </div>
    </div>
  );
}
