/**
 * Files — unified knowledge tree: multiple Obsidian vaults + Notion workspace
 *         + Google Drive folders + SMB network shares.
 *
 * Left sidebar: collapsible sections, one per source.
 *   Obsidian:     file tree, sync badge, search, edit support.
 *   Notion:       lazy-loading page/database tree.
 *   Google Drive: multi-folder tree with drag-and-drop upload.
 *   SMB:          directory tree with drag-and-drop upload.
 *
 * Right panel: unified viewer with per-source content rendering,
 *   download button, and file metadata.
 */

import {
  useState, useCallback, useRef, useEffect, useMemo, useId,
} from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen, Search,
  RefreshCw, Loader2, AlertCircle, Edit2, X, Send, BookOpen,
  Clock, GitBranch, Wifi, CheckCircle2, Database,
  StickyNote, ExternalLink, Plus, HardDrive, Network,
  Download, Upload, Lock, Eye, EyeOff, AlertTriangle,
  Image, Film, Music, FileCode, Archive, File,
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
  type DriveFileNode,
  type DriveFileContent,
  type GoogleDriveFolderConfig,
  type SmbShareRow,
  type SmbEntry,
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

type Source =
  | { kind: 'obsidian'; vaultId: number }
  | { kind: 'notion' }
  | { kind: 'gdrive'; folderId: number; folderName: string }
  | { kind: 'smb'; shareId: number; shareName: string };

interface SelectedItem {
  source: Source;
  /** Obsidian: relative file path. Notion: page ID. GDrive: file ID. SMB: relative path. */
  id: string;
  title: string;
  /** GDrive: mime type. SMB: undefined. */
  mimeType?: string;
  /** GDrive: web view link */
  webViewLink?: string | null;
  /** Whether the item is a folder (skip content load) */
  isFolder?: boolean;
}

// ── File-type icon helper ─────────────────────────────────────────────────────

