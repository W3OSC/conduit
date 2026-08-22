/** SMB share sidebar section: lazy-loading directory tree with upload. */

import { useState, useEffect, useCallback, useId } from 'react';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, RefreshCw, Loader2, AlertCircle,
  Network, Upload,
} from 'lucide-react';
import { api, type SmbShareRow, type SmbEntry } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DropZone } from './DropZone';
import { TreeNode } from './TreeNode';
import {
  type SelectedItem, fileTypeIcon, sectionShellClass, SectionHeader,
  sectionActionClass, TreeFilterInput, connectCtaClass, treeListClass,
} from './shared';

// ── Tree node (lazy-loading directory tree) ───────────────────────────────────

interface SmbDirNodeProps {
  entry: SmbEntry;
  shareId: number;
  depth: number;
  selectedId: string | null;
  onSelect: (entry: SmbEntry) => void;
  filterQuery: string;
}

function SmbDirNode({ entry, shareId, depth, selectedId, onSelect, filterQuery }: SmbDirNodeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<SmbEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (filterQuery) setOpen(true); }, [filterQuery]);

  async function handleOpen() {
    if (entry.type !== 'directory') return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (children !== null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.listSmbDirectory(shareId, entry.path);
      setChildren(res.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  if (entry.type === 'directory') {
    return (
      <TreeNode
        depth={depth}
        variant="branch"
        label={entry.name}
        onClick={handleOpen}
        icon={
          <span className="flex-shrink-0">
            {open ? <FolderOpen className="w-3.5 h-3.5 text-amber-400" /> : <Folder className="w-3.5 h-3.5 text-amber-400" />}
          </span>
        }
        caret={
          <span className="flex-shrink-0">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" />
              : open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
        }
      >
        <>
          {error && (
            <div className="pl-8 py-1 text-[10px] text-red-400 flex items-center gap-1">
              <AlertCircle className="w-3 h-3 flex-shrink-0" /><span>{error}</span>
            </div>
          )}
          {open && children !== null && (
            <div>
              {children.length === 0 && (
                <div className="pl-8 py-1 text-[10px] text-muted-foreground italic">Empty</div>
              )}
              {children.map((child) => (
                <SmbDirNode
                  key={child.path}
                  entry={child}
                  shareId={shareId}
                  depth={depth + 1}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  filterQuery={filterQuery}
                />
              ))}
            </div>
          )}
        </>
      </TreeNode>
    );
  }

  if (filterQuery && !entry.name.toLowerCase().includes(filterQuery.toLowerCase())) return null;

  const isSelected = selectedId === entry.path;
  return (
    <TreeNode
      depth={depth}
      variant="leaf"
      selected={isSelected}
      label={entry.name}
      onClick={() => onSelect(entry)}
      icon={<span className="flex-shrink-0">{fileTypeIcon(entry.name, undefined, 'w-3.5 h-3.5')}</span>}
    />
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

export interface SmbSectionProps {
  share: SmbShareRow;
  selectedItem: SelectedItem | null;
  onSelect: (shareId: number, shareName: string, entry: SmbEntry) => void;
  onUpload: (shareId: number, files: File[], dirPath?: string) => void;
  uploading: boolean;
  open: boolean;
  onToggle: () => void;
}

export function SmbSection({ share, selectedItem, onSelect, onUpload, uploading, open, onToggle }: SmbSectionProps) {
  const [filter, setFilter] = useState('');
  const [rootEntries, setRootEntries] = useState<SmbEntry[] | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const fileInputId = useId();

  const status = share.connectionStatus;
  const isConnected = status?.status === 'connected';

  const loadRoot = useCallback(async () => {
    if (!isConnected) return;
    setRootLoading(true);
    setRootError(null);
    try {
      const res = await api.listSmbDirectory(share.id, '');
      setRootEntries(res.entries);
    } catch (e) {
      setRootError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setRootLoading(false);
    }
  }, [share.id, isConnected]);

  useEffect(() => {
    if (isConnected && rootEntries === null && !rootLoading) {
      loadRoot();
    }
  }, [isConnected, rootEntries, rootLoading, loadRoot]);

  const selectedId = selectedItem?.source.kind === 'smb' && selectedItem.source.shareId === share.id
    ? selectedItem.id
    : null;

  const statusDot = isConnected ? 'bg-emerald-500' : status?.status === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-red-500';

  return (
    <div className={sectionShellClass(open)}>
      <SectionHeader
        open={open}
        onToggle={onToggle}
        icon={<Network className="w-3.5 h-3.5" />}
        label={share.name}
        meta={<span className={cn('w-1.5 h-1.5 rounded-full ml-1 flex-shrink-0', statusDot)} />}
        actions={
          isConnected && (
            <div className="flex items-center gap-0.5">
              <label htmlFor={fileInputId} className={cn(sectionActionClass, 'cursor-pointer')} title="Upload file">
                <Upload className="w-3.5 h-3.5" />
              </label>
              <input id={fileInputId} type="file" multiple className="sr-only"
                onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) onUpload(share.id, f); e.target.value = ''; }} />
              <button onClick={loadRoot} disabled={rootLoading} className={sectionActionClass} title="Refresh">
                <RefreshCw className={cn('w-3.5 h-3.5', rootLoading && 'animate-spin')} />
              </button>
            </div>
          )
        }
      />

      {open && (
        <div className="flex flex-col min-h-0 flex-1">
          {!isConnected ? (
            <div className="px-4 py-4 space-y-2">
              <p className="text-xs text-muted-foreground">Share not connected.</p>
              <a href="/settings/connections" className={connectCtaClass}>
                Connect Share
              </a>
            </div>
          ) : (
            <DropZone onFiles={(f) => onUpload(share.id, f)} uploading={uploading} className="flex flex-col min-h-0 flex-1">
              <TreeFilterInput value={filter} onChange={setFilter} placeholder="Filter files..." />
              <div className={treeListClass}>
                {rootLoading && (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                  </div>
                )}
                {rootError && (
                  <div className="px-3 py-3 text-xs text-red-400 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{rootError}</span>
                  </div>
                )}
                {!rootLoading && !rootError && rootEntries !== null && rootEntries.length === 0 && (
                  <div className="px-3 py-3 text-xs text-muted-foreground text-center">Share is empty</div>
                )}
                {rootEntries?.map((entry) => (
                  <SmbDirNode
                    key={entry.path}
                    entry={entry}
                    shareId={share.id}
                    depth={0}
                    selectedId={selectedId}
                    onSelect={(e) => onSelect(share.id, share.name, e)}
                    filterQuery={filter}
                  />
                ))}
              </div>
            </DropZone>
          )}
        </div>
      )}
    </div>
  );
}
