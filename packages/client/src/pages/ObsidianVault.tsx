/**
 * KnowledgeVault — unified knowledge tree: multiple Obsidian vaults + Notion workspace.
 *
 * Left sidebar: collapsible sections, one per Obsidian vault + one for Notion.
 *   Each vault section has its own file tree, sync badge, and search input.
 *   Notion section has a lazy-loading page/database tree.
 *
 * Right panel: shared markdown viewer with frontmatter metadata strip and
 *   edit/queue-write support for Obsidian files.
 */

import {
  useState, useCallback, useRef, useEffect, useMemo,
} from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen, Search,
  RefreshCw, Loader2, AlertCircle, Edit2, X, Send, BookOpen,
  Clock, GitBranch, Wifi, CheckCircle2, Database,
  StickyNote, ExternalLink, Plus,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  api,
  type VaultFileEntry,
  type ObsidianVaultConfigRow,
  type NotionBlock,
  type NotionSearchResult,
  type NotionPage,
} from '@/lib/api';
import {
  notionBlocksToMarkdown,
  getResultTitle,
  getResultIcon,
  resultHasChildren,
} from '@/lib/notionUtils';
import { cn, timeAgo } from '@/lib/utils';
import { toast } from '@/store';
import { useConnectionStore } from '@/store';

// ── Types ─────────────────────────────────────────────────────────────────────

type Source = { kind: 'obsidian'; vaultId: number } | { kind: 'notion' };

interface SelectedItem {
  source: Source;
  /** Obsidian: relative file path. Notion: page ID. */
  id: string;
  title: string;
}

// ── Wikilink transform ────────────────────────────────────────────────────────

function transformWikilinks(markdown: string): string {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, inner) => {
    const parts = inner.split('|');
    const target = parts[0].trim();
    const alias = parts[1]?.trim() || target;
    return `[${alias}](wikilink://${encodeURIComponent(target)})`;
  });
}

// ── Obsidian file tree ────────────────────────────────────────────────────────

