import { cn } from '@/lib/utils';

type Status = 'connected' | 'disconnected' | 'connecting' | 'error';

const STATUS_CLASSES: Record<Status, string> = {
  connected:    'status-dot-connected',
  disconnected: 'status-dot-disconnected',
  connecting:   'status-dot-connecting',
  error:        'status-dot-error',
};

const STATUS_LABELS: Record<Status, string> = {
  connected: 'Connected', disconnected: 'Disconnected',
  connecting: 'Connecting', error: 'Error',
};

const STATUS_CHIP: Record<Status, string> = {
  connected:    'border-emerald-500/20 bg-emerald-500/8  text-emerald-400',
  disconnected: 'border-warm-600/40    bg-warm-800/50    text-warm-400',
  connecting:   'border-primary/20     bg-primary/8      text-primary',
  error:        'border-red-500/20     bg-red-500/8      text-red-400',
};

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span className={cn('status-dot', STATUS_CLASSES[status], className)} title={STATUS_LABELS[status]} />
  );
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
      STATUS_CHIP[status],
    )}>
      <StatusDot status={status} />
      <span>{STATUS_LABELS[status]}</span>
    </span>
  );
}

export function StatusPill({ status, label }: { status: Status; label?: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 text-xs font-medium',
      status === 'connected'    ? 'text-emerald-400' :
      status === 'connecting'   ? 'text-primary' :
      status === 'error'        ? 'text-red-400' : 'text-warm-400',
    )}>
      <StatusDot status={status} className="w-1.5 h-1.5" />
      {label ?? STATUS_LABELS[status]}
    </span>
  );
}
