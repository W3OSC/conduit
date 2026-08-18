/**
 * Unified file viewer pane.
 *
 * Owns the viewer header (title, source badge, per-source actions), the
 * Obsidian frontmatter strip, the Obsidian editor, and every content renderer
 * (markdown, plain text, CSV, image, cannot-preview).
 */

import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  FileText, FolderOpen, Loader2, AlertCircle, Edit2, X, Send, BookOpen,
  Clock, StickyNote, ExternalLink, HardDrive, Network, Download, Lock, Eye, EyeOff,
  AlertTriangle, Image,
} from 'lucide-react';
import {
  api,
  type DriveFileContent,
  type NotionBlockChildrenResponse,
} from '@/lib/api';
import { notionBlocksToMarkdown } from '@/lib/notionUtils';
import { cn } from '@/lib/utils';
import { type Source, type SelectedItem, fileTypeIcon } from './shared';

// ── Wikilink transform ────────────────────────────────────────────────────────

function transformWikilinks(markdown: string): string {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, inner) => {
    const parts = inner.split('|');
    const target = parts[0].trim();
    const alias = parts[1]?.trim() || target;
    return `[${alias}](wikilink://${encodeURIComponent(target)})`;
  });
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

export function MarkdownView({ content, onWikilinkClick }: MarkdownViewProps) {
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
            <pre className="bg-muted rounded-lg p-4 my-3 overflow-x-auto text-xs font-mono border border-border">
              <code className="text-emerald-500">{children}</code>
            </pre>
          );
          return <code className="bg-muted text-primary/80 px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>;
        },
        hr: () => <hr className="border-border my-6" />,
        table: ({ children }) => <div className="overflow-x-auto my-4"><table className="w-full text-sm border-collapse">{children}</table></div>,
        th: ({ children }) => <th className="text-left px-3 py-2 border border-border bg-secondary/40 font-medium text-foreground">{children}</th>,
        td: ({ children }) => <td className="px-3 py-2 border border-border text-foreground/80">{children}</td>,
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
        className="max-w-full max-h-[70vh] rounded-lg object-contain border border-border" />
    </div>
  );
}

// ── Cannot-preview state ──────────────────────────────────────────────────────

