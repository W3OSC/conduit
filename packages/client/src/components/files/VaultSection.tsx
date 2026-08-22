/** Obsidian vault sidebar section: sync badge, search, file tree. */

import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen, RefreshCw, Loader2,
  AlertCircle, BookOpen, Clock, GitBranch, Wifi, CheckCircle2,
} from 'lucide-react';
import { api, type VaultFileEntry, type ObsidianVaultConfigRow } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import { toast, useConnectionStore } from '@/store';
import { TreeNode } from './TreeNode';
import {
  type SelectedItem, flattenFiles, sectionShellClass, SectionHeader,
  sectionActionClass, TreeFilterInput, connectCtaClass, treeListClass,
} from './shared';

// ── Sync status badge ─────────────────────────────────────────────────────────

export function SyncBadge({ status, lastSync }: { status: string; lastSync: string | null }) {
  if (status === 'syncing') return (
    <div className="flex items-center gap-1.5 text-xs text-primary">
      <Loader2 className="w-3 h-3 animate-spin" />
      <span>Syncing...</span>
    </div>
  );
  if (status === 'error') return (
    <div className="flex items-center gap-1.5 text-xs text-red-400">
      <AlertCircle className="w-3 h-3" />
      <span>Sync error</span>
    </div>
  );
  if (status === 'idle' && lastSync) return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2 className="w-3 h-3 text-emerald-500" />
      <span>Synced {timeAgo(lastSync)}</span>
    </div>
  );
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock className="w-3 h-3" />
      <span>Not synced yet</span>
    </div>
  );
}

// ── Obsidian file tree node ───────────────────────────────────────────────────

interface FileTreeNodeProps {
  entry: VaultFileEntry;
  selectedId: string | null;
  onSelect: (entry: VaultFileEntry) => void;
  depth: number;
  filterQuery: string;
}

function ObsidianFileNode({ entry, selectedId, onSelect, depth, filterQuery }: FileTreeNodeProps) {
  const [open, setOpen] = useState(depth < 2);

  useEffect(() => {
    if (filterQuery) setOpen(true);
  }, [filterQuery]);

  if (entry.type === 'directory') {
    if (filterQuery) {
      const hasMatch = flattenFiles(entry.children ?? [], filterQuery).length > 0;
      if (!hasMatch) return null;
    }
    return (
      <TreeNode
        depth={depth}
        variant="branch"
        label={entry.name}
        onClick={() => setOpen(!open)}
        icon={
          <span className="flex-shrink-0 text-muted-foreground">
            {open ? <FolderOpen className="w-3.5 h-3.5" /> : <Folder className="w-3.5 h-3.5" />}
          </span>
        }
        caret={
          <span className="flex-shrink-0 text-muted-foreground">
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
        }
      >
        {open && entry.children && (
          <div>
            {entry.children.map((child) => (
              <ObsidianFileNode
                key={child.path}
                entry={child}
                selectedId={selectedId}
                onSelect={onSelect}
                depth={depth + 1}
                filterQuery={filterQuery}
              />
            ))}
          </div>
        )}
      </TreeNode>
    );
  }

  if (filterQuery && !entry.path.toLowerCase().includes(filterQuery.toLowerCase())) return null;

  const isSelected = selectedId === entry.path;
  const isMd = entry.extension === '.md';

  return (
    <TreeNode
      depth={depth}
      variant="leaf"
      selected={isSelected}
      label={isMd ? entry.name.replace(/\.md$/, '') : entry.name}
      onClick={() => onSelect(entry)}
      className="gap-2 truncate"
      icon={<FileText className={cn('w-3.5 h-3.5 flex-shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')} />}
    />
  );
}

// ── Per-vault sidebar section ─────────────────────────────────────────────────

export interface VaultSectionProps {
  vault: ObsidianVaultConfigRow;
  selectedItem: SelectedItem | null;
  onSelect: (vaultId: number, entry: VaultFileEntry) => void;
  onWikilinkNavigate: (vaultId: number, target: string, allFiles: VaultFileEntry[]) => void;
  open: boolean;
  onToggle: () => void;
}

