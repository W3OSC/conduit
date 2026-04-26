import { useQuery } from '@tanstack/react-query';
import { diffLines, type Change } from 'diff';
import { FileText, FilePlus, Loader2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PatchEdit {
  search: string;
  position?: 'replace' | 'before' | 'after';
  replace?: string;
  content?: string;
}

interface FileDiffViewProps {
  /** Vault-relative path to the file being written. */
  filePath: string;
  /**
   * The new content that will be written (write_file / create_file).
   * Leave empty when using patchEdits.
   */
  newContent?: string;
  /** If true the file is being created (no original to diff against). */
  isNewFile?: boolean;
  /**
   * For patch_file actions: the ordered list of search-and-replace edits.
   * The component fetches the original file and applies these to produce the
   * after-state for the diff.
   */
  patchEdits?: PatchEdit[];
}

// ── Diff rendering helpers ────────────────────────────────────────────────────

interface HunkLine {
  type: 'added' | 'removed' | 'context';
  content: string;
  /** 1-indexed line number in original file (undefined for added lines) */
  oldLineNo?: number;
  /** 1-indexed line number in new file (undefined for removed lines) */
  newLineNo?: number;
}

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: HunkLine[];
}

/** Number of unchanged context lines to show around each changed region. */
const CONTEXT = 3;

function buildHunks(changes: Change[]): Hunk[] {
  // Expand Change[] into a flat list of annotated lines
  const flat: HunkLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const change of changes) {
    const lines = change.value.split('\n');
    // split() on "a\nb\n" yields ["a","b",""] — drop the trailing empty string
    if (lines[lines.length - 1] === '') lines.pop();

    for (const content of lines) {
      if (change.added) {
        flat.push({ type: 'added', content, newLineNo: newLine++ });
      } else if (change.removed) {
        flat.push({ type: 'removed', content, oldLineNo: oldLine++ });
      } else {
        flat.push({ type: 'context', content, oldLineNo: oldLine++, newLineNo: newLine++ });
      }
    }
  }

  // Find indices of changed lines
  const changedIndices = flat
    .map((l, i) => (l.type !== 'context' ? i : -1))
    .filter((i) => i !== -1);

  if (changedIndices.length === 0) return [];

  // Build ranges [start, end] with CONTEXT padding, merging overlapping ranges
  const ranges: Array<[number, number]> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(flat.length - 1, idx + CONTEXT);
    if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
      ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  return ranges.map(([start, end]) => {
    const lines = flat.slice(start, end + 1);
    const firstOld = lines.find((l) => l.oldLineNo !== undefined)?.oldLineNo ?? 1;
    const firstNew = lines.find((l) => l.newLineNo !== undefined)?.newLineNo ?? 1;
    return { oldStart: firstOld, newStart: firstNew, lines };
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function HunkHeader({ hunk }: { hunk: Hunk }) {
  const oldCount = hunk.lines.filter((l) => l.type !== 'added').length;
  const newCount = hunk.lines.filter((l) => l.type !== 'removed').length;
  return (
    <div className="flex items-center gap-2 px-3 py-1 bg-sky-500/8 border-y border-sky-500/15 font-mono text-[10px] text-sky-400/80 select-none">
      <span>
        @@ -{hunk.oldStart},{oldCount} +{hunk.newStart},{newCount} @@
      </span>
    </div>
  );
}

function DiffLine({ line }: { line: HunkLine }) {
  const isAdded   = line.type === 'added';
  const isRemoved = line.type === 'removed';

  return (
    <div
      className={cn(
        'flex min-w-0 font-mono text-xs leading-5',
        isAdded   && 'bg-emerald-500/10',
        isRemoved && 'bg-red-500/10',
      )}
    >
      {/* Old line number */}
      <span
        className={cn(
          'w-10 shrink-0 text-right pr-2 select-none text-[10px] leading-5 border-r',
          isAdded   ? 'text-transparent border-emerald-500/15' : 'text-muted-foreground/40 border-border/30',
        )}
      >
        {line.oldLineNo ?? ''}
      </span>

      {/* New line number */}
      <span
        className={cn(
          'w-10 shrink-0 text-right pr-2 select-none text-[10px] leading-5 border-r',
          isRemoved ? 'text-transparent border-red-500/15'     : 'text-muted-foreground/40 border-border/30',
        )}
      >
        {line.newLineNo ?? ''}
      </span>

      {/* Sign */}
      <span
        className={cn(
          'w-5 shrink-0 text-center select-none font-bold',
          isAdded   && 'text-emerald-400',
          isRemoved && 'text-red-400',
          !isAdded && !isRemoved && 'text-muted-foreground/30',
        )}
      >
        {isAdded ? '+' : isRemoved ? '−' : ' '}
      </span>

      {/* Content */}
      <span
        className={cn(
          'flex-1 min-w-0 whitespace-pre-wrap break-all pl-1 pr-3',
          isAdded   && 'text-emerald-100',
          isRemoved && 'text-red-200',
          !isAdded && !isRemoved && 'text-foreground/70',
        )}
      >
        {line.content || ' '}
      </span>
    </div>
  );
}

// ── Stat summary pill ─────────────────────────────────────────────────────────

function DiffStats({ changes }: { changes: Change[] }) {
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    const lines = c.value.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
    if (c.added) added += lines.length;
    else if (c.removed) removed += lines.length;
  }
  if (added === 0 && removed === 0) return null;
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono select-none">
      {added   > 0 && <span className="text-emerald-400">+{added}</span>}
      {removed > 0 && <span className="text-red-400">−{removed}</span>}
    </div>
  );
}