function CannotPreview({ name, mimeType, onDownload }: { name: string; mimeType?: string; onDownload: () => void }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
      <div className="w-14 h-14 rounded-2xl bg-secondary/40 flex items-center justify-center border border-border">
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
    <div className="rounded-xl border border-border overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-secondary/40">
            {headers.map((h, i) => (
              <th key={i} className="text-left px-3 py-2 border border-border font-semibold text-foreground/80 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, ri) => (
            <tr key={ri} className="odd:bg-secondary/20 hover:bg-secondary/60 transition-colors">
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-1.5 border border-border/60 text-foreground/80 whitespace-nowrap">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border/60">
        {dataRows.length} row{dataRows.length !== 1 ? 's' : ''} · {headers.length} column{headers.length !== 1 ? 's' : ''}
      </p>
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
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-secondary text-foreground text-[10px] font-medium border border-border">
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

// ── Preview-mode detection ────────────────────────────────────────────────────

export function canPreviewFile(name: string, mimeType?: string): 'markdown' | 'text' | 'image' | 'csv' | 'none' {
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

// ── Viewer ────────────────────────────────────────────────────────────────────

/** Outline action button shared by the viewer header controls. */
const viewerActionClass =
  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors';

export interface FileViewerProps {
  selected: SelectedItem | null;
  contentRef: React.RefObject<HTMLDivElement | null>;
  isFileLoading: boolean;
  fileError: Error | null;
  obsidianFileData: { path: string; content: string } | undefined;
  notionBlocksData: NotionBlockChildrenResponse | undefined;
  gdriveFileData: DriveFileContent | undefined;
  smbFileData: string | undefined;
  editMode: boolean;
  editContent: string;
  onEditContentChange: (value: string) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onQueueWrite: () => void;
  writePending: boolean;
  onDownload: () => void;
  onWikilinkClick: (vaultId: number, target: string) => void;
}

export function FileViewer({
  selected,
  contentRef,
  isFileLoading,
  fileError,
  obsidianFileData,
  notionBlocksData,
  gdriveFileData,
  smbFileData,
  editMode,
  editContent,
  onEditContentChange,
  onEdit,
  onCancelEdit,
  onQueueWrite,
  writePending,
  onDownload,
  onWikilinkClick,
}: FileViewerProps) {
  const { meta, body: obsidianBody } = obsidianFileData?.content
    ? parseFrontmatter(obsidianFileData.content)
    : { meta: {} as Frontmatter, body: '' };

  const notionMarkdown = useMemo(() => {
    if (!notionBlocksData?.results) return '';
    return notionBlocksToMarkdown(notionBlocksData.results);
  }, [notionBlocksData]);

  const viewerTitle = selected?.title ?? '';

  const gdrivePreviewMode = gdriveFileData
    ? canPreviewFile(gdriveFileData.fileName, gdriveFileData.mimeType)
    : 'none';
  const smbPreviewMode = selected?.source.kind === 'smb'
    ? canPreviewFile(selected.title, selected.mimeType)
    : 'none';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {!selected ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="flex items-center justify-center gap-3 opacity-40">
              <BookOpen className="w-7 h-7 text-purple-400" />
              <span className="text-muted-foreground text-lg">+</span>
              <StickyNote className="w-7 h-7 text-muted-foreground" />
              <span className="text-muted-foreground text-lg">+</span>
              <HardDrive className="w-7 h-7 text-blue-400" />
              <span className="text-muted-foreground text-lg">+</span>
              <Network className="w-7 h-7 text-emerald-400" />
            </div>
            <p className="text-sm text-muted-foreground">Select a file to view it</p>
          </div>
        </div>
      ) : (
        <>
          {/* File header */}
          <div className="flex items-center gap-3 px-6 py-3 border-b border-border flex-shrink-0">
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
                  className={viewerActionClass}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open
                </a>
              )}
              {/* GDrive: open in Drive + download */}
              {selected.source.kind === 'gdrive' && !selected.isFolder && (
                <>
                  {selected.webViewLink && (
                    <a href={selected.webViewLink} target="_blank" rel="noopener noreferrer" className={viewerActionClass}>
                      <ExternalLink className="w-3.5 h-3.5" />
                      Open
                    </a>
                  )}
                  <button onClick={onDownload} className={viewerActionClass}>
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                </>
              )}
              {/* SMB: download */}
              {selected.source.kind === 'smb' && !selected.isFolder && (
                <button onClick={onDownload} className={viewerActionClass}>
                  <Download className="w-3.5 h-3.5" />
                  Download
                </button>
              )}
              {/* Obsidian: edit */}
              {selected.source.kind === 'obsidian' && !editMode && obsidianFileData && (
                <button onClick={onEdit} className={viewerActionClass}>
                  <Edit2 className="w-3.5 h-3.5" />
                  Edit
                </button>
              )}
              {selected.source.kind === 'obsidian' && editMode && (
                <>
                  <button onClick={onCancelEdit} className={viewerActionClass}>
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                  <button onClick={onQueueWrite} disabled={writePending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
                    {writePending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    Queue Write
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Obsidian frontmatter metadata strip */}
          {selected.source.kind === 'obsidian' && !editMode && obsidianFileData && Object.keys(meta).length > 0 && (
            <div className="px-6 py-2 border-b border-border/60 flex flex-wrap gap-x-4 gap-y-1 flex-shrink-0">
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
                  onChange={(e) => onEditContentChange(e.target.value)}
                  className="flex-1 w-full bg-secondary/40 border border-border rounded-xl p-4 text-sm font-mono text-foreground focus:outline-none focus:border-primary/40 resize-none leading-relaxed"
                  spellCheck={false}
                />
              </div>
            )}

            {/* Obsidian: read mode */}
            {selected.source.kind === 'obsidian' && obsidianFileData && !isFileLoading && !fileError && !editMode && (
              <div className="px-8 py-6 max-w-3xl">
                <MarkdownView content={obsidianBody}
                  onWikilinkClick={(target) => onWikilinkClick((selected.source as { kind: 'obsidian'; vaultId: number }).vaultId, target)} />
              </div>
            )}

            {/* Notion: read mode */}
            {selected.source.kind === 'notion' && notionBlocksData && !isFileLoading && !fileError && (
              <div className="px-8 py-6 max-w-3xl">
                {notionMarkdown ? (
                  <MarkdownView content={notionMarkdown} />
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                    <StickyNote className="w-8 h-8 text-muted-foreground/70" />
                    <p className="text-sm text-muted-foreground">This page has no text content.</p>
                    <a href={`https://notion.so/${selected.id.replace(/-/g, '')}`} target="_blank" rel="noopener noreferrer"
                      className={viewerActionClass}>
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
                  <CannotPreview name={selected.title} mimeType={selected.mimeType} onDownload={onDownload} />
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
                  <CannotPreview name={selected.title} mimeType={selected.mimeType} onDownload={onDownload} />
                )}
              </>
            )}

            {/* Empty state */}
            {!isFileLoading && !fileError && !selected.isFolder &&
              selected.source.kind === 'obsidian' && !obsidianFileData && (
              <div className="flex items-center justify-center h-32">
                <FileText className="w-6 h-6 text-muted-foreground/70" />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
