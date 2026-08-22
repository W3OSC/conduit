import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowUpRight, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { api } from '@/lib/api';
import { useConnectionStore, useSyncStore } from '@/store';
import { StatusDot } from '@/components/shared/StatusDot';
import { ServiceIcon } from '@/components/shared/ServiceBadge';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { cn, timeAgo } from '@/lib/utils';
import { SERVICE_THEME } from '@/lib/serviceTheme';
import { ChartTooltip } from '@/components/shared/ChartTooltip';

/**
 * Stack/legend/rail order and chart hues are one fixed sequence so color →
 * service stays learnable. Telegram and Twitter are stepped darker than their
 * badge hues (#0EA5E9 / #38BDF8): the brighter steps fail the dark-surface
 * lightness band and drop under 3:1 on white. This order keeps the two blues
 * and the two violets non-adjacent in the stack (worst adjacent CVD ΔE 7.5,
 * covered by the legend + tooltip identity channel).
 */
const SERVICES = ['slack', 'telegram', 'gmail', 'twitter', 'discord'] as const;
type ServiceKey = typeof SERVICES[number];

const CHART_HEX: Record<ServiceKey, string> = {
  slack:    '#8B5CF6',
  telegram: '#0284C7',
  gmail:    '#EF4444',
  twitter:  '#0891B2',
  discord:  '#6366F1',
};

// Pipeline outcomes are states, not series identities — good/bad wear status
// colors, "sent" wears the accent.
const PIPELINE = {
  approved: '#10B981',
  rejected: '#EF4444',
  sent:     'hsl(var(--primary))',
} as const;

const OK_GREEN = '#10B981';
const ERR_RED  = '#EF4444';

const gridStroke = 'hsl(var(--border) / 0.55)';
const axisTick   = { fontSize: 10, fill: 'hsl(var(--muted-foreground))' };
const compact    = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const trimYear   = (d: string) => String(d).replace(/^\d{4}-/, '');

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] as [number, number, number, number], delay },
});

// ── Small pieces ──────────────────────────────────────────────────────────────

function RangeSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-secondary border border-border rounded-xl p-1">
      {[7, 14, 30, 90].map((d) => (
        <button key={d} onClick={() => onChange(d)}
          className={cn(
            'px-2.5 py-1 rounded-lg text-xs font-medium transition-all',
            value === d ? 'bg-background text-foreground shadow-warm-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >{d}d</button>
      ))}
    </div>
  );
}

function Legend({ items, className }: {
  items: Array<{ label: string; color: string }>; className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-x-3 gap-y-1 flex-wrap', className)}>
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Spark({ points, color }: { points: number[]; color: string }) {
  const w = 68, h = 24, pad = 2.5;
  const flat = points.length < 2 || points.every((v) => v === 0);
  const max = Math.max(...points, 1);
  const step = (w - pad * 2) / Math.max(points.length - 1, 1);
  const d = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * step).toFixed(1)},${(h - pad - (v / max) * (h - pad * 2)).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={w} height={h} className="flex-shrink-0" aria-hidden>
      {flat ? (
        <line x1={pad} y1={h / 2} x2={w - pad} y2={h / 2}
          stroke="hsl(var(--border))" strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        <path d={d} fill="none" stroke={color} strokeWidth="1.5"
          strokeLinejoin="round" strokeLinecap="round" />
      )}
    </svg>
  );
}

function HeroStat({ label, value, to, tone }: {
  label: string; value: string | number; to?: string; tone?: 'accent' | 'danger';
}) {
  const body = (
    <div className={cn('min-w-0', to && 'group cursor-pointer')}>
      <p className="text-2xs uppercase tracking-wider text-muted-foreground/70 truncate">{label}</p>
      <p className={cn(
        'text-lg font-semibold leading-snug',
        tone === 'accent' && 'text-primary',
        tone === 'danger' && 'text-red-400',
        to && 'group-hover:underline decoration-border underline-offset-4',
      )}>{value}</p>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function Panel({ title, sub, action, children, className, delay = 0 }: {
  title: string; sub?: React.ReactNode; action?: React.ReactNode;
  children: React.ReactNode; className?: string; delay?: number;
}) {
  return (
    <motion.div {...fade(delay)} className={cn('card-warm flex flex-col min-h-0 overflow-hidden', className)}>
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold truncate">{title}</h3>
          {sub}
        </div>
        {action}
      </div>
      {children}
    </motion.div>
  );
}

function PanelLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-primary transition-colors flex-shrink-0">
      {children}
      <ArrowUpRight className="w-3.5 h-3.5" />
    </Link>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <p className="text-xs text-muted-foreground/70">{children}</p>
    </div>
  );
}

