import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check, X, Pencil, Trash2, SendHorizonal, Clock, CheckCircle2, XCircle,
  Inbox, ChevronDown, ChevronUp, Save, RotateCcw,
} from 'lucide-react';
import { api, type OutboxItem } from '@/lib/api';
import { ServiceBadge } from '@/components/shared/ServiceBadge';
import { TableSkeleton } from '@/components/shared/Skeleton';
import { FileDiffView, type PatchEdit } from '@/components/shared/FileDiffView';
import { cn, timeAgo, formatDate } from '@/lib/utils';
import { toast } from '@/store';

type FilterStatus = 'all' | 'pending' | 'approved' | 'sent' | 'rejected' | 'failed';

// ── Status chip ───────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { icon: React.ComponentType<{ className?: string }>; chip: string }> = {
  pending:  { icon: Clock,         chip: 'chip chip-amber' },
  approved: { icon: CheckCircle2,  chip: 'chip chip-emerald' },
  sent:     { icon: SendHorizonal, chip: 'chip chip-sky' },
  rejected: { icon: XCircle,       chip: 'chip chip-red' },
  failed:   { icon: XCircle,       chip: 'chip chip-red' },
};

function StatusChip({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  const Icon = cfg.icon;
  return (
    <span className={cfg.chip}>
      <Icon className="w-3 h-3" />
      {status}
    </span>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar<T extends string>({
  options, value, onChange, className,
}: { options: T[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn('flex items-center gap-0.5 bg-secondary border border-border rounded-xl p-1', className)}>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={cn(
            'px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 capitalize',
            value === o
              ? 'bg-background text-foreground shadow-warm-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >{o}</button>
      ))}
    </div>
  );
}

// ── Content rendering helpers ─────────────────────────────────────────────────

/** Services that store plain-text content (not JSON). */
const PLAIN_TEXT_SERVICES = new Set(['slack', 'discord', 'telegram']);

/** Try to parse content as JSON. Returns parsed object or null. */
function tryParseJSON(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Human-readable label for a JSON field key. */
function fieldLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Format a field value for display. */
function formatFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return '(none)';
    // Arrays of strings — join them
    if (value.every((v) => typeof v === 'string')) return value.join(', ');
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** Classify which fields are "primary" (shown prominently) vs secondary. */
function classifyFields(source: string, payload: Record<string, unknown>) {
  const primaryKeys = new Set<string>();
  const bodyKeys = new Set<string>();   // multi-line text
  const metaKeys = new Set<string>();   // always shown in meta row

  metaKeys.add('action');

  if (source === 'gmail') {
    for (const k of ['to', 'cc', 'subject']) if (k in payload) primaryKeys.add(k);
    if ('body' in payload) bodyKeys.add('body');
  } else if (source === 'calendar') {
    for (const k of ['title', 'start', 'end', 'location', 'attendees', 'rsvpStatus']) {
      if (k in payload) primaryKeys.add(k);
    }
    if ('description' in payload) bodyKeys.add('description');
  } else if (source === 'twitter') {
    if ('text' in payload) bodyKeys.add('text');
    for (const k of ['handle', 'replyToId', 'quotedId', 'tweetId', 'conversationId']) {
      if (k in payload) primaryKeys.add(k);
    }
  } else if (source === 'notion') {
    for (const k of ['parentId', 'parentType', 'pageId', 'blockId']) {
      if (k in payload) primaryKeys.add(k);
    }
    if ('properties' in payload) bodyKeys.add('properties');
    if ('children' in payload) bodyKeys.add('children');
  } else if (source === 'obsidian') {
    for (const k of ['path', 'oldPath', 'newPath']) if (k in payload) primaryKeys.add(k);
    if ('content' in payload) bodyKeys.add('content');
    if ('edits' in payload) bodyKeys.add('edits');
  }

  // Any remaining keys go into primaryKeys
  for (const k of Object.keys(payload)) {
    if (!metaKeys.has(k) && !primaryKeys.has(k) && !bodyKeys.has(k)) {
      primaryKeys.add(k);
    }
  }

  return { metaKeys, primaryKeys, bodyKeys };
}

// ── Structured content view / inline editor ───────────────────────────────────

interface ContentViewProps {
  item: OutboxItem;
  editing: boolean;
  editDraft: Record<string, string>;
  setEditDraft: (d: Record<string, string>) => void;
}

function StructuredContentView({ item, editing, editDraft, setEditDraft }: ContentViewProps) {
  const rawContent = item.editedContent || item.content;
  const isPlain = PLAIN_TEXT_SERVICES.has(item.source);

  // ── Plain-text services ────────────────────────────────────────────────────
  if (isPlain) {
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Message
        </p>
        {editing ? (
          <textarea
            value={editDraft['__text'] ?? rawContent}
            onChange={(e) => setEditDraft({ __text: e.target.value })}
            rows={Math.max(3, (editDraft['__text'] ?? rawContent).split('\n').length + 1)}
            className="input-warm resize-y w-full font-mono text-sm leading-relaxed"
            autoFocus
          />
        ) : (
          <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap bg-secondary/40 rounded-xl px-3 py-2.5">
            {rawContent}
          </p>
        )}
      </div>
    );
  }

  // ── JSON-based services ────────────────────────────────────────────────────
  const parsed = tryParseJSON(rawContent);

  // Fallback: if content doesn't parse, show as plain text
  if (!parsed) {
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">Content</p>
        {editing ? (
          <textarea
            value={editDraft['__text'] ?? rawContent}
            onChange={(e) => setEditDraft({ __text: e.target.value })}
            rows={6}
            className="input-warm resize-y w-full font-mono text-sm"
            autoFocus
          />
        ) : (
          <pre className="text-xs text-foreground/80 leading-relaxed bg-secondary/40 rounded-xl px-3 py-2.5 overflow-x-auto font-mono whitespace-pre-wrap break-words">
            {rawContent}
          </pre>
        )}
      </div>
    );
  }

  const { metaKeys, primaryKeys, bodyKeys } = classifyFields(item.source, parsed);

  // ── Obsidian write_file / create_file / patch_file: show a diff view
  const obsidianAction = item.source === 'obsidian' ? String(parsed['action'] ?? '') : '';
  const isObsidianWrite = obsidianAction === 'write_file';
  const isObsidianCreate = obsidianAction === 'create_file';
  const isObsidianPatch = obsidianAction === 'patch_file';
  const showDiff = (isObsidianWrite || isObsidianCreate || isObsidianPatch) && !editing;
  const diffFilePath = String(parsed['path'] ?? '');
  const diffNewContent = String(parsed['content'] ?? '');
  // For patch_file, extract the edits array
  const patchEdits = isObsidianPatch && Array.isArray(parsed['edits'])
    ? (parsed['edits'] as PatchEdit[])
    : undefined;

  const renderField = (key: string, multiline = false) => {
    const value = parsed[key];
    const displayVal = formatFieldValue(key, value);

    // For obsidian write/create/patch, replace the relevant body field with a diff view
    const isDiffField = showDiff && item.source === 'obsidian' && (
      (key === 'content' && !isObsidianPatch) ||
      (key === 'edits'   && isObsidianPatch)
    );
    if (isDiffField) {
      return (
        <div key={key} className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
            Changes
          </p>
          <FileDiffView
            filePath={diffFilePath}
            vaultId={typeof parsed['vaultId'] === 'number' ? parsed['vaultId'] : 0}
            newContent={diffNewContent}
            isNewFile={isObsidianCreate}
            patchEdits={patchEdits}
          />
        </div>
      );
    }

    // Determine if the value is complex (object/array) — complex values are shown raw / non-editable
    const isComplex = typeof value === 'object' && value !== null;
    const draftKey = key;
    const draftVal = editDraft[draftKey] ?? displayVal;

    return (
      <div key={key} className="space-y-0.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          {fieldLabel(key)}
        </p>
        {editing && !isComplex ? (
          multiline ? (
            <textarea
              value={draftVal}
              onChange={(e) => setEditDraft({ ...editDraft, [draftKey]: e.target.value })}
              rows={Math.max(3, draftVal.split('\n').length + 1)}
              className="input-warm resize-y w-full text-sm font-mono leading-relaxed"
              autoFocus={key === Array.from(bodyKeys)[0]}
            />
          ) : (
            <input
              type="text"
              value={draftVal}
              onChange={(e) => setEditDraft({ ...editDraft, [draftKey]: e.target.value })}
              className="input-warm w-full text-sm"
            />
          )
        ) : (
          multiline || isComplex ? (
            <pre className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap bg-secondary/40 rounded-xl px-3 py-2.5 font-mono text-xs overflow-x-auto break-words">
              {displayVal}
            </pre>
          ) : (
            <p className="text-sm text-foreground/85 bg-secondary/40 rounded-xl px-3 py-2">
              {displayVal}
            </p>
          )
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* Action badge row */}
      <div className="flex items-center gap-2 flex-wrap">
        {Array.from(metaKeys).map((k) => (
          <span key={k} className="chip chip-violet text-[10px]">
            {fieldLabel(k)}: {String(parsed[k] ?? '—')}
          </span>
        ))}
      </div>

      {/* Primary scalar fields */}
      {Array.from(primaryKeys).length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Array.from(primaryKeys).map((k) => renderField(k, false))}
        </div>
      )}

      {/* Body / multi-line fields */}
      {Array.from(bodyKeys).map((k) => renderField(k, true))}
    </div>
  );
}

// ── Outbox card ───────────────────────────────────────────────────────────────

function OutboxCard({ item }: { item: OutboxItem }) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(item.status === 'pending');
  const [editDraft, setEditDraft] = useState<Record<string, string>>({});
  const qc = useQueryClient();

  const isPlain = PLAIN_TEXT_SERVICES.has(item.source);

  /** Build the updated content string from editDraft. */
  function buildEditedContent(): string {
    const rawContent = item.editedContent || item.content;

    if (isPlain || editDraft['__text'] !== undefined) {
      return editDraft['__text'] ?? rawContent;
    }

    // JSON service — merge draft values back into the parsed payload
    const parsed = tryParseJSON(rawContent);
    if (!parsed) return editDraft['__text'] ?? rawContent;

    const merged = { ...parsed };
    for (const [key, val] of Object.entries(editDraft)) {
      // Try to keep type fidelity: if original was array of strings, split by comma
      const original = parsed[key];
      if (Array.isArray(original) && original.every((v) => typeof v === 'string')) {
        merged[key] = val.split(',').map((s) => s.trim()).filter(Boolean);
      } else if (typeof original === 'boolean') {
        merged[key] = val.toLowerCase() === 'yes' || val === 'true';
      } else {
        merged[key] = val;
      }
    }
    return JSON.stringify(merged);
  }

  const approve = useMutation({
    mutationFn: () => api.updateOutboxItem(item.id, 'approve'),
    onSuccess: () => { toast({ title: 'Approved & sent', variant: 'success' }); qc.invalidateQueries({ queryKey: ['outbox'] }); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const reject = useMutation({
    mutationFn: () => api.updateOutboxItem(item.id, 'reject'),
    onSuccess: () => { toast({ title: 'Rejected' }); qc.invalidateQueries({ queryKey: ['outbox'] }); },
  });

  const save = useMutation({
    mutationFn: () => api.updateOutboxItem(item.id, 'edit', buildEditedContent()),
    onSuccess: () => {
      toast({ title: 'Message updated', variant: 'success' });
      qc.invalidateQueries({ queryKey: ['outbox'] });
      setEditing(false);
      setEditDraft({});
    },
  });

  const del = useMutation({
    mutationFn: () => api.deleteOutboxItem(item.id),
    onSuccess: () => { toast({ title: 'Deleted' }); qc.invalidateQueries({ queryKey: ['outbox'] }); },
  });

  const isPending = item.status === 'pending';

  function startEditing() {
    setEditDraft({});
    setEditing(true);
    setExpanded(true);
  }

  function cancelEditing() {
    setEditing(false);
    setEditDraft({});
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className={cn(
        'card-warm overflow-hidden transition-all duration-200',
        isPending && 'border-primary/20 amber-surface',
        editing && 'border-primary/30 ring-1 ring-primary/10',
      )}
    >
      {/* ── Card header ─────────────────────────────────────────────────── */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer select-none"
        onClick={() => !editing && setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        <div className="mt-0.5 flex-shrink-0">
          <ServiceBadge service={item.source} size="sm" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate">
              → {item.recipientName || item.recipientId}
            </span>
            {item.batchId && <span className="chip chip-violet text-[10px]">batch</span>}
            <span className={cn('chip text-[10px]', item.requester === 'api' ? 'chip-violet' : 'chip-sky')}>
              {item.requester}
            </span>
            {item.editedContent && item.editedContent !== item.content && (
              <span className="chip chip-amber text-[10px]">edited</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <p className="text-[11px] text-muted-foreground">{timeAgo(item.createdAt)}</p>
            {item.sentAt && (
              <p className="text-[11px] text-muted-foreground">
                sent {timeAgo(item.sentAt)}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <StatusChip status={item.status} />
          {!editing && (
            expanded
              ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
              : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* ── Expanded body ────────────────────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3 border-t border-border/50 pt-3">
              {/* ── Content area ─────────────────────────────────────────── */}
              <StructuredContentView
                item={item}
                editing={editing}
                editDraft={editDraft}
                setEditDraft={setEditDraft}
              />

              {/* ── Error message ─────────────────────────────────────────── */}
              {item.errorMessage && (
                <p className="text-xs text-red-400 bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2">
                  {item.errorMessage}
                </p>
              )}

              {/* ── Timestamps row ────────────────────────────────────────── */}
              {(item.approvedAt || item.sentAt) && (
                <div className="flex gap-4 text-[11px] text-muted-foreground/60">
                  {item.approvedAt && (
                    <span>Approved {formatDate(item.approvedAt, 'MMM d, HH:mm')}</span>
                  )}
                  {item.sentAt && (
                    <span>Sent {formatDate(item.sentAt, 'MMM d, HH:mm')}</span>
                  )}
                </div>
              )}

              {/* ── Action bar ────────────────────────────────────────────── */}
              {editing ? (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={() => save.mutate()}
                    disabled={save.isPending}
                    className="btn-primary text-xs flex-1"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {save.isPending ? 'Saving…' : 'Save Changes'}
                  </button>
                  <button onClick={cancelEditing} className="btn-secondary text-xs">
                    <RotateCcw className="w-3.5 h-3.5" /> Discard
                  </button>
                </div>
              ) : isPending ? (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); approve.mutate(); }}
                    disabled={approve.isPending}
                    className="btn-primary text-xs flex-1"
                  >
                    <Check className="w-3.5 h-3.5" />
                    {approve.isPending ? 'Sending…' : 'Approve & Send'}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); startEditing(); }}
                    className="btn-secondary text-xs"
                  >
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); reject.mutate(); }}
                    disabled={reject.isPending}
                    className="btn-danger text-xs"
                  >
                    <X className="w-3.5 h-3.5" /> Reject
                  </button>
                </div>
              ) : (item.status === 'rejected' || item.status === 'failed') ? (
                <button
                  onClick={(e) => { e.stopPropagation(); del.mutate(); }}
                  className="btn-ghost text-xs text-muted-foreground"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Outbox() {
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['outbox', statusFilter, sourceFilter],
    queryFn: () => api.outbox(
      statusFilter === 'all' ? undefined : statusFilter,
      sourceFilter === 'all' ? undefined : sourceFilter,
    ),
    refetchInterval: 5000,
  });

  const items = data?.items || [];
  const pendingCount = data?.pendingCount || 0;

  return (
    <div className="p-4 space-y-4 animate-fade-in overflow-y-auto h-full">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-bold">Outbox</h2>
        {pendingCount > 0 && (
          <motion.span
            initial={{ scale: 0 }} animate={{ scale: 1 }}
            className="chip chip-amber font-semibold"
          >
            {pendingCount} pending
          </motion.span>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <FilterBar
          options={['all', 'pending', 'approved', 'sent', 'rejected'] as FilterStatus[]}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <FilterBar
          options={['all', 'slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar', 'notion', 'obsidian'] as const}
          value={sourceFilter}
          onChange={setSourceFilter}
        />
      </div>

      {/* Items */}
      {isLoading ? (
        <div className="space-y-3"><TableSkeleton rows={4} /></div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
          <div className="w-16 h-16 rounded-2xl bg-secondary/60 border border-border flex items-center justify-center">
            <Inbox className="w-8 h-8 opacity-20" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">Outbox is empty</p>
            <p className="text-xs opacity-60 mt-1">Messages sent through the Chat page will appear here for approval</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence>
            {items.map((item) => <OutboxCard key={item.id} item={item} />)}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