function flattenFiles(entries: VaultFileEntry[], query: string): VaultFileEntry[] {
  const result: VaultFileEntry[] = [];
  function walk(items: VaultFileEntry[]) {
    for (const item of items) {
      if (item.type === 'file') {
        if (!query || item.path.toLowerCase().includes(query.toLowerCase())) result.push(item);
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
      <div>
        <button
          onClick={() => setOpen(!open)}
          className={cn('flex items-center gap-1.5 w-full px-2 py-1 rounded-lg text-left text-xs',
            'text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors')}
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
      </div>
    );
  }

  if (filterQuery && !entry.path.toLowerCase().includes(filterQuery.toLowerCase())) return null;

  const isSelected = selectedId === entry.path;
  const isMd = entry.extension === '.md';

  return (
    <button
      onClick={() => onSelect(entry)}
      className={cn('flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-left text-xs truncate transition-colors',
        isSelected ? 'bg-primary/15 text-primary' : 'text-sidebar-foreground hover:bg-white/5 hover:text-foreground')}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <FileText className={cn('w-3.5 h-3.5 flex-shrink-0', isSelected ? 'text-primary' : 'text-warm-500')} />
      <span className="truncate">{isMd ? entry.name.replace(/\.md$/, '') : entry.name}</span>
    </button>
  );
}

// ── Notion tree node ──────────────────────────────────────────────────────────

interface NotionNodeProps {
  result: NotionSearchResult;
  selectedId: string | null;
  onSelect: (result: NotionSearchResult) => void;
  depth: number;
  childrenCache: Map<string, NotionSearchResult[]>;
  onChildrenLoaded: (parentId: string, children: NotionSearchResult[]) => void;
}

function NotionTreeNode({ result, selectedId, onSelect, depth, childrenCache, onChildrenLoaded }: NotionNodeProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasChildren = resultHasChildren(result);
  const isSelected = selectedId === result.id;
  const icon = getResultIcon(result);
  const title = getResultTitle(result);
  const isDatabase = result.object === 'database';
  const cachedChildren = childrenCache.get(result.id);

  async function handleExpand() {
    if (!hasChildren) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (cachedChildren !== undefined) return;
    setLoading(true);
    setError(null);
    try {
      if (isDatabase) {
        const resp = await api.notionSearch({ page_size: 50 });
        const children = resp.results.filter((r) => {
          if (r.object !== 'page') return false;
          const p = r as NotionPage;
          return p.parent?.type === 'database_id' && p.parent.database_id === result.id;
        });
        onChildrenLoaded(result.id, children);
      } else {
        const resp = await api.notionBlockChildren(result.id, { page_size: 100 });
        const childPageBlocks = resp.results.filter(
          (b: NotionBlock) => b.type === 'child_page' || b.type === 'child_database',
        );
        const pseudoChildren: NotionSearchResult[] = childPageBlocks.map((b: NotionBlock) => ({
          id: b.id,
          object: b.type === 'child_database' ? 'database' as const : 'page' as const,
          url: '',
          created_time: b.created_time,
          last_edited_time: b.last_edited_time,
          archived: b.archived,
          has_children: b.has_children,
          parent: { type: 'page_id', page_id: result.id },
          properties: {
            title: {
              id: 'title',
              type: 'title',
              title: [{ type: 'text', plain_text: b.child_page?.title ?? b.child_database?.title ?? 'Untitled', annotations: {} }],
            },
          },
          icon: null,
          cover: null,
          title: b.child_database
            ? [{ type: 'text', plain_text: b.child_database.title ?? 'Untitled', annotations: {} }]
            : undefined,
        } as unknown as NotionSearchResult));
        onChildrenLoaded(result.id, pseudoChildren);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => { if (hasChildren) handleExpand(); onSelect(result); }}
        className={cn('flex items-center gap-1.5 w-full px-2 py-1.5 rounded-lg text-left text-xs transition-colors group',
          isSelected ? 'bg-primary/15 text-primary' : 'text-sidebar-foreground hover:bg-white/5 hover:text-foreground')}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        <span className={cn('flex-shrink-0', hasChildren ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
            : open ? <ChevronDown className="w-3 h-3 text-warm-500" />
            : <ChevronRight className="w-3 h-3 text-warm-500" />}
        </span>
        <span className="flex-shrink-0 w-3.5 text-center">
          {icon
            ? <span className="text-[11px] leading-none">{icon}</span>
            : isDatabase
              ? <Database className={cn('w-3.5 h-3.5', isSelected ? 'text-primary' : 'text-warm-500')} />
              : <StickyNote className={cn('w-3.5 h-3.5', isSelected ? 'text-primary' : 'text-warm-500')} />}
        </span>
        <span className="truncate flex-1">{title}</span>
      </button>
      {error && (
        <div className="pl-6 py-1 text-[10px] text-red-400 flex items-center gap-1">
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {open && cachedChildren !== undefined && cachedChildren.length === 0 && (
        <div className="pl-8 py-1 text-[10px] text-muted-foreground italic">Empty</div>
      )}
      {open && cachedChildren && cachedChildren.length > 0 && (
        <div>
          {cachedChildren.map((child) => (
            <NotionTreeNode
              key={child.id}
              result={child}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
              childrenCache={childrenCache}
              onChildrenLoaded={onChildrenLoaded}
            />
          ))}
        </div>
      )}
    </div>
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
  onWikilinkClick?: (target: string) => void;
}

function MarkdownView({ content, onWikilinkClick }: MarkdownViewProps) {
  const transformed = useMemo(() => transformWikilinks(content), [content]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, ref: _ref, ...props }) => {
          if (href?.startsWith('wikilink://') && onWikilinkClick) {
            const target = decodeURIComponent(href.slice('wikilink://'.length));
            return (
              <button onClick={() => onWikilinkClick(target)}
                className="text-primary hover:text-primary/80 underline underline-offset-2 cursor-pointer">
                {children}
              </button>
            );
          }
          return <a href={href} {...props} target="_blank" rel="noopener noreferrer"
            className="text-primary hover:text-primary/80 underline underline-offset-2">{children}</a>;
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
          if (isBlock) return (
            <pre className="bg-black/30 rounded-lg p-4 my-3 overflow-x-auto text-xs font-mono border border-white/5">
              <code className="text-emerald-300">{children}</code>
            </pre>
          );
          return <code className="bg-black/20 text-primary/80 px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>;
        },
        hr: () => <hr className="border-white/10 my-6" />,
        table: ({ children }) => <div className="overflow-x-auto my-4"><table className="w-full text-sm border-collapse">{children}</table></div>,
        th: ({ children }) => <th className="text-left px-3 py-2 border border-white/10 bg-white/5 font-medium text-foreground">{children}</th>,
        td: ({ children }) => <td className="px-3 py-2 border border-white/10 text-foreground/80">{children}</td>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
        input: ({ type, checked }) => (
          type === 'checkbox' ? <input type="checkbox" checked={checked} readOnly className="mr-2 accent-primary" /> : null
        ),
      }}
    >
      {transformed}
    </ReactMarkdown>
  );
}

// ── Sync status badge ─────────────────────────────────────────────────────────

function SyncBadge({ status, lastSync }: { status: string; lastSync: string | null }) {
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

// ── Section header (collapsible) ──────────────────────────────────────────────

interface SectionHeaderProps {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}

function SectionHeader({ open, onToggle, icon, label, meta, actions }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-white/8">
      <button onClick={onToggle} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
        {open
          ? <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
        <span className="flex-shrink-0 text-primary">{icon}</span>
        <span className="text-xs font-semibold text-foreground truncate">{label}</span>
        {meta && <span className="flex-shrink-0">{meta}</span>}
      </button>
      {actions}
    </div>
  );
}

// ── Source badge (shown in viewer header) ─────────────────────────────────────

function SourceBadge({ source, vaultName }: { source: Source; vaultName?: string }) {
  if (source.kind === 'obsidian') {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 text-[10px] font-medium border border-purple-500/20">
        <BookOpen className="w-2.5 h-2.5" />
        {vaultName ?? 'Obsidian'}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-warm-500/15 text-warm-300 text-[10px] font-medium border border-warm-500/20">
      <StickyNote className="w-2.5 h-2.5" />
      Notion
    </span>
  );
}

// ── Per-vault sidebar section ─────────────────────────────────────────────────

interface VaultSectionProps {
  vault: ObsidianVaultConfigRow;
  selectedItem: SelectedItem | null;
  onSelect: (vaultId: number, entry: VaultFileEntry) => void;
  onWikilinkNavigate: (vaultId: number, target: string, allFiles: VaultFileEntry[]) => void;
}

function VaultSection({ vault, selectedItem, onSelect }: VaultSectionProps) {
  const [open, setOpen] = useState(true);
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
    <div className="flex flex-col border-b border-white/8" style={{ maxHeight: '40%', minHeight: open ? '120px' : undefined }}>
      <SectionHeader
        open={open}
        onToggle={() => setOpen(!open)}
        icon={<BookOpen className="w-3.5 h-3.5" />}
        label={vault.name}
        actions={
          isConnected && (
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors flex-shrink-0"
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
              <a href="/settings/vault"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium border border-primary/20 hover:bg-primary/20 transition-colors">
                Set up Vault
              </a>
            </div>
          ) : (
            <>
              {/* Sync status */}
              <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between gap-2">
                <SyncBadge
                  status={syncData?.syncStatus || 'idle'}
                  lastSync={syncData?.lastSyncedAt ?? null}
                />
                {syncData?.lastCommitHash && (
                  <div className="flex items-center gap-1">
                    <GitBranch className="w-3 h-3 text-warm-600" />
                    <span className="text-[10px] text-warm-600 font-mono">{syncData.lastCommitHash.slice(0, 7)}</span>
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
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="w-full bg-black/20 border border-white/8 rounded-lg pl-8 pr-7 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
                  />
                  {filter && (
                    <button onClick={() => setFilter('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                      <X className="w-3 h-3 text-muted-foreground" />
                    </button>
                  )}
                </div>
              </div>

              {/* File tree */}
              <div className="flex-1 overflow-y-auto py-1 px-1 min-h-0">
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

              {/* Connection indicator */}
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

// ── Main component ────────────────────────────────────────────────────────────

export default function ObsidianVault() {
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  const [notionOpen, setNotionOpen] = useState(true);
  const [notionFilter, setNotionFilter] = useState('');
  const [notionChildrenCache, setNotionChildrenCache] = useState<Map<string, NotionSearchResult[]>>(new Map());

  const notionStatus = useConnectionStore((s) => s.statuses['notion']);
  const notionConnected = notionStatus?.status === 'connected';

  // ── Vault list ───────────────────────────────────────────────────────────────
  const { data: vaultsData } = useQuery({
    queryKey: ['obsidian-vaults'],
    queryFn: () => api.listObsidianVaults(),
    staleTime: 30000,
  });
  const vaults = vaultsData?.vaults ?? [];

  // ── Notion data ──────────────────────────────────────────────────────────────
  const {
    data: notionSearchData,
    isLoading: notionLoading,
    error: notionError,
    refetch: refetchNotion,
  } = useQuery({
    queryKey: ['notion-search', notionFilter],
    queryFn: () => api.notionSearch({ query: notionFilter || undefined, page_size: 50 }),
    staleTime: 60000,
    enabled: notionConnected,
  });

  // ── Obsidian: read selected file ─────────────────────────────────────────────
  const selectedObsidianVaultId = selected?.source.kind === 'obsidian' ? selected.source.vaultId : null;
  const selectedObsidianPath = selected?.source.kind === 'obsidian' ? selected.id : null;

  const { data: obsidianFileData, isLoading: obsidianFileLoading, error: obsidianFileError } = useQuery({
    queryKey: ['obsidian-file', selectedObsidianVaultId, selectedObsidianPath],
    queryFn: () => api.obsidianReadFile(selectedObsidianVaultId!, selectedObsidianPath!),
    enabled: selected?.source.kind === 'obsidian' && !!selectedObsidianVaultId && !!selectedObsidianPath,
    staleTime: 60000,
  });

  // ── Notion: read selected page blocks ────────────────────────────────────────
  const selectedNotionId = selected?.source.kind === 'notion' ? selected.id : null;

  const { data: notionBlocksData, isLoading: notionPageLoading, error: notionPageError } = useQuery({
    queryKey: ['notion-blocks', selectedNotionId],
    queryFn: () => api.notionBlockChildren(selected!.id, { page_size: 100 }),
    enabled: selected?.source.kind === 'notion' && !!selected.id,
    staleTime: 60000,
  });

  // ── Mutations ────────────────────────────────────────────────────────────────
  const writeMutation = useMutation({
    mutationFn: () => api.createOutboxItem({
      source: 'obsidian',
      recipient_id: selected!.id,
      recipient_name: selected!.id,
      content: JSON.stringify({
        action: 'write_file',
        path: selected!.id,
        content: editContent,
        vaultId: selectedObsidianVaultId,
      }),
    }),
    onSuccess: () => {
      toast({ title: 'Write queued for approval in Outbox' });
      setEditMode(false);
    },
    onError: (e) => toast({ title: e instanceof Error ? e.message : 'Failed to queue write' }),
  });

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleObsidianSelect = useCallback((vaultId: number, entry: VaultFileEntry) => {
    setSelected({ source: { kind: 'obsidian', vaultId }, id: entry.path, title: entry.name.replace(/\.md$/, '') });
    setEditMode(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  const handleNotionSelect = useCallback((result: NotionSearchResult) => {
    setSelected({ source: { kind: 'notion' }, id: result.id, title: getResultTitle(result) });
    setEditMode(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  const handleNotionChildrenLoaded = useCallback((parentId: string, children: NotionSearchResult[]) => {
    setNotionChildrenCache((prev) => {
      const next = new Map(prev);
      next.set(parentId, children);
      return next;
    });
  }, []);

  const handleWikilinkClick = useCallback((vaultId: number, target: string) => {
    // Fetch from query cache
    const cached = queryClient.getQueryData<{ files: VaultFileEntry[] }>(['obsidian-files', vaultId]);
    const allFiles = cached ? flattenFiles(cached.files, '') : [];
    const match = allFiles.find((f) => f.name.replace(/\.md$/, '').toLowerCase() === target.toLowerCase())
      || allFiles.find((f) => f.path.toLowerCase().includes(target.toLowerCase()));
    if (match) {
      handleObsidianSelect(vaultId, match);
    } else {
      toast({ title: `Note not found: ${target}` });
    }
  }, [queryClient, handleObsidianSelect]);

  const handleEdit = useCallback(() => {
    if (obsidianFileData?.content) {
      setEditContent(obsidianFileData.content);
      setEditMode(true);
    }
  }, [obsidianFileData]);

  const handleCancelEdit = useCallback(() => {
    setEditMode(false);
    setEditContent('');
  }, []);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    setEditMode(false);
  }, [selected?.id]);

  // ── Derived content ──────────────────────────────────────────────────────────

  const { meta, body: obsidianBody } = obsidianFileData?.content
    ? parseFrontmatter(obsidianFileData.content)
    : { meta: {} as Frontmatter, body: '' };

  const notionMarkdown = useMemo(() => {
    if (!notionBlocksData?.results) return '';
    return notionBlocksToMarkdown(notionBlocksData.results);
  }, [notionBlocksData]);

  const viewerTitle = selected
    ? (selected.source.kind === 'obsidian' ? (meta.title || selected.title) : selected.title)
    : '';

  const isFileLoading = selected?.source.kind === 'obsidian' ? obsidianFileLoading : notionPageLoading;
  const fileError = selected?.source.kind === 'obsidian' ? obsidianFileError : notionPageError;
  const hasContent = selected?.source.kind === 'obsidian' ? !!obsidianFileData : !!notionBlocksData;

  const selectedVaultName = selected?.source.kind === 'obsidian'
    ? vaults.find((v) => v.id === (selected.source as { kind: 'obsidian'; vaultId: number }).vaultId)?.name
    : undefined;

  // Notion top-level items
  const notionTopLevel = useMemo(() => {
    if (!notionSearchData?.results) return [];
    if (notionFilter) return notionSearchData.results;
    const workspaceRoot = notionSearchData.results.filter((r) => {
      const page = r as NotionPage;
      return page.parent?.type === 'workspace';
    });
    return workspaceRoot.length > 0 ? workspaceRoot : notionSearchData.results;
  }, [notionSearchData, notionFilter]);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left sidebar ──────────────────────────────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 flex flex-col border-r border-white/8 overflow-hidden bg-sidebar">

        {/* One collapsible section per vault */}
        {vaults.map((vault) => (
          <VaultSection
            key={vault.id}
            vault={vault}
            selectedItem={selected}
            onSelect={handleObsidianSelect}
            onWikilinkNavigate={(vaultId, target) => handleWikilinkClick(vaultId, target)}
          />
        ))}

        {/* Empty vault state */}
        {vaults.length === 0 && (
          <div className="px-4 py-4 border-b border-white/8 space-y-2">
            <div className="flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-semibold text-foreground">Obsidian Vaults</span>
            </div>
            <p className="text-xs text-muted-foreground">No vaults connected.</p>
            <a href="/settings/vault"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium border border-primary/20 hover:bg-primary/20 transition-colors">
              <Plus className="w-3 h-3" />
              Add a vault
            </a>
          </div>
        )}

        {/* ── Notion section ───────────────────────────────────────────────────── */}
        <SectionHeader
          open={notionOpen}
          onToggle={() => setNotionOpen(!notionOpen)}
          icon={<StickyNote className="w-3.5 h-3.5" />}
          label="Notion"
          meta={
            notionConnected && (
              <span className="flex items-center gap-0.5 ml-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
              </span>
            )
          }
          actions={
            notionConnected && (
              <button onClick={() => refetchNotion()}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors flex-shrink-0" title="Refresh Notion">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )
          }
        />

        {notionOpen && (
          <div className="flex flex-col flex-1 min-h-0">
            {!notionConnected ? (
              <div className="px-4 py-4 space-y-2">
                <p className="text-xs text-muted-foreground">Notion not connected.</p>
                <a href="/settings/connections"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium border border-primary/20 hover:bg-primary/20 transition-colors">
                  Connect Notion
                </a>
              </div>
            ) : (
              <>
                <div className="px-3 py-2 border-b border-white/5">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="Search Notion..."
                      value={notionFilter}
                      onChange={(e) => setNotionFilter(e.target.value)}
                      className="w-full bg-black/20 border border-white/8 rounded-lg pl-8 pr-7 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
                    />
                    {notionFilter && (
                      <button onClick={() => setNotionFilter('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                        <X className="w-3 h-3 text-muted-foreground" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto py-1 px-1 min-h-0">
                  {notionLoading && (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                    </div>
                  )}
                  {notionError && (
                    <div className="px-3 py-3 text-xs text-red-400 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>Failed to load pages</span>
                    </div>
                  )}
                  {!notionLoading && !notionError && notionTopLevel.length === 0 && (
                    <div className="px-3 py-3 text-xs text-muted-foreground text-center">No pages found</div>
                  )}
                  {notionTopLevel.map((result) => (
                    <NotionTreeNode
                      key={result.id}
                      result={result}
                      selectedId={selected?.source.kind === 'notion' ? selected.id : null}
                      onSelect={handleNotionSelect}
                      depth={0}
                      childrenCache={notionChildrenCache}
                      onChildrenLoaded={handleNotionChildrenLoaded}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </aside>

      {/* ── Content panel ───────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-3">
              <div className="flex items-center justify-center gap-3 opacity-40">
                <BookOpen className="w-8 h-8 text-purple-400" />
                <span className="text-warm-600 text-xl">+</span>
                <StickyNote className="w-8 h-8 text-warm-400" />
              </div>
              <p className="text-sm text-muted-foreground">Select a note or page to read it</p>
            </div>
          </div>
        ) : (
          <>
            {/* File header */}
            <div className="flex items-center gap-3 px-6 py-3 border-b border-white/8 flex-shrink-0">
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="text-base font-semibold text-foreground truncate">{viewerTitle}</h1>
                    <SourceBadge source={selected.source} vaultName={selectedVaultName} />
                  </div>
                  {selected.source.kind === 'obsidian' && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{selected.id}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {selected.source.kind === 'notion' && (
                  <a
                    href={`https://notion.so/${selected.id.replace(/-/g, '')}`}
                    target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
                    title="Open in Notion"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open
                  </a>
                )}
                {selected.source.kind === 'obsidian' && !editMode && obsidianFileData && (
                  <button onClick={handleEdit}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors">
                    <Edit2 className="w-3.5 h-3.5" />
                    Edit
                  </button>
                )}
                {selected.source.kind === 'obsidian' && editMode && (
                  <>
                    <button onClick={handleCancelEdit}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors">
                      <X className="w-3.5 h-3.5" />
                      Cancel
                    </button>
                    <button onClick={() => writeMutation.mutate()} disabled={writeMutation.isPending}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
                      {writeMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Queue Write
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Obsidian frontmatter metadata strip */}
            {selected.source.kind === 'obsidian' && !editMode && obsidianFileData && Object.keys(meta).length > 0 && (
              <div className="px-6 py-2 border-b border-white/5 flex flex-wrap gap-x-4 gap-y-1 flex-shrink-0">
                {meta.tags && Array.isArray(meta.tags) && meta.tags.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    {(meta.tags as string[]).map((tag) => (
                      <span key={tag} className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">#{tag}</span>
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
              {isFileLoading && (
                <div className="flex items-center justify-center h-32">
                  <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
                </div>
              )}
              {fileError && (
                <div className="px-6 py-8 flex items-center gap-3 text-red-400">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <span className="text-sm">{fileError instanceof Error ? fileError.message : 'Failed to load content'}</span>
                </div>
              )}

              {/* Obsidian: edit mode */}
              {selected.source.kind === 'obsidian' && hasContent && !isFileLoading && !fileError && editMode && (
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
              )}

              {/* Obsidian: read mode */}
              {selected.source.kind === 'obsidian' && hasContent && !isFileLoading && !fileError && !editMode && (
                <div className="px-8 py-6 max-w-3xl">
                  <MarkdownView content={obsidianBody}
                    onWikilinkClick={(target) => handleWikilinkClick((selected.source as { kind: 'obsidian'; vaultId: number }).vaultId, target)} />
                </div>
              )}

              {/* Notion: read mode */}
              {selected.source.kind === 'notion' && hasContent && !isFileLoading && !fileError && (
                <div className="px-8 py-6 max-w-3xl">
                  {notionMarkdown ? (
                    <MarkdownView content={notionMarkdown} />
                  ) : (
                    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                      <StickyNote className="w-8 h-8 text-warm-600" />
                      <p className="text-sm text-muted-foreground">This page has no text content.</p>
                      <a href={`https://notion.so/${selected.id.replace(/-/g, '')}`} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors">
                        <ExternalLink className="w-3.5 h-3.5" />
                        Open in Notion
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Empty state */}
              {!hasContent && !isFileLoading && !fileError && (
                <div className="flex items-center justify-center h-32">
                  <FileText className="w-6 h-6 text-warm-600" />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
