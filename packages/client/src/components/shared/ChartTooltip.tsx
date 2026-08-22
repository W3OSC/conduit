import { cn } from '@/lib/utils';

/**
 * Shared recharts tooltip used by the Dashboard and Twitter analytics charts.
 * Recharts injects `active`, `payload` and `label` when passed via
 * `<Tooltip content={<ChartTooltip />} />`.
 */
export function ChartTooltip({ active, payload, label, capitalize, className }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string | number;
  /** Capitalise series names (Twitter analytics passes lowercase keys) */
  capitalize?: boolean;
  className?: string;
}) {
  if (!active || !payload) return null;
  return (
    <div className={cn('card-warm border-border/80 p-3 text-xs shadow-warm-lg min-w-[130px]', className)}>
      <p className="text-muted-foreground mb-2 font-medium">{String(label)}</p>
      <div className="space-y-1">
        {payload.map((p) => (
          <div key={p.name} className="flex items-center gap-2">
            <span className="w-3 h-[3px] rounded-full flex-shrink-0" style={{ background: p.color }} />
            <span className={cn('text-muted-foreground', capitalize && 'capitalize')}>{p.name}</span>
            <span className="ml-auto pl-3 font-semibold text-foreground tabular-nums">{(p.value ?? 0).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