function fileTypeIcon(name: string, mimeType?: string, className = 'w-3.5 h-3.5') {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const mime = mimeType ?? '';

  if (mime.startsWith('image/') || ['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext))
    return <Image className={cn(className, 'text-blue-400')} />;
  if (mime.startsWith('video/') || ['mp4','mov','mkv','avi','webm'].includes(ext))
    return <Film className={cn(className, 'text-purple-400')} />;
  if (mime.startsWith('audio/') || ['mp3','wav','ogg','flac','m4a'].includes(ext))
    return <Music className={cn(className, 'text-pink-400')} />;
  if (['zip','gz','tar','rar','7z','bz2'].includes(ext) || mime.includes('zip') || mime.includes('compressed'))
    return <Archive className={cn(className, 'text-amber-400')} />;
  if (['js','ts','tsx','jsx','py','go','rs','java','c','cpp','h','css','html','json','xml','sh','yml','yaml'].includes(ext) || mime.includes('json') || mime.includes('xml'))
    return <FileCode className={cn(className, 'text-emerald-400')} />;
  if (mime === 'application/pdf' || ext === 'pdf')
    return <FileText className={cn(className, 'text-red-400')} />;
  if (['md','txt'].includes(ext) || mime.startsWith('text/'))
    return <FileText className={cn(className, 'text-warm-400')} />;
  if (mime.startsWith('application/vnd.google-apps.'))
    return <File className={cn(className, 'text-blue-400')} />;
  return <File className={cn(className, 'text-muted-foreground')} />;
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

// ── Google Drive tree node ────────────────────────────────────────────────────

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
      <div>
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 w-full px-2 py-1 rounded-lg text-left text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <span className="flex-shrink-0">
            {open ? <FolderOpen className="w-3.5 h-3.5 text-amber-400" /> : <Folder className="w-3.5 h-3.5 text-amber-400" />}
          </span>
          <span className="flex-shrink-0">
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {open && node.children && (
          <div>
            {node.children.map((child) => (
              <GDriveFileNode key={child.fileId} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} filterQuery={filterQuery} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (filterQuery && !node.name.toLowerCase().includes(filterQuery.toLowerCase())) return null;

  const isSelected = selectedId === node.fileId;
  return (
    <button
      onClick={() => onSelect(node)}
      className={cn('flex items-center gap-1.5 w-full px-2 py-1.5 rounded-lg text-left text-xs transition-colors',
        isSelected ? 'bg-primary/15 text-primary' : 'text-sidebar-foreground hover:bg-white/5 hover:text-foreground')}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <span className="flex-shrink-0">{fileTypeIcon(node.name, node.mimeType, 'w-3.5 h-3.5')}</span>
      <span className="truncate flex-1">{node.name}</span>
      {node.warning && <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0 text-amber-500 ml-auto" />}
    </button>
  );
}

// ── SMB tree node (lazy-loading directory tree) ───────────────────────────────

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
      <div>
        <button
          onClick={handleOpen}
          className="flex items-center gap-1.5 w-full px-2 py-1 rounded-lg text-left text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <span className="flex-shrink-0">
            {open ? <FolderOpen className="w-3.5 h-3.5 text-amber-400" /> : <Folder className="w-3.5 h-3.5 text-amber-400" />}
          </span>
          <span className="flex-shrink-0">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" />
              : open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
          <span className="truncate font-medium">{entry.name}</span>
        </button>
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
      </div>
    );
  }

  if (filterQuery && !entry.name.toLowerCase().includes(filterQuery.toLowerCase())) return null;

  const isSelected = selectedId === entry.path;
  return (
    <button
      onClick={() => onSelect(entry)}
      className={cn('flex items-center gap-1.5 w-full px-2 py-1.5 rounded-lg text-left text-xs transition-colors',
        isSelected ? 'bg-primary/15 text-primary' : 'text-sidebar-foreground hover:bg-white/5 hover:text-foreground')}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <span className="flex-shrink-0">{fileTypeIcon(entry.name, undefined, 'w-3.5 h-3.5')}</span>
      <span className="truncate flex-1">{entry.name}</span>
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

// ── Image viewer ──────────────────────────────────────────────────────────────

function ImageViewer({ src, alt }: { src: string; alt: string }) {
  const [error, setError] = useState(false);
  if (error) return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <Image className="w-8 h-8 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">Failed to load image preview</p>
    </div>
  );
  return (
    <div className="flex items-center justify-center p-6">
      <img src={src} alt={alt} onError={() => setError(true)}
        className="max-w-full max-h-[70vh] rounded-lg object-contain border border-white/10" />
    </div>
  );
}

// ── Cannot-preview state ──────────────────────────────────────────────────────

function CannotPreview({ name, mimeType, onDownload }: { name: string; mimeType?: string; onDownload: () => void }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
      <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10">
        {fileTypeIcon(name, mimeType, 'w-7 h-7')}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{name}</p>
        {mimeType && <p className="text-xs text-muted-foreground">{mimeType}</p>}
        {ext && <p className="text-xs text-muted-foreground uppercase">{ext} file</p>}
      </div>
      <p className="text-xs text-muted-foreground max-w-xs">
        This file type cannot be previewed in the browser. Download it to open with your local application.
      </p>
      <button onClick={onDownload}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors">
        <Download className="w-3.5 h-3.5" />
        Download File
      </button>
    </div>
  );
}

// ── Drag-and-drop upload zone ─────────────────────────────────────────────────

interface DropZoneProps {
  onFiles: (files: File[]) => void;
  uploading: boolean;
  children: React.ReactNode;
  className?: string;
}

function DropZone({ onFiles, uploading, children, className }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const counter = useRef(0);

  return (
    <div
      className={cn('relative', className)}
      onDragEnter={(e) => { e.preventDefault(); counter.current++; setDragging(true); }}
      onDragLeave={() => { counter.current--; if (counter.current === 0) setDragging(false); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        counter.current = 0;
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }}
    >
      {children}
      {(dragging || uploading) && (
        <div className="absolute inset-0 rounded-lg border-2 border-dashed border-primary/60 bg-primary/5 backdrop-blur-sm flex items-center justify-center z-20 pointer-events-none">
          {uploading ? (
            <div className="flex items-center gap-2 text-primary text-sm font-medium">
              <Loader2 className="w-4 h-4 animate-spin" />
              Uploading...
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-primary text-sm font-medium">
              <Upload className="w-6 h-6" />
              Drop to upload
            </div>
          )}
        </div>
      )}
    </div>
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

function SourceBadge({ source }: { source: Source }) {
  if (source.kind === 'obsidian') {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 text-[10px] font-medium border border-purple-500/20">
        <BookOpen className="w-2.5 h-2.5" />
        Obsidian
      </span>
    );
  }
  if (source.kind === 'notion') {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-warm-500/15 text-warm-300 text-[10px] font-medium border border-warm-500/20">
        <StickyNote className="w-2.5 h-2.5" />
        Notion
      </span>
    );
  }
  if (source.kind === 'gdrive') {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 text-[10px] font-medium border border-blue-500/20">
        <HardDrive className="w-2.5 h-2.5" />
        {source.folderName}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-medium border border-emerald-500/20">
      <Network className="w-2.5 h-2.5" />
      {source.shareName}
    </span>
  );
}

// ── Per-vault sidebar section ─────────────────────────────────────────────────

interface VaultSectionProps {
  vault: ObsidianVaultConfigRow;
  selectedItem: SelectedItem | null;
  onSelect: (vaultId: number, entry: VaultFileEntry) => void;
  onWikilinkNavigate: (vaultId: number, target: string, allFiles: VaultFileEntry[]) => void;
  open: boolean;
  onToggle: () => void;
}

function VaultSection({ vault, selectedItem, onSelect, open, onToggle }: VaultSectionProps) {
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
    <div className={cn('flex flex-col border-b border-white/8', open ? 'flex-1 min-h-0' : 'flex-shrink-0')}>
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
              <a href="/settings/files"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium border border-primary/20 hover:bg-primary/20 transition-colors">
                Set up Vault
              </a>
            </div>
          ) : (
            <>
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

// ── Google Drive sidebar section ──────────────────────────────────────────────

interface GDriveSectionProps {
  folder: GoogleDriveFolderConfig;
  selectedItem: SelectedItem | null;
  onSelect: (folderId: number, folderName: string, node: DriveFileNode) => void;
  onUpload: (folderId: number, files: File[], parentFolderId?: string) => void;
  uploading: boolean;
  open: boolean;
  onToggle: () => void;
}

function GDriveSection({ folder, selectedItem, onSelect, onUpload, uploading, open, onToggle }: GDriveSectionProps) {
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
    <div className={cn('flex flex-col border-b border-white/8', open ? 'flex-1 min-h-0' : 'flex-shrink-0')}>
      <SectionHeader
        open={open}
        onToggle={onToggle}
        icon={<HardDrive className="w-3.5 h-3.5" />}
        label={folder.folderName}
        meta={<span className={cn('w-1.5 h-1.5 rounded-full ml-1 flex-shrink-0', statusColor)} />}
        actions={
          <div className="flex items-center gap-0.5">
            {/* Upload button */}
            <label htmlFor={fileInputId} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer" title="Upload file">
              <Upload className="w-3.5 h-3.5" />
            </label>
            <input id={fileInputId} type="file" multiple className="sr-only"
              onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) onUpload(folder.id, f); e.target.value = ''; }} />
            <button onClick={() => refetch()} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors flex-shrink-0" title="Refresh">
              <RefreshCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} />
            </button>
          </div>
        }
      />

      {open && (
        <DropZone onFiles={(f) => onUpload(folder.id, f)} uploading={uploading} className="flex flex-col min-h-0 flex-1">
          <div className="px-3 py-2 border-b border-white/5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search files..."
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
          <div className="flex-1 overflow-y-auto py-1 px-1 min-h-0">
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
            <div className="px-3 py-1.5 flex items-center gap-1.5 border-t border-white/5">
              <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
              <span className="text-[10px] text-muted-foreground">Synced {timeAgo(folder.lastSyncedAt)}</span>
            </div>
          )}
        </DropZone>
      )}
    </div>
  );
}

