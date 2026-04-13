import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, Pencil, Trash2, SendHorizonal, Clock, CheckCircle2, XCircle, Inbox } from 'lucide-react';
import { api, type OutboxItem } from '@/lib/api';
import { ServiceBadge } from '@/components/shared/ServiceBadge';
import { TableSkeleton } from '@/components/shared/Skeleton';
import { cn, timeAgo, formatDate, truncate } from '@/lib/utils';
import { toast } from '@/store';

type FilterStatus = 'all' | 'pending' | 'approved' | 'sent' | 'rejected' | 'failed';

const STATUS_CONFIG: Record<string, { icon: React.ComponentType<{className?: string}>; chip: string }> = {
  pending:  { icon: Clock,        chip: 'chip chip-amber' },
  approved: { icon: CheckCircle2, chip: 'chip chip-emerald' },
  sent:     { icon: SendHorizonal,chip: 'chip chip-sky' },
  rejected: { icon: XCircle,      chip: 'chip chip-red' },
  failed:   { icon: XCircle,      chip: 'chip chip-red' },
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

function EditModal({ item, onClose }: { item: OutboxItem; onClose: () => void }) {
  const [content, setContent] = useState(item.editedContent || item.content);
  const qc = useQueryClient();

  const edit = useMutation({
    mutationFn: () => api.updateOutboxItem(item.id, 'edit', content),
    onSuccess: () => { toast({ title: 'Message updated', variant: 'success' }); qc.invalidateQueries({ queryKey: ['outbox'] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="card-warm w-full max-w-lg p-6 space-y-4 shadow-warm-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Edit Message</h2>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-muted-foreground">
          To: <span className="text-foreground font-medium">{item.recipientName || item.recipientId}</span>
          {' '}via <ServiceBadge service={item.source} size="xs" />
        </p>
        <textarea
          value={content} onChange={(e) => setContent(e.target.value)} rows={6}
          className="input-warm resize-none"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={() => edit.mutate()} disabled={edit.isPending} className="btn-primary text-sm">Save</button>
        </div>
      </motion.div>
    </div>
  );
}

function OutboxCard({ item }: { item: OutboxItem }) {
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();

  const approve = useMutation({
    mutationFn: () => api.updateOutboxItem(item.id, 'approve'),
    onSuccess: () => { toast({ title: 'Approved & sent', variant: 'success' }); qc.invalidateQueries({ queryKey: ['outbox'] }); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });
  const reject = useMutation({
    mutationFn: () => api.updateOutboxItem(item.id, 'reject'),
    onSuccess: () => { toast({ title: 'Rejected' }); qc.invalidateQueries({ queryKey: ['outbox'] }); },
  });
  const del = useMutation({
    mutationFn: () => api.deleteOutboxItem(item.id),
    onSuccess: () => { toast({ title: 'Deleted' }); qc.invalidateQueries({ queryKey: ['outbox'] }); },
  });

  const content = item.editedContent || item.content;
  const isPending = item.status === 'pending';

  return (
    <>
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        className={cn(
          'card-warm p-4 space-y-3 transition-all duration-200',
          isPending && 'border-primary/20 amber-surface',
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          <ServiceBadge service={item.source} size="sm" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium truncate">
                → {item.recipientName || item.recipientId}
              </span>
              {item.batchId && <span className="chip chip-violet text-[10px]">batch</span>}
              <span className={cn(
                'chip text-[10px]',
                item.requester === 'api' ? 'chip-violet' : 'chip-sky',
              )}>
                {item.requester}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">{timeAgo(item.createdAt)}</p>
          </div>
          <StatusChip status={item.status} />
        </div>

        {/* Content */}
        <p className="text-sm text-foreground/80 leading-relaxed bg-secondary/40 rounded-xl px-3 py-2.5 break-words">
          {truncate(content, 200)}
        </p>
        {item.editedContent && item.editedContent !== item.content && (
          <p className="text-[11px] text-primary -mt-1">Message was edited</p>
        )}

        {/* Error */}
        {item.errorMessage && (
          <p className="text-xs text-red-400 bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2">
            {item.errorMessage}
          </p>
        )}

        {/* Actions */}
        {isPending && (
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => approve.mutate()} disabled={approve.isPending}
              className="btn-primary text-xs flex-1"
            >
              <Check className="w-3.5 h-3.5" /> Approve & Send
            </button>
            <button onClick={() => setEditing(true)} className="btn-secondary text-xs">
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
            <button
              onClick={() => reject.mutate()} disabled={reject.isPending}
              className="btn-danger text-xs"
            >
              <X className="w-3.5 h-3.5" /> Reject
            </button>
          </div>
        )}
        {(item.status === 'rejected' || item.status === 'failed') && (
          <button onClick={() => del.mutate()} className="btn-ghost text-xs text-muted-foreground">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        )}
      </motion.div>
      <AnimatePresence>
        {editing && <EditModal item={item} onClose={() => setEditing(false)} />}
      </AnimatePresence>
    </>
  );
}

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
    <div className="p-4 space-y-4 animate-fade-in">
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
        <div className="space-y-3">
          <AnimatePresence>
            {items.map((item) => <OutboxCard key={item.id} item={item} />)}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
