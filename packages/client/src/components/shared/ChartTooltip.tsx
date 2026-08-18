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
    <div className={cn('card-warm border-border/80 p-3 text-xs shadow-warm-lg min-w-[120px]', className)}>
      <p className="text-muted-foreground mb-2 font-medium">{String(label)}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span style={{ color: p.color }} className={capitalize ? 'capitalize' : undefined}>{p.name}</span>
          <span className="font-semibold text-foreground">{(p.value ?? 0).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
