/**
 * Shared primitives for the Files page family.
 *
 * Anything used by two or more of the per-source sections / viewer lives here:
 * source descriptors, the file-type icon helper, the collapsible section
 * header, and the sidebar filter input.
 */

import { ChevronRight, ChevronDown, Search, X, FileText, Image, Film, Music, FileCode, Archive, File } from 'lucide-react';
import type { VaultFileEntry } from '@/lib/api';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Source =
  | { kind: 'obsidian'; vaultId: number }
  | { kind: 'notion' }
  | { kind: 'gdrive'; folderId: number; folderName: string }
  | { kind: 'smb'; shareId: number; shareName: string };

export interface SelectedItem {
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

export function fileTypeIcon(name: string, mimeType?: string, className = 'w-3.5 h-3.5') {
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
    return <FileText className={cn(className, 'text-muted-foreground')} />;
  if (mime.startsWith('application/vnd.google-apps.'))
    return <File className={cn(className, 'text-blue-400')} />;
  return <File className={cn(className, 'text-muted-foreground')} />;
}

// ── Obsidian file tree helpers ────────────────────────────────────────────────

export function flattenFiles(entries: VaultFileEntry[], query: string): VaultFileEntry[] {
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

// ── Section shell ─────────────────────────────────────────────────────────────

/** Wrapper classes shared by every collapsible sidebar section. */
export function sectionShellClass(open: boolean) {
  return cn('flex flex-col border-b border-border', open ? 'flex-1 min-h-0' : 'flex-shrink-0');
}

// ── Section header (collapsible) ──────────────────────────────────────────────

export interface SectionHeaderProps {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}

export function SectionHeader({ open, onToggle, icon, label, meta, actions }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-border">
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

/** Small icon button used in section header action slots. */
export const sectionActionClass =
  'p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors flex-shrink-0';

// ── Sidebar filter input ──────────────────────────────────────────────────────

export interface TreeFilterInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

export function TreeFilterInput({ value, onChange, placeholder }: TreeFilterInputProps) {
  return (
    <div className="px-3 py-2 border-b border-border/60">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-secondary/60 border border-border rounded-lg pl-8 pr-7 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
        />
        {value && (
          <button onClick={() => onChange('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
            <X className="w-3 h-3 text-muted-foreground" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Shared "not connected" call-to-action link ────────────────────────────────

export const connectCtaClass =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium border border-primary/20 hover:bg-primary/20 transition-colors';

// ── Shared tree list states ───────────────────────────────────────────────────

export const treeListClass = 'flex-1 overflow-y-auto py-1 px-1 min-h-0';
