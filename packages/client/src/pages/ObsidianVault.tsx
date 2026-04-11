/**
 * ObsidianVault — file tree + markdown renderer for the synced Obsidian vault.
 *
 * Layout:
 *   Left panel  (260px): collapsible folder tree with search
 *   Right panel (flex-1): rendered markdown with wikilink navigation, edit mode
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen, Search,
  RefreshCw, Loader2, AlertCircle, Edit2, X, Send, BookOpen,
  Clock, GitBranch, Wifi, WifiOff, CheckCircle2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type VaultFileEntry } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import { toast } from '@/store';
import { useConnectionStore } from '@/store';

// ── Wikilink remark plugin ────────────────────────────────────────────────────
// Transforms [[Note Name]] and [[Note Name|Alias]] into custom link nodes.

function transformWikilinks(markdown: string): string {
  // Replace [[target|alias]] and [[target]] with a special marker
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, inner) => {
    const parts = inner.split('|');
    const target = parts[0].trim();
    const alias = parts[1]?.trim() || target;
    // Encode as a regular markdown link with wikilink:// scheme for detection
    return `[${alias}](wikilink://${encodeURIComponent(target)})`;
  });
}

// ── File tree ─────────────────────────────────────────────────────────────────

function flattenFiles(entries: VaultFileEntry[], query: string): VaultFileEntry[] {
  const result: VaultFileEntry[] = [];
  function walk(items: VaultFileEntry[]) {
    for (const item of items) {
      if (item.type === 'file') {
        if (!query || item.path.toLowerCase().includes(query.toLowerCase())) {
          result.push(item);
        }
      } else if (item.children) {
        walk(item.children);
      }
    }
  }
  walk(entries);
  return result;
}

interface FileTreeNodeProps {
  entry: VaultFileEntry;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth: number;
  filterQuery: string;
}

function FileTreeNode({ entry, selectedPath, onSelect, depth, filterQuery }: FileTreeNodeProps) {
  const [open, setOpen] = useState(depth < 2);

  // Auto-expand directories when there's a filter query
  useEffect(() => {
    if (filterQuery) setOpen(true);
  }, [filterQuery]);

  if (entry.type === 'directory') {
    // If filtering, check if any children match
    if (filterQuery) {
      const hasMatch = flattenFiles(entry.children ?? [], filterQuery).length > 0;
      if (!hasMatch) return null;
    }

    return (
      <div>
        <button
          onClick={() => setOpen(!open)}
          className={cn(
            'flex items-center gap-1.5 w-full px-2 py-1 rounded-lg text-left text-xs',
            'text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors',
          )}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <span className="flex-shrink-0 text-warm-500">
            {open ? <FolderOpen className="w-3.5 h-3.5" /> : <Folder className="w-3.5 h-3.5" />}
          </span>
          <span className="flex-shrink-0 text-warm-500">
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
          <span className="truncate font-medium">{entry.name}</span>
        </button>
        {open && entry.children && (
          <div>
            {entry.children.map((child) => (
              <FileTreeNode
                key={child.path}
                entry={child}
                selectedPath={selectedPath}
                onSelect={onSelect}
                depth={depth + 1}
                filterQuery={filterQuery}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File — filter
  if (filterQuery && !entry.path.toLowerCase().includes(filterQuery.toLowerCase())) {
    return null;
  }

  const isSelected = selectedPath === entry.path;
  const isMd = entry.extension === '.md';

  return (
    <button
      onClick={() => onSelect(entry.path)}
      className={cn(
        'flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-left text-xs truncate',
        'transition-colors',
        isSelected
          ? 'bg-primary/15 text-primary'
          : 'text-sidebar-foreground hover:bg-white/5 hover:text-foreground',
      )}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <FileText className={cn('w-3.5 h-3.5 flex-shrink-0', isSelected ? 'text-primary' : 'text-warm-500')} />
      <span className="truncate">{isMd ? entry.name.replace(/\.md$/, '') : entry.name}</span>
    </button>
  );
}

// ── Frontmatter parser ────────────────────────────────────────────────────────

interface Frontmatter {
  title?: string;
  tags?: string[];
  date?: string;
  created?: string;
  modified?: string;
  [key: string]: unknown;
}

function parseFrontmatter(content: string): { meta: Frontmatter; body: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: content };

  const yamlLines = fmMatch[1].split('\n');
  const meta: Frontmatter = {};
  for (const line of yamlLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    // Simple tag parsing: "[tag1, tag2]" or "tag1"
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((t) => t.trim().replace(/^["']|["']$/g, ''));
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { meta, body: fmMatch[2] };
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

interface MarkdownViewProps {
  content: string;
  onWikilinkClick: (target: string) => void;
}

function MarkdownView({ content, onWikilinkClick }: MarkdownViewProps) {
  const transformed = useMemo(() => transformWikilinks(content), [content]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, ...props }) => {
          if (href?.startsWith('wikilink://')) {
            const target = decodeURIComponent(href.slice('wikilink://'.length));
            return (
              <button
                onClick={() => onWikilinkClick(target)}
                className="text-primary hover:text-primary/80 underline underline-offset-2 cursor-pointer"
              >
                {children}
              </button>
            );
          }
          return (
            <a href={href} {...props} target="_blank" rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 underline underline-offset-2">
              {children}
            </a>
          );
        },
        h1: ({ children }) => <h1 className="text-2xl font-bold text-foreground mt-6 mb-3 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-xl font-semibold text-foreground mt-5 mb-2">{children}</h2>,
        h3: ({ children }) => <h3 className="text-lg font-medium text-foreground mt-4 mb-2">{children}</h3>,
        h4: ({ children }) => <h4 className="text-base font-medium text-foreground mt-3 mb-1">{children}</h4>,
        p: ({ children }) => <p className="text-sm text-foreground/90 leading-relaxed mb-3">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside space-y-1 mb-3 text-sm text-foreground/90">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside space-y-1 mb-3 text-sm text-foreground/90">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-primary/40 pl-4 my-3 text-muted-foreground italic">{children}</blockquote>
        ),
        code: ({ children, className }) => {
          const isBlock = className?.startsWith('language-');
          if (isBlock) {
            return (
              <pre className="bg-black/30 rounded-lg p-4 my-3 overflow-x-auto text-xs font-mono border border-white/5">
                <code className="text-emerald-300">{children}</code>
              </pre>
            );
          }
          return <code className="bg-black/20 text-primary/80 px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>;
        },
        hr: () => <hr className="border-white/10 my-6" />,
        table: ({ children }) => (
          <div className="overflow-x-auto my-4">
            <table className="w-full text-sm border-collapse">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="text-left px-3 py-2 border border-white/10 bg-white/5 font-medium text-foreground">{children}</th>
        ),
        td: ({ children }) => (
          <td className="px-3 py-2 border border-white/10 text-foreground/80">{children}</td>
        ),
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
        input: ({ type, checked }) => (
          type === 'checkbox'
            ? <input type="checkbox" checked={checked} readOnly className="mr-2 accent-primary" />
            : null
        ),
      }}
    >
      {transformed}
    </ReactMarkdown>
  );
}

// ── Sync status badge ─────────────────────────────────────────────────────────

function SyncBadge({ status, lastSync }: { status: string; lastSync: string | null }) {
  if (status === 'syncing') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-primary">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>Syncing...</span>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-red-400">
        <AlertCircle className="w-3 h-3" />
        <span>Sync error</span>
      </div>
    );
  }
  if (status === 'idle' && lastSync) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
        <span>Synced {timeAgo(lastSync)}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock className="w-3 h-3" />
      <span>Not synced yet</span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ObsidianVault() {
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  const connectionStatus = useConnectionStore((s) => s.statuses['obsidian']);

  // Load vault config / sync status
  const { data: configData } = useQuery({
    queryKey: ['obsidian-config'],
    queryFn: () => api.obsidianConfig(),
    staleTime: 30000,
  });

  const { data: syncData, refetch: refetchSync } = useQuery({
    queryKey: ['obsidian-sync-status'],
    queryFn: () => api.obsidianSyncStatus(),
    staleTime: 10000,
    refetchInterval: 15000,
  });

  // File tree
  const { data: filesData, isLoading: filesLoading, error: filesError, refetch: refetchFiles } = useQuery({
    queryKey: ['obsidian-files'],
    queryFn: () => api.obsidianFiles(),
    staleTime: 60000,
    enabled: configData?.configured && connectionStatus?.status === 'connected',
  });

  // Selected file content
  const { data: fileData, isLoading: fileLoading, error: fileError } = useQuery({
    queryKey: ['obsidian-file', selectedPath],
    queryFn: () => api.obsidianReadFile(selectedPath!),
    enabled: !!selectedPath,
    staleTime: 60000,
  });

  // Manual sync
  const syncMutation = useMutation({
    mutationFn: () => api.syncObsidianVault(),
    onSuccess: () => {
      toast({ title: 'Vault sync started' });
      setTimeout(() => {
        refetchSync();
        refetchFiles();
        if (selectedPath) queryClient.invalidateQueries({ queryKey: ['obsidian-file'] });
      }, 2000);
    },
    onError: (e) => toast({ title: e instanceof Error ? e.message : 'Sync failed' }),
  });

  // Queue write via outbox
  const writeMutation = useMutation({
    mutationFn: () => api.createOutboxItem({
      source: 'obsidian',
      recipient_id: selectedPath!,
      recipient_name: selectedPath!,
      content: JSON.stringify({ action: 'write_file', path: selectedPath, content: editContent }),
    }),
    onSuccess: () => {
      toast({ title: 'Write queued for approval in Outbox' });
      setEditMode(false);
    },
    onError: (e) => toast({ title: e instanceof Error ? e.message : 'Failed to queue write' }),
  });

  // Enter edit mode — pre-fill with current content
  const handleEdit = useCallback(() => {
    if (fileData?.content) {
      setEditContent(fileData.content);
      setEditMode(true);
    }
  }, [fileData]);

  // Cancel edit
  const handleCancelEdit = useCallback(() => {
    setEditMode(false);
    setEditContent('');
  }, []);

  // Wikilink navigation — find file by note name
  const handleWikilinkClick = useCallback((target: string) => {
    if (!filesData?.files) return;
    const allFiles = flattenFiles(filesData.files, '');
    // Try exact match first (without .md extension), then partial
    const match = allFiles.find((f) => {
      const nameWithout = f.name.replace(/\.md$/, '');
      return nameWithout.toLowerCase() === target.toLowerCase();
    }) || allFiles.find((f) => f.path.toLowerCase().includes(target.toLowerCase()));
    if (match) {
      setSelectedPath(match.path);
      setEditMode(false);
      if (contentRef.current) contentRef.current.scrollTop = 0;
    } else {
      toast({ title: `Note not found: ${target}` });
    }
  }, [filesData]);

  // Reset to top when file changes
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    setEditMode(false);
  }, [selectedPath]);

  // ── Not configured ───────────────────────────────────────────────────────────

  if (!configData?.configured) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center max-w-sm space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
            <BookOpen className="w-7 h-7 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Obsidian Vault</h2>
            <p className="text-sm text-muted-foreground mt-1.5">
              Connect your Obsidian vault to read and manage notes directly in Conduit.
            </p>
          </div>
          <a
            href="/settings/vault"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Set up Vault
          </a>
        </div>
      </div>
    );
  }

  // ── Not connected ────────────────────────────────────────────────────────────

  if (connectionStatus?.status === 'error' || connectionStatus?.status === 'disconnected') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center max-w-sm space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
            <WifiOff className="w-7 h-7 text-red-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Vault Not Connected</h2>
            <p className="text-sm text-muted-foreground mt-1.5">
              {connectionStatus?.error || 'The vault could not be connected. Ensure it has been cloned.'}
            </p>
          </div>
          <div className="flex gap-2 justify-center">
            <a
              href="/settings/vault"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-white/10 text-sm font-medium hover:bg-white/5 transition-colors"
            >
              Settings
            </a>
            <button
              onClick={() => syncMutation.mutate()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Retry Sync
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { meta, body } = fileData?.content ? parseFrontmatter(fileData.content) : { meta: {}, body: '' };
  const title = meta.title || (selectedPath ? selectedPath.replace(/\.md$/, '').split('/').pop() : '');

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── File tree panel ──────────────────────────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 flex flex-col border-r border-white/8 overflow-hidden bg-sidebar">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-white/8">
          <BookOpen className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-sm font-semibold text-foreground flex-1 truncate">
            {configData.vault?.name || 'Vault'}
          </span>
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
            title="Sync vault"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', syncMutation.isPending && 'animate-spin')} />
          </button>
        </div>

        {/* Sync status */}
        <div className="px-3 py-2 border-b border-white/5">
          <SyncBadge
            status={syncData?.syncStatus || 'idle'}
            lastSync={syncData?.lastSyncedAt ?? null}
          />
          {syncData?.lastCommitHash && (
            <div className="flex items-center gap-1 mt-1">
              <GitBranch className="w-3 h-3 text-warm-600" />
              <span className="text-[10px] text-warm-600 font-mono">{syncData.lastCommitHash.slice(0, 8)}</span>
            </div>
          )}
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-white/5">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search notes..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="w-full bg-black/20 border border-white/8 rounded-lg pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
            />
            {filterQuery && (
              <button onClick={() => setFilterQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                <X className="w-3 h-3 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>

        {/* File tree */}
        <div className="flex-1 overflow-y-auto py-1 px-1">
          {filesLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          )}
          {filesError && (
            <div className="px-3 py-4 text-xs text-red-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>Failed to load files</span>
            </div>
          )}
          {filesData?.files && filesData.files.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">
              Vault is empty
            </div>
          )}
          {filesData?.files?.map((entry) => (
            <FileTreeNode
              key={entry.path}
              entry={entry}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
              depth={0}
              filterQuery={filterQuery}
            />
          ))}
        </div>

        {/* Connection dot */}
        <div className="px-3 py-2 border-t border-white/8 flex items-center gap-2">
          <Wifi className="w-3 h-3 text-emerald-500" />
          <span className="text-[10px] text-muted-foreground">Connected via git</span>
        </div>
      </aside>

      {/* ── Content panel ─────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedPath ? (
          // Empty state
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-2">
              <FileText className="w-10 h-10 text-warm-600 mx-auto" />
              <p className="text-sm text-muted-foreground">Select a note to read it</p>
            </div>
          </div>
        ) : (
          <>
            {/* File header */}
            <div className="flex items-center gap-3 px-6 py-3 border-b border-white/8 flex-shrink-0">
              <div className="flex-1 min-w-0">
                <h1 className="text-base font-semibold text-foreground truncate">{title}</h1>
                <p className="text-xs text-muted-foreground truncate">{selectedPath}</p>
              </div>
              {!editMode && fileData && (
                <button
                  onClick={handleEdit}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                  Edit
                </button>
              )}
              {editMode && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCancelEdit}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                  <button
                    onClick={() => writeMutation.mutate()}
                    disabled={writeMutation.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {writeMutation.isPending
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Send className="w-3.5 h-3.5" />
                    }
                    Queue Write
                  </button>
                </div>
              )}
            </div>

            {/* Frontmatter metadata strip */}
            {!editMode && fileData && Object.keys(meta).length > 0 && (
              <div className="px-6 py-2 border-b border-white/5 flex flex-wrap gap-x-4 gap-y-1 flex-shrink-0">
                {meta.tags && Array.isArray(meta.tags) && meta.tags.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    {(meta.tags as string[]).map((tag) => (
                      <span key={tag} className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                {(meta.date || meta.created) && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {String(meta.date || meta.created)}
                  </span>
                )}
              </div>
            )}

            {/* Content area */}
            <div ref={contentRef} className="flex-1 overflow-y-auto">
              {fileLoading && (
                <div className="flex items-center justify-center h-32">
                  <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
                </div>
              )}
              {fileError && (
                <div className="px-6 py-8 flex items-center gap-3 text-red-400">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <span className="text-sm">{fileError instanceof Error ? fileError.message : 'Failed to load file'}</span>
                </div>
              )}
              {fileData && !fileLoading && !fileError && (
                editMode ? (
                  // Edit mode — raw textarea
                  <div className="p-6 h-full flex flex-col gap-3">
                    <div className="flex items-center gap-2 text-xs text-primary bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>Changes are queued for human approval before being committed and pushed.</span>
                    </div>
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="flex-1 w-full bg-black/20 border border-white/10 rounded-xl p-4 text-sm font-mono text-foreground focus:outline-none focus:border-primary/40 resize-none leading-relaxed"
                      spellCheck={false}
                    />
                  </div>
                ) : (
                  // Read mode — rendered markdown
                  <div className="px-8 py-6 max-w-3xl">
                    <MarkdownView content={body} onWikilinkClick={handleWikilinkClick} />
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