// ── Channels rail ─────────────────────────────────────────────────────────────

function ChannelRow({ service, series, msgCount, chatCount, lastSync }: {
  service: ServiceKey; series: number[]; msgCount: number; chatCount: number;
  lastSync?: string;
}) {
  const status = useConnectionStore((s) => s.statuses[service]);
  const syncing = useSyncStore((s) => s.progress[service]?.status === 'running');
  const connected = status?.status === 'connected';

  return (
    <div className={cn(
      'flex items-center gap-3 px-4 py-2 flex-1 min-h-[48px]',
      !connected && 'opacity-45',
    )}>
      <ServiceIcon service={service} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium leading-tight truncate">{SERVICE_THEME[service].label}</p>
          <StatusDot
            status={(status?.status ?? 'disconnected') as 'connected' | 'disconnected' | 'connecting' | 'error'}
            className="w-1.5 h-1.5"
          />
          {syncing && <RefreshCw className="w-3 h-3 text-primary animate-spin" />}
        </div>
        <p className="text-2xs text-muted-foreground truncate">
          {syncing ? 'Syncing…' : lastSync ? `Synced ${timeAgo(lastSync)}` : 'Never synced'}
        </p>
      </div>
      <span className="hidden xl:block flex-shrink-0">
        <Spark points={series} color={CHART_HEX[service]} />
      </span>
      <div className="text-right w-14 flex-shrink-0">
        <p className="text-sm font-semibold tabular-nums leading-tight">{compact.format(msgCount)}</p>
        <p className="text-2xs text-muted-foreground tabular-nums">{compact.format(chatCount)} chats</p>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [days, setDays] = useState(30);

  const { data: statusData, isLoading } = useQuery({
    queryKey: ['status'], queryFn: api.status, refetchInterval: 10000,
  });
  const { data: flowData } = useQuery({
    queryKey: ['metrics', 'messages-over-time', days, 'day'],
    queryFn: () => api.messagesOverTime(days, 'day'),
    refetchInterval: 60000,
  });
  const { data: outboxMetrics } = useQuery({
    queryKey: ['metrics', 'outbox', days],
    queryFn: () => api.outboxActivity(days),
    refetchInterval: 60000,
  });
  const { data: syncData } = useQuery({
    queryKey: ['metrics', 'sync-runs', days],
    queryFn: () => api.syncRuns(days),
    refetchInterval: 60000,
  });
  const { data: usageData } = useQuery({
    queryKey: ['metrics', 'api-usage', days],
    queryFn: () => api.apiUsage(days),
    refetchInterval: 60000,
  });
  const { data: pendingData } = useQuery({
    queryKey: ['outbox', 'pending', 'dashboard'],
    queryFn: () => api.outbox('pending', undefined, { limit: 5 }),
    refetchInterval: 30000,
  });
  const { data: recentData } = useQuery({
    queryKey: ['outbox', 'recent', 'dashboard'],
    queryFn: () => api.outbox(undefined, undefined, { limit: 12 }),
    refetchInterval: 30000,
  });

  const statuses = useConnectionStore((s) => s.statuses);
  const connectedCount = SERVICES.filter((s) => statuses[s]?.status === 'connected').length;

  // Normalize the flow series once: every row gets every service key.
  const flow = useMemo(() => {
    const rows = (flowData?.data ?? []) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      date: String(r.date),
      ...Object.fromEntries(SERVICES.map((s) => [s, Number(r[s] ?? 0)])),
    })) as Array<{ date: string } & Record<ServiceKey, number>>;
  }, [flowData]);

  const perService = useMemo(() => (
    Object.fromEntries(SERVICES.map((s) => [s, flow.map((r) => r[s])])) as Record<ServiceKey, number[]>
  ), [flow]);

  const windowTotal = useMemo(
    () => flow.reduce((acc, r) => acc + SERVICES.reduce((a, s) => a + r[s], 0), 0),
    [flow],
  );

  const usage = useMemo(() => {
    const daily = usageData?.daily ?? [];
    return daily.map((d) => ({
      date: String(d.date),
      requests: (usageData?.keys ?? []).reduce((a, k) => a + Number(d[k] ?? 0), 0),
    }));
  }, [usageData]);
  const usageTotal = usage.reduce((a, d) => a + d.requests, 0);

  const syncTotals = useMemo(() => {
    const rows = syncData?.data ?? [];
    return {
      ok:  rows.reduce((a, r) => a + (r.success ?? 0), 0),
      err: rows.reduce((a, r) => a + (r.error ?? 0), 0),
    };
  }, [syncData]);

  // The server's "approved" bucket includes items that went on to send; split
  // them so the stacked bars partition each day's decisions without overlap.
  const pipeline = useMemo(() => (
    (outboxMetrics?.data ?? []).map((d) => ({
      date: d.date,
      sent: d.sent ?? 0,
      approved: Math.max(0, (d.approved ?? 0) - (d.sent ?? 0)),
      rejected: d.rejected ?? 0,
    }))
  ), [outboxMetrics]);
  const pipelineTotal = pipeline.reduce((a, d) => a + d.sent + d.approved + d.rejected, 0);

  const recentDecisions = useMemo(() => (
    (recentData?.items ?? []).filter((i) => i.status !== 'pending').slice(0, 4)
  ), [recentData]);

  const pending = pendingData?.pendingCount ?? 0;
  const errors = statusData?.errorCount ?? 0;
  const activeChats = Object.values(statusData?.chatCounts ?? {}).reduce((a, b) => a + b, 0);

  // Status headline — the one-line answer to "does anything need me?"
  const headline = errors > 0
    ? { dot: 'status-dot-error', text: `${errors} error${errors === 1 ? '' : 's'} in the log — everything else is flowing` }
    : pending > 0
      ? { dot: 'status-dot-connecting', text: `${pending} message${pending === 1 ? '' : 's'} waiting for your approval` }
      : { dot: 'status-dot-connected', text: 'All quiet — nothing needs your attention' };

  if (isLoading && !statusData) {
    return (
      <div className="p-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-3 gap-3 overflow-y-auto lg:overflow-hidden animate-fade-in">

      {/* Status line + the single time-range filter that scopes every chart below */}
      <motion.div {...fade()} className="flex items-center justify-between gap-3 px-1 flex-shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={cn('status-dot', headline.dot)} />
          <p className="text-sm font-medium truncate">{headline.text}</p>
        </div>
        <RangeSelector value={days} onChange={setDays} />
      </motion.div>

      {/* Hero — message flow through the firewall */}
      <motion.div {...fade(0.03)} className="card-warm flex flex-col md:flex-row md:h-[clamp(195px,26vh,240px)] flex-shrink-0 overflow-hidden">
        <div className="md:w-64 flex-shrink-0 p-4 xl:p-5 flex flex-col gap-3 min-h-0 border-b md:border-b-0 md:border-r border-border/60">
          <div>
            <p className="section-label">Message flow</p>
            <p className="text-[clamp(26px,4.5vh,40px)] font-bold tracking-tight leading-none mt-2">
              {windowTotal.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-1.5">
              messages in the past {days} days
            </p>
          </div>
          <div className="mt-auto grid grid-cols-2 gap-x-4 gap-y-2">
            <HeroStat label="Active chats" value={activeChats.toLocaleString()} />
            <HeroStat label="Channels" value={`${connectedCount}/${SERVICES.length}`} />
            <HeroStat label="Pending" value={pending} to="/outbox" tone={pending > 0 ? 'accent' : undefined} />
            <HeroStat label="Errors" value={errors} to="/audit-log" tone={errors > 0 ? 'danger' : undefined} />
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col p-3 pl-1 min-h-44">
          <Legend
            className="justify-end pr-3 pt-0.5 flex-shrink-0"
            items={SERVICES.map((s) => ({ label: SERVICE_THEME[s].label, color: CHART_HEX[s] }))}
          />
          <div className="flex-1 min-h-0 relative mt-1">
            {windowTotal === 0 && <EmptyNote>No message activity in this window yet</EmptyNote>}
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={flow} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <defs>
                  {SERVICES.map((s) => (
                    <linearGradient key={s} id={`flow-${s}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor={CHART_HEX[s]} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={CHART_HEX[s]} stopOpacity={0.02} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={false}
                  tickFormatter={trimYear} minTickGap={28} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} width={34}
                  tickFormatter={(v: number) => compact.format(v)} allowDecimals={false} />
                <Tooltip content={<ChartTooltip capitalize />} cursor={{ stroke: 'hsl(var(--border))', strokeWidth: 1 }} />
                {SERVICES.map((s) => (
                  <Area key={s} type="monotone" dataKey={s} stackId="flow"
                    name={SERVICE_THEME[s].label}
                    stroke={CHART_HEX[s]} strokeWidth={1.5}
                    fill={`url(#flow-${s})`} dot={false} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </motion.div>

      {/* Control room grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 flex-1 min-h-0">

        {/* Channels */}
        <Panel
          title="Channels"
          className="lg:col-span-3"
          delay={0.06}
          sub={<span className="text-xs text-muted-foreground">{connectedCount}/{SERVICES.length} online</span>}
          action={<PanelLink to="/settings/connections">Manage</PanelLink>}
        >
          <div className="flex-1 min-h-0 flex flex-col divide-y divide-border/50 pb-1 overflow-y-auto">
            {SERVICES.map((s) => (
              <ChannelRow
                key={s}
                service={s}
                series={perService[s] ?? []}
                msgCount={statusData?.messageCounts[s] ?? 0}
                chatCount={statusData?.chatCounts[s] ?? 0}
                lastSync={(statusData?.lastSync[s] as { startedAt?: string } | null)?.startedAt}
              />
            ))}
          </div>
        </Panel>

        {/* Approvals — the firewall's decision queue */}
        <Panel
          title="Approvals"
          className="lg:col-span-5"
          delay={0.09}
          sub={pending > 0
            ? <span className="chip chip-amber">{pending} pending</span>
            : <span className="text-xs text-muted-foreground">queue clear</span>}
          action={<PanelLink to="/outbox">Outbox</PanelLink>}
        >
          <div className="flex-initial min-h-[72px] max-h-[55%] overflow-y-auto">
            {(pendingData?.items?.length ?? 0) > 0 ? (
              <div className="divide-y divide-border/50">
                {pendingData!.items.slice(0, 4).map((item) => (
                  <Link key={item.id} to="/outbox"
                    className="flex items-center gap-3 px-4 py-2 hover:bg-secondary/50 transition-colors">
                    <ServiceIcon service={item.source} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-sm font-medium truncate">
                          {item.recipientName || item.recipientId}
                        </p>
                        <p className="text-2xs text-muted-foreground flex-shrink-0">{timeAgo(item.createdAt)}</p>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{item.content}</p>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2.5 px-4 py-4">
                <ShieldCheck className="w-4 h-4 text-emerald-500/80 flex-shrink-0" />
                <p className="text-xs text-muted-foreground">
                  Nothing waiting — agent write requests will queue here for your sign-off.
                </p>
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto border-t border-border/50">
            <p className="text-2xs uppercase tracking-wider text-muted-foreground/70 px-4 pt-2.5 pb-1">
              Recent decisions
            </p>
            {recentDecisions.length === 0 ? (
              <p className="text-xs text-muted-foreground/70 px-4 py-2">No decisions yet in this window.</p>
            ) : (
              <div className="divide-y divide-border/40">
                {recentDecisions.map((item) => {
                  const meta = item.status === 'rejected' || item.status === 'failed'
                    ? { label: item.status === 'failed' ? 'Failed' : 'Rejected', dot: 'bg-red-500', text: 'text-red-500' }
                    : item.status === 'sent'
                      ? { label: 'Sent', dot: 'bg-primary', text: 'text-primary' }
                      : { label: 'Approved', dot: 'bg-emerald-500', text: 'text-emerald-500' };
                  return (
                    <div key={item.id} className="flex items-center gap-2.5 px-4 py-2">
                      <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', meta.dot)} />
                      <p className="text-xs font-medium flex-shrink-0">{item.recipientName || item.recipientId}</p>
                      <p className="text-xs text-muted-foreground truncate flex-1">{item.content}</p>
                      <span className={cn('text-2xs font-medium flex-shrink-0', meta.text)}>{meta.label}</span>
                      <p className="text-2xs text-muted-foreground flex-shrink-0 whitespace-nowrap">{timeAgo(item.createdAt)}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex-shrink-0 h-[clamp(118px,19vh,160px)] flex flex-col px-3 pt-2.5 pb-2 border-t border-border/50">
            <div className="flex items-center justify-between flex-shrink-0 pl-1 pr-2">
              <p className="text-2xs uppercase tracking-wider text-muted-foreground/70">Decisions per day</p>
              <Legend
                items={[
                  { label: 'Sent',     color: PIPELINE.sent },
                  { label: 'Approved', color: PIPELINE.approved },
                  { label: 'Rejected', color: PIPELINE.rejected },
                ]}
              />
            </div>
            <div className="flex-1 min-h-0 relative mt-1">
              {pipelineTotal === 0 && <EmptyNote>No outbox decisions in this window</EmptyNote>}
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pipeline} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={gridStroke} vertical={false} />
                  <XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={false}
                    tickFormatter={trimYear} minTickGap={28} />
                  <YAxis tick={axisTick} tickLine={false} axisLine={false} width={28}
                    tickFormatter={(v: number) => compact.format(v)} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(var(--secondary) / 0.5)' }} />
                  <Bar dataKey="sent" name="Sent" stackId="pipe" fill={PIPELINE.sent}
                    stroke="hsl(var(--card))" strokeWidth={1} maxBarSize={14} />
                  <Bar dataKey="approved" name="Approved" stackId="pipe" fill={PIPELINE.approved}
                    stroke="hsl(var(--card))" strokeWidth={1} maxBarSize={14} />
                  <Bar dataKey="rejected" name="Rejected" stackId="pipe" fill={PIPELINE.rejected}
                    stroke="hsl(var(--card))" strokeWidth={1} maxBarSize={14} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Panel>

        {/* Sync health + agent traffic */}
        <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
          <Panel
            title="Sync health"
            className="flex-1"
            delay={0.12}
            sub={
              <span className="text-xs text-muted-foreground">
                {syncTotals.ok.toLocaleString()} ok
                {syncTotals.err > 0 && <span className="text-red-400"> · {syncTotals.err} failed</span>}
              </span>
            }
            action={
              <Legend items={[
                { label: 'Success', color: OK_GREEN },
                { label: 'Failed',  color: ERR_RED },
              ]} />
            }
          >
            <div className="flex-1 min-h-20 relative px-3 pb-2">
              {syncTotals.ok + syncTotals.err === 0 && <EmptyNote>No sync runs in this window</EmptyNote>}
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={syncData?.data ?? []} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={gridStroke} vertical={false} />
                  <XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={false}
                    tickFormatter={trimYear} minTickGap={28} />
                  <YAxis tick={axisTick} tickLine={false} axisLine={false} width={28}
                    tickFormatter={(v: number) => compact.format(v)} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(var(--secondary) / 0.5)' }} />
                  <Bar dataKey="success" name="Success" stackId="sync" fill={OK_GREEN}
                    stroke="hsl(var(--card))" strokeWidth={1} maxBarSize={14} />
                  <Bar dataKey="error" name="Failed" stackId="sync" fill={ERR_RED}
                    stroke="hsl(var(--card))" strokeWidth={1} maxBarSize={14} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel
            title="Agent traffic"
            className="flex-1"
            delay={0.15}
            sub={
              <span className="text-xs text-muted-foreground">
                {usageTotal.toLocaleString()} request{usageTotal === 1 ? '' : 's'}
                {(usageData?.keys?.length ?? 0) > 0 && ` · ${usageData!.keys.length} key${usageData!.keys.length === 1 ? '' : 's'}`}
              </span>
            }
            action={<PanelLink to="/settings/agents">Keys</PanelLink>}
          >
            <div className="flex-1 min-h-20 relative px-3 pb-2">
              {usageTotal === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 pointer-events-none px-6 text-center">
                  <KeyRound className="w-4 h-4 text-muted-foreground/50" />
                  <p className="text-xs text-muted-foreground/70">
                    No agent requests yet — create an API key and point your agent at the REST API.
                  </p>
                </div>
              )}
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={usage} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={gridStroke} vertical={false} />
                  <XAxis dataKey="date" tick={axisTick} tickLine={false} axisLine={false}
                    tickFormatter={trimYear} minTickGap={28} />
                  <YAxis tick={axisTick} tickLine={false} axisLine={false} width={28}
                    tickFormatter={(v: number) => compact.format(v)} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(var(--secondary) / 0.5)' }} />
                  <Bar dataKey="requests" name="Requests" fill="hsl(var(--primary) / 0.8)"
                    maxBarSize={12} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