// ── SMB sidebar section ───────────────────────────────────────────────────────

interface SmbSectionProps {
  share: SmbShareRow;
  selectedItem: SelectedItem | null;
  onSelect: (shareId: number, shareName: string, entry: SmbEntry) => void;
  onUpload: (shareId: number, files: File[], dirPath?: string) => void;
  uploading: boolean;
  open: boolean;
  onToggle: () => void;
}

function SmbSection({ share, selectedItem, onSelect, onUpload, uploading, open, onToggle }: SmbSectionProps) {
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
    <div className={cn('flex flex-col border-b border-white/8', open ? 'flex-1 min-h-0' : 'flex-shrink-0')}>
      <SectionHeader
        open={open}
        onToggle={onToggle}
        icon={<Network className="w-3.5 h-3.5" />}
        label={share.name}
        meta={<span className={cn('w-1.5 h-1.5 rounded-full ml-1 flex-shrink-0', statusDot)} />}
        actions={
          isConnected && (
            <div className="flex items-center gap-0.5">
              <label htmlFor={fileInputId} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer" title="Upload file">
                <Upload className="w-3.5 h-3.5" />
              </label>
              <input id={fileInputId} type="file" multiple className="sr-only"
                onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) onUpload(share.id, f); e.target.value = ''; }} />
              <button onClick={loadRoot} disabled={rootLoading} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors flex-shrink-0" title="Refresh">
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
              <a href="/settings/connections"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium border border-primary/20 hover:bg-primary/20 transition-colors">
                Connect Share
              </a>
            </div>
          ) : (
            <DropZone onFiles={(f) => onUpload(share.id, f)} uploading={uploading} className="flex flex-col min-h-0 flex-1">
              <div className="px-3 py-2 border-b border-white/5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="Filter files..."
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
              <div className="flex-1 overflow-y-auto py-1 px-1 min-h-0">
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

// ── Determine if a file can be previewed ──────────────────────────────────────

function canPreviewFile(name: string, mimeType?: string): 'markdown' | 'text' | 'image' | 'csv' | 'none' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const mime = mimeType ?? '';

  if (ext === 'md' || mime === 'text/markdown') return 'markdown';
  if (mime.startsWith('image/') || ['png','jpg','jpeg','gif','webp','svg','bmp'].includes(ext)) return 'image';
  if (ext === 'csv' || mime === 'text/csv') return 'csv';
  if (
    mime.startsWith('text/') ||
    ['txt','json','xml','yaml','yml','toml','sh','bash','zsh','py','js','ts','jsx','tsx',
      'go','rs','java','c','cpp','h','hpp','cs','php','rb','swift','kt','scala','html',
      'css','scss','less','ini','cfg','conf','log'].includes(ext) ||
    mime === 'application/json' || mime === 'application/xml' ||
    mime.startsWith('application/vnd.google-apps.')
  ) return 'text';
  if (['mp4','mov','mkv','avi','webm'].includes(ext) || mime.startsWith('video/')) return 'none';
  if (['mp3','wav','ogg','flac','m4a'].includes(ext) || mime.startsWith('audio/')) return 'none';
  if (ext === 'pdf' || mime === 'application/pdf') return 'none';
  if (['zip','gz','tar','rar','7z','bz2'].includes(ext)) return 'none';
  return 'none';
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ObsidianVault() {
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  // Upload state per source
  const [gdriveUploading, setGdriveUploading] = useState<Record<number, boolean>>({});
  const [smbUploading, setSmbUploading] = useState<Record<number, boolean>>({});

  // Accordion state: only one section open at a time; null = all collapsed
  // Section IDs: `vault-{id}`, `gdrive-{id}`, `smb-{id}`, `notion`
  const [openSectionId, setOpenSectionId] = useState<string | null>(null);

  const toggleSection = useCallback((id: string) => {
    setOpenSectionId((prev) => (prev === id ? null : id));
  }, []);
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

  // ── Google Drive folders ─────────────────────────────────────────────────────
  const { data: gdriveFoldersData } = useQuery({
    queryKey: ['gdrive-folders'],
    queryFn: () => api.listGdriveFolders(),
    staleTime: 30000,
  });
  const gdriveFolders = gdriveFoldersData?.folders ?? [];

  // ── SMB shares ───────────────────────────────────────────────────────────────
  const { data: smbSharesData } = useQuery({
    queryKey: ['smb-shares'],
    queryFn: () => api.listSmbShares(),
    staleTime: 30000,
  });
  const smbShares = smbSharesData?.shares ?? [];

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

  // ── Google Drive: read selected file ─────────────────────────────────────────
  const selectedGdriveFolderId = selected?.source.kind === 'gdrive' ? selected.source.folderId : null;
  const selectedGdriveFileId = selected?.source.kind === 'gdrive' && !selected.isFolder ? selected.id : null;

  const { data: gdriveFileData, isLoading: gdriveFileLoading, error: gdriveFileError } = useQuery({
    queryKey: ['gdrive-file-content', selectedGdriveFolderId, selectedGdriveFileId],
    queryFn: () => api.gdriveReadFile(selectedGdriveFolderId!, selectedGdriveFileId!),
    enabled: !!selectedGdriveFolderId && !!selectedGdriveFileId,
    staleTime: 5 * 60 * 1000,
  });

  // ── SMB: read selected file ───────────────────────────────────────────────────
  const selectedSmbShareId = selected?.source.kind === 'smb' ? selected.source.shareId : null;
  const selectedSmbPath = selected?.source.kind === 'smb' && !selected.isFolder ? selected.id : null;

  const { data: smbFileData, isLoading: smbFileLoading, error: smbFileError } = useQuery({
    queryKey: ['smb-file-content', selectedSmbShareId, selectedSmbPath],
    queryFn: async () => {
      // Use raw fetch since SMB read file returns text/plain or binary
      const res = await fetch(`/api/smb/shares/${selectedSmbShareId}/files/${selectedSmbPath!.split('/').map(encodeURIComponent).join('/')}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error: string }).error || `HTTP ${res.status}`);
      }
      return res.text();
    },
    enabled: !!selectedSmbShareId && !!selectedSmbPath,
    staleTime: 5 * 60 * 1000,
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

  // ── Download handler ─────────────────────────────────────────────────────────

  const handleDownload = useCallback(() => {
    if (!selected) return;
    let url: string;
    let fileName: string;

    if (selected.source.kind === 'gdrive') {
      url = api.gdriveDownloadUrl(selected.source.folderId, selected.id);
      fileName = selected.title;
    } else if (selected.source.kind === 'smb') {
      url = api.smbDownloadUrl(selected.source.shareId, selected.id);
      fileName = selected.title;
    } else {
      return;
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [selected]);

  // ── Upload handlers ──────────────────────────────────────────────────────────

  const handleGdriveUpload = useCallback(async (folderId: number, files: File[], parentFolderId?: string) => {
    setGdriveUploading((prev) => ({ ...prev, [folderId]: true }));
    let successCount = 0;
    let failCount = 0;
    for (const file of files) {
      try {
        await api.gdriveUploadFile(folderId, file, parentFolderId);
        successCount++;
      } catch (e) {
        failCount++;
        toast({ title: `Failed to upload ${file.name}`, description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
      }
    }
    setGdriveUploading((prev) => ({ ...prev, [folderId]: false }));
    if (successCount > 0) {
      toast({ title: `Uploaded ${successCount} file${successCount > 1 ? 's' : ''} to Google Drive`, variant: 'success' });
      queryClient.invalidateQueries({ queryKey: ['gdrive-tree-files', folderId] });
    }
    if (failCount > 0 && successCount === 0) {
      toast({ title: `${failCount} upload${failCount > 1 ? 's' : ''} failed`, variant: 'destructive' });
    }
  }, [queryClient]);

  const handleSmbUpload = useCallback(async (shareId: number, files: File[], dirPath = '') => {
    setSmbUploading((prev) => ({ ...prev, [shareId]: true }));
    let successCount = 0;
    let failCount = 0;
    for (const file of files) {
      try {
        await api.uploadSmbFile(shareId, file, dirPath);
        successCount++;
      } catch (e) {
        failCount++;
        toast({ title: `Failed to upload ${file.name}`, description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
      }
    }
    setSmbUploading((prev) => ({ ...prev, [shareId]: false }));
    if (successCount > 0) {
      toast({ title: `Uploaded ${successCount} file${successCount > 1 ? 's' : ''} to SMB share`, variant: 'success' });
    }
    if (failCount > 0 && successCount === 0) {
      toast({ title: `${failCount} upload${failCount > 1 ? 's' : ''} failed`, variant: 'destructive' });
    }
  }, []);

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

  const handleGdriveSelect = useCallback((folderId: number, folderName: string, node: DriveFileNode) => {
    setSelected({
      source: { kind: 'gdrive', folderId, folderName },
      id: node.fileId,
      title: node.name,
      mimeType: node.mimeType,
      webViewLink: node.webViewLink,
      isFolder: node.isFolder,
    });
    setEditMode(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  const handleSmbSelect = useCallback((shareId: number, shareName: string, entry: SmbEntry) => {
    setSelected({
      source: { kind: 'smb', shareId, shareName },
      id: entry.path,
      title: entry.name,
      isFolder: entry.type === 'directory',
    });
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

  const notionTopLevel = useMemo(() => {
    if (!notionSearchData?.results) return [];
    if (notionFilter) return notionSearchData.results;
    const workspaceRoot = notionSearchData.results.filter((r) => {
      const page = r as NotionPage;
      return page.parent?.type === 'workspace';
    });
    return workspaceRoot.length > 0 ? workspaceRoot : notionSearchData.results;
  }, [notionSearchData, notionFilter]);

  // Determine viewer title
  const viewerTitle = selected?.title ?? '';

  // Determine loading/error/content state
  type ContentKind = 'obsidian' | 'notion' | 'gdrive' | 'smb';
  const contentKind: ContentKind | null = selected
    ? (selected.source.kind === 'obsidian' ? 'obsidian'
      : selected.source.kind === 'notion' ? 'notion'
      : selected.source.kind === 'gdrive' ? 'gdrive'
      : 'smb')
    : null;

  const isFileLoading = contentKind === 'obsidian' ? obsidianFileLoading
    : contentKind === 'notion' ? notionPageLoading
    : contentKind === 'gdrive' ? gdriveFileLoading
    : contentKind === 'smb' ? smbFileLoading
    : false;

  const fileError = contentKind === 'obsidian' ? obsidianFileError
    : contentKind === 'notion' ? notionPageError
    : contentKind === 'gdrive' ? gdriveFileError
    : contentKind === 'smb' ? smbFileError
    : null;

  // Determine file preview mode for GDrive and SMB
  const gdrivePreviewMode = gdriveFileData
    ? canPreviewFile(gdriveFileData.fileName, gdriveFileData.mimeType)
    : 'none';
  const smbPreviewMode = selected?.source.kind === 'smb'
    ? canPreviewFile(selected.title, selected.mimeType)
    : 'none';

  // ── Render ───────────────────────────────────────────────────────────────────

  const hasAnySources = vaults.length > 0 || gdriveFolders.length > 0 || smbShares.length > 0;

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left sidebar ──────────────────────────────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 flex flex-col border-r border-white/8 overflow-hidden bg-sidebar">

        {/* Obsidian vaults */}
        {vaults.map((vault) => (
          <VaultSection
            key={vault.id}
            vault={vault}
            selectedItem={selected}
            onSelect={handleObsidianSelect}
            onWikilinkNavigate={(vaultId, target) => handleWikilinkClick(vaultId, target)}
            open={openSectionId === `vault-${vault.id}`}
            onToggle={() => toggleSection(`vault-${vault.id}`)}
          />
        ))}

        {/* Empty Obsidian state */}
        {vaults.length === 0 && (
          <div className="px-4 py-4 border-b border-white/8 space-y-2 flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-semibold text-foreground">Obsidian Vaults</span>
            </div>
            <p className="text-xs text-muted-foreground">No vaults connected.</p>
            <a href="/settings/files"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium border border-primary/20 hover:bg-primary/20 transition-colors">
              <Plus className="w-3 h-3" />
              Add a vault
            </a>
          </div>
        )}

        {/* Google Drive folders */}
        {gdriveFolders.map((folder) => (
          <GDriveSection
            key={folder.id}
            folder={folder}
            selectedItem={selected}
            onSelect={handleGdriveSelect}
            onUpload={handleGdriveUpload}
            uploading={gdriveUploading[folder.id] ?? false}
            open={openSectionId === `gdrive-${folder.id}`}
            onToggle={() => toggleSection(`gdrive-${folder.id}`)}
          />
        ))}

        {/* SMB shares */}
        {smbShares.map((share) => (
          <SmbSection
            key={share.id}
            share={share}
            selectedItem={selected}
            onSelect={handleSmbSelect}
            onUpload={handleSmbUpload}
            uploading={smbUploading[share.id] ?? false}
            open={openSectionId === `smb-${share.id}`}
            onToggle={() => toggleSection(`smb-${share.id}`)}
          />
        ))}

        {/* ── Notion section ───────────────────────────────────────────────────── */}
        <div className={cn('flex flex-col border-b border-white/8', openSectionId === 'notion' ? 'flex-1 min-h-0' : 'flex-shrink-0')}>
          <SectionHeader
            open={openSectionId === 'notion'}
            onToggle={() => toggleSection('notion')}
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

          {openSectionId === 'notion' && (
            <div className="flex flex-col min-h-0 flex-1">
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
        </div>

        {/* All-empty state */}
        {!hasAnySources && !notionConnected && (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center space-y-2">
              <p className="text-xs text-muted-foreground">No file sources configured.</p>
              <a href="/settings/files" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <Plus className="w-3 h-3" />
                Add sources
              </a>
            </div>
          </div>
        )}
      </aside>

      {/* ── Content panel ───────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-3">
              <div className="flex items-center justify-center gap-3 opacity-40">
                <BookOpen className="w-7 h-7 text-purple-400" />
                <span className="text-warm-600 text-lg">+</span>
                <StickyNote className="w-7 h-7 text-warm-400" />
                <span className="text-warm-600 text-lg">+</span>
                <HardDrive className="w-7 h-7 text-blue-400" />
                <span className="text-warm-600 text-lg">+</span>
                <Network className="w-7 h-7 text-emerald-400" />
              </div>
              <p className="text-sm text-muted-foreground">Select a file to view it</p>
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
                    <SourceBadge source={selected.source} />
                  </div>
                  {selected.source.kind === 'obsidian' && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{selected.id}</p>
                  )}
                  {selected.source.kind === 'smb' && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{selected.id}</p>
                  )}
                  {/* GDrive permission badge */}
                  {selected.source.kind === 'gdrive' && gdriveFileData && (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {gdriveFileData.editability === 'read-only'
                        ? <span className="flex items-center gap-1 text-[10px] text-amber-400"><Lock className="w-2.5 h-2.5" />Read-only</span>
                        : gdriveFileData.editability === 'find-replace'
                        ? <span className="flex items-center gap-1 text-[10px] text-blue-400"><Eye className="w-2.5 h-2.5" />Find/replace editing</span>
                        : <span className="flex items-center gap-1 text-[10px] text-emerald-400"><EyeOff className="w-2.5 h-2.5" />Direct edit</span>}
                      {gdriveFileData.warning && (
                        <span className="flex items-center gap-1 text-[10px] text-amber-400">
                          <AlertTriangle className="w-2.5 h-2.5" />
                          {gdriveFileData.warning}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Notion: open in Notion */}
                {selected.source.kind === 'notion' && (
                  <a
                    href={`https://notion.so/${selected.id.replace(/-/g, '')}`}
                    target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open
                  </a>
                )}
                {/* GDrive: open in Drive + download */}
                {selected.source.kind === 'gdrive' && !selected.isFolder && (
                  <>
                    {selected.webViewLink && (
                      <a href={selected.webViewLink} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors">
                        <ExternalLink className="w-3.5 h-3.5" />
                        Open
                      </a>
                    )}
                    <button onClick={handleDownload}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors">
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </button>
                  </>
                )}
                {/* SMB: download */}
                {selected.source.kind === 'smb' && !selected.isFolder && (
                  <button onClick={handleDownload}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors">
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                )}
                {/* Obsidian: edit */}
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
              {isFileLoading && !selected.isFolder && (
                <div className="flex items-center justify-center h-32">
                  <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
                </div>
              )}
              {fileError && !selected.isFolder && (
                <div className="px-6 py-8 flex items-center gap-3 text-red-400">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <span className="text-sm">{fileError instanceof Error ? fileError.message : 'Failed to load content'}</span>
                </div>
              )}

              {/* Folder selected — show info */}
              {selected.isFolder && (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                  <FolderOpen className="w-10 h-10 text-amber-400/60" />
                  <p className="text-sm text-muted-foreground">Select a file to view its contents</p>
                </div>
              )}

              {/* Obsidian: edit mode */}
              {selected.source.kind === 'obsidian' && obsidianFileData && !isFileLoading && !fileError && editMode && (
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
              {selected.source.kind === 'obsidian' && obsidianFileData && !isFileLoading && !fileError && !editMode && (
                <div className="px-8 py-6 max-w-3xl">
                  <MarkdownView content={obsidianBody}
                    onWikilinkClick={(target) => handleWikilinkClick((selected.source as { kind: 'obsidian'; vaultId: number }).vaultId, target)} />
                </div>
              )}

              {/* Notion: read mode */}
              {selected.source.kind === 'notion' && notionBlocksData && !isFileLoading && !fileError && (
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

              {/* Google Drive: content viewer */}
              {selected.source.kind === 'gdrive' && !selected.isFolder && gdriveFileData && !isFileLoading && !fileError && (
                <>
                  {gdrivePreviewMode === 'markdown' && (
                    <div className="px-8 py-6 max-w-3xl">
                      <MarkdownView content={gdriveFileData.content} />
                    </div>
                  )}
                  {gdrivePreviewMode === 'text' && (
                    <div className="px-8 py-6 max-w-4xl">
                      <pre className="text-sm text-foreground/90 font-mono leading-relaxed whitespace-pre-wrap break-words">{gdriveFileData.content}</pre>
                    </div>
                  )}
                  {gdrivePreviewMode === 'csv' && (
                    <div className="px-8 py-6 overflow-x-auto">
                      <CsvViewer content={gdriveFileData.content} />
                    </div>
                  )}
                  {gdrivePreviewMode === 'image' && (
                    <ImageViewer
                      src={api.gdriveDownloadUrl((selected.source as { kind: 'gdrive'; folderId: number }).folderId, selected.id)}
                      alt={selected.title}
                    />
                  )}
                  {gdrivePreviewMode === 'none' && (
                    <CannotPreview name={selected.title} mimeType={selected.mimeType} onDownload={handleDownload} />
                  )}
                </>
              )}

              {/* SMB: content viewer */}
              {selected.source.kind === 'smb' && !selected.isFolder && smbFileData !== undefined && !isFileLoading && !fileError && (
                <>
                  {smbPreviewMode === 'markdown' && (
                    <div className="px-8 py-6 max-w-3xl">
                      <MarkdownView content={smbFileData} />
                    </div>
                  )}
                  {smbPreviewMode === 'text' && (
                    <div className="px-8 py-6 max-w-4xl">
                      <pre className="text-sm text-foreground/90 font-mono leading-relaxed whitespace-pre-wrap break-words">{smbFileData}</pre>
                    </div>
                  )}
                  {smbPreviewMode === 'csv' && (
                    <div className="px-8 py-6 overflow-x-auto">
                      <CsvViewer content={smbFileData} />
                    </div>
                  )}
                  {smbPreviewMode === 'image' && (
                    <ImageViewer
                      src={api.smbDownloadUrl((selected.source as { kind: 'smb'; shareId: number }).shareId, selected.id)}
                      alt={selected.title}
                    />
                  )}
                  {smbPreviewMode === 'none' && (
                    <CannotPreview name={selected.title} mimeType={selected.mimeType} onDownload={handleDownload} />
                  )}
                </>
              )}

              {/* Empty state */}
              {!isFileLoading && !fileError && !selected.isFolder &&
                contentKind === 'obsidian' && !obsidianFileData && (
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

// ── CSV viewer ────────────────────────────────────────────────────────────────

function CsvViewer({ content }: { content: string }) {
  const rows = useMemo(() => {
    const lines = content.trim().split('\n');
    return lines.map((line) => {
      // Simple CSV parse (doesn't handle quoted commas, but good enough for preview)
      const cells: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
          cells.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      cells.push(current);
      return cells;
    });
  }, [content]);

  if (rows.length === 0) return <p className="text-xs text-muted-foreground">Empty CSV</p>;
  const headers = rows[0] ?? [];
  const dataRows = rows.slice(1);

  return (
    <div className="rounded-xl border border-white/10 overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-white/5">
            {headers.map((h, i) => (
              <th key={i} className="text-left px-3 py-2 border border-white/10 font-semibold text-foreground/80 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, ri) => (
            <tr key={ri} className="odd:bg-white/2 hover:bg-white/5 transition-colors">
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-1.5 border border-white/5 text-foreground/80 whitespace-nowrap">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-white/5">
        {dataRows.length} row{dataRows.length !== 1 ? 's' : ''} · {headers.length} column{headers.length !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
