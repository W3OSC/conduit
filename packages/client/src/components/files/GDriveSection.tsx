/** Google Drive folder sidebar section: file tree with drag-and-drop upload. */

import { useState, useEffect, useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, RefreshCw, Loader2, AlertCircle,
  AlertTriangle, HardDrive, Upload, CheckCircle2,
} from 'lucide-react';
import { api, type DriveFileNode, type GoogleDriveFolderConfig } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import { DropZone } from './DropZone';
import { TreeNode } from './TreeNode';
import {
  type SelectedItem, fileTypeIcon, sectionShellClass, SectionHeader,
  sectionActionClass, TreeFilterInput, treeListClass,
} from './shared';

// ── Tree node ─────────────────────────────────────────────────────────────────

interface GDriveNodeProps {
  node: DriveFileNode;
  depth: number;
  selectedId: string | null;
  onSelect: (node: DriveFileNode) => void;
  filterQuery: string;
}

function flattenDriveFiles(nodes: DriveFileNode[], query: string): DriveFileNode[] {
  const result: DriveFileNode[] = [];
  function walk(items: DriveFileNode[]) {
    for (const item of items) {
      if (!item.isFolder) {
        if (!query || item.name.toLowerCase().includes(query.toLowerCase())) result.push(item);
      }
      if (item.children) walk(item.children);
    }
  }
  walk(nodes);
  return result;
}

function GDriveFileNode({ node, depth, selectedId, onSelect, filterQuery }: GDriveNodeProps) {
  const [open, setOpen] = useState(depth === 0);

  useEffect(() => { if (filterQuery) setOpen(true); }, [filterQuery]);

  if (node.isFolder) {
    if (filterQuery && flattenDriveFiles(node.children ?? [], filterQuery).length === 0) return null;
    return (
      <TreeNode
        depth={depth}
        variant="branch"
        label={node.name}
        onClick={() => setOpen(!open)}
        icon={
          <span className="flex-shrink-0">
            {open ? <FolderOpen className="w-3.5 h-3.5 text-amber-400" /> : <Folder className="w-3.5 h-3.5 text-amber-400" />}
          </span>
        }
        caret={
          <span className="flex-shrink-0">
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
        }
      >
        {open && node.children && (
          <div>
            {node.children.map((child) => (
              <GDriveFileNode key={child.fileId} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} filterQuery={filterQuery} />
            ))}
          </div>
        )}
      </TreeNode>
    );
  }

  if (filterQuery && !node.name.toLowerCase().includes(filterQuery.toLowerCase())) return null;

  const isSelected = selectedId === node.fileId;
  return (
    <TreeNode
      depth={depth}
      variant="leaf"
      selected={isSelected}
      label={node.name}
      onClick={() => onSelect(node)}
      icon={<span className="flex-shrink-0">{fileTypeIcon(node.name, node.mimeType, 'w-3.5 h-3.5')}</span>}
      trailing={node.warning ? <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0 text-amber-500 ml-auto" /> : undefined}
    />
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

export interface GDriveSectionProps {
  folder: GoogleDriveFolderConfig;
  selectedItem: SelectedItem | null;
  onSelect: (folderId: number, folderName: string, node: DriveFileNode) => void;
  onUpload: (folderId: number, files: File[], parentFolderId?: string) => void;
  uploading: boolean;
  open: boolean;
  onToggle: () => void;
}

export function GDriveSection({ folder, selectedItem, onSelect, onUpload, uploading, open, onToggle }: GDriveSectionProps) {
  const [filter, setFilter] = useState('');
  const fileInputId = useId();

  const { data: treeData, isLoading, error, refetch } = useQuery({
    queryKey: ['gdrive-tree-files', folder.id],
    queryFn: () => api.gdriveFileTree(folder.id),
    staleTime: 5 * 60 * 1000,
  });

  const selectedId = selectedItem?.source.kind === 'gdrive' && selectedItem.source.folderId === folder.id
    ? selectedItem.id
    : null;

  const files = treeData?.files ?? [];
  const statusColor = folder.syncStatus === 'syncing' ? 'bg-amber-500 animate-pulse'
    : folder.syncStatus === 'error' ? 'bg-red-500' : 'bg-emerald-500';

  return (
    <div className={sectionShellClass(open)}>
      <SectionHeader
        open={open}
        onToggle={onToggle}
        icon={<HardDrive className="w-3.5 h-3.5" />}
        label={folder.folderName}
        meta={<span className={cn('w-1.5 h-1.5 rounded-full ml-1 flex-shrink-0', statusColor)} />}
        actions={
          <div className="flex items-center gap-0.5">
            {/* Upload button */}
            <label htmlFor={fileInputId} className={cn(sectionActionClass, 'cursor-pointer')} title="Upload file">
              <Upload className="w-3.5 h-3.5" />
            </label>
            <input id={fileInputId} type="file" multiple className="sr-only"
              onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) onUpload(folder.id, f); e.target.value = ''; }} />
            <button onClick={() => refetch()} className={sectionActionClass} title="Refresh">
              <RefreshCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} />
            </button>
          </div>
        }
      />

      {open && (
        <DropZone onFiles={(f) => onUpload(folder.id, f)} uploading={uploading} className="flex flex-col min-h-0 flex-1">
          <TreeFilterInput value={filter} onChange={setFilter} placeholder="Search files..." />
          <div className={treeListClass}>
            {isLoading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
              </div>
            )}
            {error && (
              <div className="px-3 py-3 text-xs text-red-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>Failed to load files</span>
              </div>
            )}
            {!isLoading && !error && files.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                {folder.lastSyncedAt ? 'No files found' : 'Not synced yet'}
              </div>
            )}
            {files.map((node) => (
              <GDriveFileNode
                key={node.fileId}
                node={node}
                depth={0}
                selectedId={selectedId}
                onSelect={(n) => onSelect(folder.id, folder.folderName, n)}
                filterQuery={filter}
              />
            ))}
          </div>
          {folder.lastSyncedAt && (
            <div className="px-3 py-1.5 flex items-center gap-1.5 border-t border-border/60">
              <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
              <span className="text-[10px] text-muted-foreground">Synced {timeAgo(folder.lastSyncedAt)}</span>
            </div>
          )}
        </DropZone>
      )}
    </div>
  );
}
