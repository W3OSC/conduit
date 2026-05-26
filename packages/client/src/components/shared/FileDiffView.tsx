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
   * Vault ID to read from. When omitted (or 0 / negative), the component
   * automatically falls back to the first connected vault so that outbox items
   * created without an explicit vaultId still render correctly.
   */
  vaultId?: number;
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

// ── Fuzzy matching (mirrors server util/fuzzy-search.ts) ──────────────────────

const FUZZY_THRESHOLD = 0.9;

function levenshteinDistance(a: string, b: string, maxDist: number): number {
  if (a.length > b.length) { const t = a; a = b; b = t; }
  const aLen = a.length;
  const bLen = b.length;
  if (bLen - aLen > maxDist) return maxDist + 1;
  let prev = new Uint32Array(aLen + 1);
  let curr = new Uint32Array(aLen + 1);
  for (let i = 0; i <= aLen; i++) prev[i] = i;
  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    let rowMin = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
      if (curr[i] < rowMin) rowMin = curr[i];
    }
    if (rowMin > maxDist) return maxDist + 1;
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[aLen];
}

function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const maxDist = Math.ceil(maxLen * (1 - FUZZY_THRESHOLD));
  const dist = levenshteinDistance(a, b, maxDist);
  return 1 - dist / maxLen;
}

function fuzzyFind(search: string, fileContent: string): string | null {
  const searchLen = search.length;
  const contentLen = fileContent.length;
  if (!searchLen || !contentLen || searchLen > contentLen) return null;
  let bestScore = -1;
  let bestText = '';
  let secondBestScore = -1;
  for (let i = 0; i <= contentLen - searchLen; i++) {
    const window = fileContent.slice(i, i + searchLen);
    const score = stringSimilarity(search, window);
    if (score > bestScore) { secondBestScore = bestScore; bestScore = score; bestText = window; }
    else if (score > secondBestScore) { secondBestScore = score; }
  }
  if (bestScore < FUZZY_THRESHOLD) return null;
  if (secondBestScore >= FUZZY_THRESHOLD) return null; // ambiguous
  return bestText;
}

// ── Patch application (mirrors server logic) ──────────────────────────────────

/**
 * Apply an ordered list of search-and-replace edits to a string.
 * Falls back to fuzzy matching (≥90% similarity, unique) when exact match fails.
 * Returns the patched string on success, or an error message if any edit fails.
 */
function applyPatchEdits(original: string, edits: PatchEdit[]): { result: string } | { error: string } {
  let current = original;
  for (let i = 0; i < edits.length; i++) {
    const { position = 'replace', replace = '', content = '' } = edits[i];
    let { search } = edits[i];
    if (!search) return { error: `Edit ${i + 1}: search string is empty.` };

    let count = 0;
    let pos = current.indexOf(search);
    while (pos !== -1) {
      count++;
      if (count > 1) break;
      pos = current.indexOf(search, pos + 1);
    }

    if (count > 1) {
      const preview = search.length > 120 ? search.slice(0, 120).replace(/\n/g, '↵') + '…' : search.replace(/\n/g, '↵');
      return { error: `Edit ${i + 1}: search string matches more than one location.\nSearch string (${search.length} chars): "${preview}"\nMake it more specific by including more surrounding context.` };
    }

    if (count === 0) {
      const fuzzyMatch = fuzzyFind(search, current);
      if (!fuzzyMatch) {
        const preview = search.length > 120 ? search.slice(0, 120).replace(/\n/g, '↵') + '…' : search.replace(/\n/g, '↵');
        return { error: `Edit ${i + 1}: search string not found in file.\nSearch string (${search.length} chars): "${preview}"\nMake sure it matches the file content exactly (including whitespace and line endings).` };
      }
      search = fuzzyMatch;
    }

    const matchPos = current.indexOf(search);
    if (position === 'before') {
      current = current.slice(0, matchPos) + content + current.slice(matchPos);
    } else if (position === 'after') {
      const afterPos = matchPos + search.length;
      current = current.slice(0, afterPos) + content + current.slice(afterPos);
    } else {
      current = current.slice(0, matchPos) + replace + current.slice(matchPos + search.length);
    }
  }
  return { result: current };
}

// ── Main component ────────────────────────────────────────────────────────────

export function FileDiffView({ filePath, vaultId: vaultIdProp, newContent = '', isNewFile = false, patchEdits }: FileDiffViewProps) {
  const isPatch = !!patchEdits && patchEdits.length > 0;

  // When vaultId is missing or invalid (e.g. AI-created outbox items that omit vaultId),
  // fall back to the first connected vault so the diff renders correctly.
  const needsVaultLookup = !vaultIdProp || vaultIdProp <= 0;
  const { data: vaultsData, isLoading: isLoadingVaults } = useQuery({
    queryKey: ['obsidian-vaults'],
    queryFn: () => api.listObsidianVaults(),
    enabled: needsVaultLookup && !isNewFile,
    staleTime: 30_000,
  });
  const vaultId: number = needsVaultLookup
    ? (vaultsData?.vaults?.[0]?.id ?? 0)
    : vaultIdProp!;

  // Fetch the current file contents from the vault (skip for new files; always fetch for patches)
  const { data, isPending: isFilePending, isError } = useQuery({
    queryKey: ['obsidian-file', vaultId, filePath],
    queryFn: () => api.obsidianReadFile(vaultId, filePath),
    // Don't attempt the file read until we have a valid vault ID
    enabled: !isNewFile && vaultId > 0,
    retry: false,
    throwOnError: false,
  });

  const originalContent = data?.content ?? '';

  // ── Loading ───────────────────────────────────────────────────────────────
  // Wait for vault lookup to resolve, then wait for file fetch.
  // isPending covers disabled queries (vaultId still 0) as well as in-flight ones.
  if (isLoadingVaults || isFilePending) {
    return (
      <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Loading current file…</span>
      </div>
    );
  }

  // ── New-file mode ─────────────────────────────────────────────────────────
  if (isNewFile || (isError && !isPatch)) {
    const lines = newContent.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return (
      <div className="rounded-xl overflow-hidden border border-emerald-500/20 bg-background text-xs">
        <div className="flex items-center gap-2 px-3 py-2 bg-secondary/60 border-b border-border/50">
          <FilePlus className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="font-mono text-[11px] text-foreground/80 truncate flex-1">{filePath}</span>
          <span className="chip chip-emerald text-[9px] shrink-0">new file</span>
        </div>
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
        <div className="flex items-start gap-2 px-4 py-3 text-red-400 text-[11px]">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <pre className="whitespace-pre-wrap break-words font-mono">{patchError}</pre>
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