// ── Patch application (mirrors server logic) ──────────────────────────────────

/**
 * Apply an ordered list of search-and-replace edits to a string.
 * Returns the patched string on success, or an error message if any edit fails.
 */
function applyPatchEdits(original: string, edits: PatchEdit[]): { result: string } | { error: string } {
  let current = original;
  for (let i = 0; i < edits.length; i++) {
    const { search, position = 'replace', replace = '', content = '' } = edits[i];
    if (!search) return { error: `Edit ${i + 1}: search string is empty.` };

    let count = 0;
    let pos = current.indexOf(search);
    const firstPos = pos;
    while (pos !== -1) {
      count++;
      if (count > 1) break;
      pos = current.indexOf(search, pos + 1);
    }

    if (count === 0) return { error: `Edit ${i + 1}: search string not found in file.` };
    if (count > 1)  return { error: `Edit ${i + 1}: search string matches more than one location.` };

    if (position === 'before') {
      current = current.slice(0, firstPos) + content + current.slice(firstPos);
    } else if (position === 'after') {
      const afterPos = firstPos + search.length;
      current = current.slice(0, afterPos) + content + current.slice(afterPos);
    } else {
      current = current.slice(0, firstPos) + replace + current.slice(firstPos + search.length);
    }
  }
  return { result: current };
}

// ── Main component ────────────────────────────────────────────────────────────

export function FileDiffView({ filePath, newContent = '', isNewFile = false, patchEdits }: FileDiffViewProps) {
  const isPatch = !!patchEdits && patchEdits.length > 0;

  // Fetch the current file contents from the vault (skip for new files; always fetch for patches)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['obsidian-file', filePath],
    queryFn: () => api.obsidianReadFile(filePath),
    enabled: !isNewFile,
    retry: false,
    throwOnError: false,
  });

  const originalContent = data?.content ?? '';

  // ── New-file mode ─────────────────────────────────────────────────────────
  if (isNewFile || (isError && !isLoading && !isPatch)) {
    const lines = newContent.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return (
      <div className="rounded-xl overflow-hidden border border-emerald-500/20 bg-background text-xs">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-secondary/60 border-b border-border/50">
          <FilePlus className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="font-mono text-[11px] text-foreground/80 truncate flex-1">{filePath}</span>
          <span className="chip chip-emerald text-[9px] shrink-0">new file</span>
        </div>
        {/* Content — all lines are additions */}
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          {lines.map((content, i) => (
            <DiffLine
              key={i}
              line={{ type: 'added', content, newLineNo: i + 1 }}
            />
          ))}
        </div>
      </div>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Loading current file…</span>
      </div>
    );
  }

  // ── Compute effective "after" content ─────────────────────────────────────
  let afterContent = newContent;
  let patchError: string | null = null;

  if (isPatch) {
    const applied = applyPatchEdits(originalContent, patchEdits!);
    if ('error' in applied) {
      patchError = applied.error;
    } else {
      afterContent = applied.result;
    }
  }

  // ── Patch error state ─────────────────────────────────────────────────────
  if (patchError) {
    return (
      <div className="rounded-xl overflow-hidden border border-red-500/20 bg-background text-xs">
        <div className="flex items-center gap-2 px-3 py-2 bg-secondary/60 border-b border-border/50">
          <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="font-mono text-[11px] text-foreground/80 truncate flex-1">{filePath}</span>
          <span className="chip chip-red text-[9px] shrink-0">patch error</span>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 text-red-400 text-[11px]">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {patchError}
        </div>
      </div>
    );
  }

  // ── Compute diff ──────────────────────────────────────────────────────────
  const changes = diffLines(originalContent, afterContent, { newlineIsToken: false });
  const hunks = buildHunks(changes);
  const hasChanges = hunks.length > 0;

  return (
    <div className="rounded-xl overflow-hidden border border-border/60 bg-background text-xs">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-secondary/60 border-b border-border/50">
        <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="font-mono text-[11px] text-foreground/80 truncate flex-1">{filePath}</span>
        {hasChanges ? (
          <DiffStats changes={changes} />
        ) : (
          <span className="text-muted-foreground/50 text-[10px]">no changes</span>
        )}
      </div>

      {/* Diff body */}
      {hasChanges ? (
        <div className="overflow-x-auto max-h-80 overflow-y-auto divide-y divide-border/20">
          {hunks.map((hunk, hi) => (
            <div key={hi}>
              <HunkHeader hunk={hunk} />
              {hunk.lines.map((line, li) => (
                <DiffLine key={li} line={line} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-3 text-muted-foreground/50 text-[11px]">
          <AlertCircle className="w-3.5 h-3.5" />
          The new content is identical to the current file.
        </div>
      )}
    </div>
  );
}