export function VaultSection({ vault, selectedItem, onSelect, open, onToggle }: VaultSectionProps) {
  const [filter, setFilter] = useState('');

  const allStatuses = useConnectionStore((s) => s.statuses);
  const vaultStatusKey = `obsidian:${vault.id}` as keyof typeof allStatuses;
  const vaultConnStatus = (allStatuses[vaultStatusKey] as { status: string } | undefined)
    ?? vault.connectionStatus;
  const isConnected = vaultConnStatus?.status === 'connected';

  const { data: syncData, refetch: refetchSync } = useQuery({
    queryKey: ['obsidian-sync-status', vault.id],
    queryFn: () => api.obsidianSyncStatus(vault.id),
    staleTime: 10000,
    refetchInterval: 15000,
    enabled: isConnected,
  });

  const { data: filesData, isLoading: filesLoading, error: filesError, refetch: refetchFiles } = useQuery({
    queryKey: ['obsidian-files', vault.id],
    queryFn: () => api.obsidianFiles(vault.id),
    staleTime: 60000,
    enabled: isConnected,
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncObsidianVault(vault.id),
    onSuccess: () => {
      toast({ title: `Vault sync started: ${vault.name}` });
      setTimeout(() => { refetchSync(); refetchFiles(); }, 2000);
    },
    onError: (e) => toast({ title: e instanceof Error ? e.message : 'Sync failed' }),
  });

  const selectedId = selectedItem?.source.kind === 'obsidian' && selectedItem.source.vaultId === vault.id
    ? selectedItem.id
    : null;

  return (
    <div className={sectionShellClass(open)}>
      <SectionHeader
        open={open}
        onToggle={onToggle}
        icon={<BookOpen className="w-3.5 h-3.5" />}
        label={vault.name}
        actions={
          isConnected && (
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className={sectionActionClass}
              title="Sync vault"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', syncMutation.isPending && 'animate-spin')} />
            </button>
          )
        }
      />

      {open && (
        <div className="flex flex-col min-h-0 flex-1">
          {!isConnected ? (
            <div className="px-4 py-4 space-y-2">
              <p className="text-xs text-muted-foreground">Vault not connected.</p>
              <a href="/settings/files" className={connectCtaClass}>
                Set up Vault
              </a>
            </div>
          ) : (
            <>
              <div className="px-3 py-1.5 border-b border-border/60 flex items-center justify-between gap-2">
                <SyncBadge
                  status={syncData?.syncStatus || 'idle'}
                  lastSync={syncData?.lastSyncedAt ?? null}
                />
                {syncData?.lastCommitHash && (
                  <div className="flex items-center gap-1">
                    <GitBranch className="w-3 h-3 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground font-mono">{syncData.lastCommitHash.slice(0, 7)}</span>
                  </div>
                )}
              </div>
              <TreeFilterInput value={filter} onChange={setFilter} placeholder="Search notes..." />
              <div className={treeListClass}>
                {filesLoading && (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                  </div>
                )}
                {filesError && (
                  <div className="px-3 py-3 text-xs text-red-400 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>Failed to load files</span>
                  </div>
                )}
                {filesData?.files && filesData.files.length === 0 && (
                  <div className="px-3 py-3 text-xs text-muted-foreground text-center">Vault is empty</div>
                )}
                {filesData?.files?.map((entry) => (
                  <ObsidianFileNode
                    key={entry.path}
                    entry={entry}
                    selectedId={selectedId}
                    onSelect={(e) => onSelect(vault.id, e)}
                    depth={0}
                    filterQuery={filter}
                  />
                ))}
              </div>
              <div className="px-3 py-1.5 flex items-center gap-1.5">
                <Wifi className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                <span className="text-[10px] text-muted-foreground">Connected via git</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
