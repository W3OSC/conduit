import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { RefreshCw, AlertTriangle, Wifi, MessageSquare, Database, TrendingUp, Activity } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { api } from '@/lib/api';
import { useConnectionStore, useSyncStore } from '@/store';
import { StatusDot } from '@/components/shared/StatusDot';
import { ServiceIcon } from '@/components/shared/ServiceBadge';
import { CardSkeleton } from '@/components/shared/Skeleton';
import { cn, timeAgo } from '@/lib/utils';

const SERVICES = ['slack', 'discord', 'telegram', 'twitter', 'gmail'] as const;
const SVC_COLORS: Record<string, string> = {
  slack: '#8B5CF6', discord: '#6366F1', telegram: '#0EA5E9',
  twitter: '#38BDF8', gmail: '#EF4444',
};

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] as [number, number, number, number], delay },
});

const gridColor = 'hsl(20 8% 14%)';
const axisStyle = { fontSize: 10, fill: 'hsl(25 8% 42%)' };

// ── Shared helpers ────────────────────────────────────────────────────────────

function RangeSelector({ value, onChange, options }: {
  value: number; onChange: (v: number) => void; options: number[];
}) {
  return (
    <div className="flex items-center gap-0.5 bg-secondary border border-border rounded-xl p-1">
      {options.map((d) => (
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

const Loader = () => (
  <div className="flex items-center justify-center h-full">
    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
  </div>
);

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ title, value, sub, icon: Icon, amber }: {
  title: string; value: string | number; sub?: string;
  icon: React.ComponentType<{ className?: string }>; amber?: boolean;
}) {
  return (
    <motion.div {...fade()} className={cn(
      'card-warm p-5 flex flex-col justify-between gap-2',
      amber && 'amber-surface border-primary/20 glow-amber-sm',
    )}>
      <div className="flex items-center justify-between">
        <p className="section-label">{title}</p>
        <div className={cn(
          'w-8 h-8 rounded-lg flex items-center justify-center',
          amber ? 'bg-primary/15' : 'bg-secondary',
        )}>
          <Icon className={cn('w-4 h-4', amber ? 'text-primary' : 'text-muted-foreground')} />
        </div>
      </div>
      <p className="text-3xl font-bold text-foreground tracking-tight">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </motion.div>
  );
}

// ── Service card ──────────────────────────────────────────────────────────────

function ServiceCard({ service, avgDuration }: { service: typeof SERVICES[number]; avgDuration?: number | null }) {
  const status = useConnectionStore((s) => s.statuses[service]);
  const syncProgress = useSyncStore((s) => s.progress[service]);
  const { data: statusData } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 10000 });

  const msgCount  = statusData?.messageCounts[service] ?? 0;
  const chatCount = statusData?.chatCounts[service] ?? 0;
  const lastSync  = (statusData?.lastSync[service] as { startedAt?: string } | null)?.startedAt;

  return (
    <motion.div {...fade()} className="card-warm p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <ServiceIcon service={service} size="sm" />
          <span className="text-sm font-semibold capitalize">{service}</span>
        </div>
        <StatusDot
          status={(status?.status ?? 'disconnected') as 'connected'|'disconnected'|'connecting'|'error'}
          className="w-2.5 h-2.5"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 flex-1">
        <div className="bg-secondary/50 rounded-xl p-3 flex flex-col items-center justify-center">
          <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">Messages</p>
          <p className="text-xl font-bold">{msgCount.toLocaleString()}</p>
        </div>
        <div className="bg-secondary/50 rounded-xl p-3 flex flex-col items-center justify-center">
          <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-1">Chats</p>
          <p className="text-xl font-bold">{chatCount}</p>
        </div>
      </div>

      {syncProgress?.status === 'running' && (
        <div className="h-1 bg-warm-700 rounded-full overflow-hidden flex-shrink-0">
          <motion.div
            className="h-full bg-primary rounded-full"
            animate={{ x: ['-100%', '100%'] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }}
          />
        </div>
      )}

      <div className="flex items-center justify-between flex-shrink-0">
        <p className="text-xs text-muted-foreground">
          {lastSync ? timeAgo(lastSync) : 'Never synced'}
        </p>
        {avgDuration != null && (
          <p className="text-xs text-muted-foreground">{avgDuration}s avg</p>
        )}
      </div>
    </motion.div>
  );
}

// ── Chart tooltip ─────────────────────────────────────────────────────────────

const ChartTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !payload) return null;
  return (
    <div className="card-warm border-border/80 p-3 text-xs shadow-warm-lg min-w-[120px]">
      <p className="text-muted-foreground mb-2 font-medium">{String(label)}</p>
      {(payload as Array<{ name: string; value: number; color: string }>).map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-semibold text-foreground">{(p.value ?? 0).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

// ── Chart card wrapper ────────────────────────────────────────────────────────

function ChartCard({ title, subtitle, icon: Icon, children, controls, delay = 0 }: {
  title: string; subtitle?: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  controls?: React.ReactNode;
  delay?: number;
}) {
  return (
    <motion.div {...fade(delay)} className="card-warm p-5 flex flex-col min-h-0">
      <div className="flex items-start justify-between gap-4 mb-4 flex-shrink-0">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {controls}
          {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {children}
      </div>
    </motion.div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [msgDays, setMsgDays]       = useState(30);
  const [msgGran, setMsgGran]       = useState<'day'|'hour'>('day');
  const [syncDays, setSyncDays]     = useState(14);
  const [outboxDays, setOutboxDays] = useState(30);
  const [apiDays, setApiDays]       = useState(30);

  const { data: metricsData } = useQuery({
    queryKey: ['metrics', 'messages-over-time', msgDays, msgGran],
    queryFn: () => api.messagesOverTime(msgDays, msgGran),
    refetchInterval: 60000,
  });

  const { data: syncData } = useQuery({
    queryKey: ['metrics', 'sync-runs', syncDays],
    queryFn: () => api.syncRuns(syncDays),
    refetchInterval: 60000,
  });

  const { data: obData, isLoading: obLoading } = useQuery({
    queryKey: ['metrics', 'outbox', outboxDays],
    queryFn: () => api.outboxActivity(outboxDays),
    refetchInterval: 60000,
  });

  const { data: apiData, isLoading: apiLoading } = useQuery({
    queryKey: ['metrics', 'api', apiDays],
    queryFn: () => api.apiUsage(apiDays),
    refetchInterval: 60000,
  });

  const { data: statusData, isLoading } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 10000,
  });

  const statuses = useConnectionStore((s) => s.statuses);
  const totalMessages = Object.values(statusData?.messageCounts || {}).reduce((a, b) => a + b, 0);
  const connectedCount = Object.values(statuses).filter((s) => s?.status === 'connected').length;

  if (isLoading) {
    return (
      <div className="p-6 grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4 gap-4 animate-fade-in overflow-hidden">

      {/* Stat row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 flex-shrink-0">
        <StatCard title="Total Messages" value={totalMessages.toLocaleString()} icon={MessageSquare} amber sub="Across all services" />
        <StatCard title="Active Chats" value={Object.values(statusData?.chatCounts || {}).reduce((a, b) => a + b, 0)} icon={Database} sub="Synced conversations" />
        <StatCard title="Services Online" value={`${connectedCount}/6`} icon={Wifi} sub={connectedCount === 6 ? 'All connected' : 'Some offline'} />
        <StatCard title="Errors" value={statusData?.errorCount ?? 0} icon={AlertTriangle} sub="In error log" />
      </div>

      {/* Service cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 flex-shrink-0">
        {SERVICES.map((s) => (
          <ServiceCard key={s} service={s} avgDuration={syncData?.avgDuration?.[s] ?? null} />
        ))}
      </div>

      {/* Charts — 2×2 grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 lg:grid-rows-2 gap-4 flex-1 min-h-0">

        {/* Message Volume */}
        <ChartCard
          title="Message Volume"
          subtitle="New messages received per period"
          delay={0.05}
          controls={
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-0.5 bg-secondary border border-border rounded-xl p-1">
                {(['day', 'hour'] as const).map((g) => (
                  <button key={g} onClick={() => setMsgGran(g)}
                    className={cn('px-2.5 py-1 rounded-lg text-xs font-medium transition-all',
                      msgGran === g ? 'bg-background text-foreground shadow-warm-sm' : 'text-muted-foreground hover:text-foreground')}
                  >{g}</button>
                ))}
              </div>
              <RangeSelector value={msgDays} onChange={setMsgDays} options={[7, 14, 30, 90]} />
            </div>
          }
          icon={TrendingUp}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={metricsData?.data || []}>
              <defs>
                {SERVICES.map((s) => (
                  <linearGradient key={s} id={`g-${s}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={SVC_COLORS[s]} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={SVC_COLORS[s]} stopOpacity={0}    />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="date" tick={axisStyle} tickLine={false} axisLine={false} />
              <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={36} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'hsl(20 8% 28%)', strokeWidth: 1 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {SERVICES.map((s) => (
                <Area key={s} type="monotone" dataKey={s} stroke={SVC_COLORS[s]}
                  fill={`url(#g-${s})`} strokeWidth={2} dot={false} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Sync Activity */}
        <ChartCard
          title="Sync Activity"
          subtitle="Successful and failed sync runs"
          delay={0.1}
          controls={<RangeSelector value={syncDays} onChange={setSyncDays} options={[7, 14, 30]} />}
          icon={RefreshCw}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={syncData?.data || []}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="date" tick={axisStyle} tickLine={false} axisLine={false} />
              <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={36} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(20 8% 18% / 0.5)' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="success" fill="#10B981" radius={[3, 3, 0, 0]} name="Success" stackId="a" />
              <Bar dataKey="error"   fill="#EF4444" radius={[3, 3, 0, 0]} name="Error"   stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Outbox Activity */}
        <ChartCard
          title="Outbox Activity"
          subtitle="Messages through the approval pipeline"
          delay={0.15}
          controls={<RangeSelector value={outboxDays} onChange={setOutboxDays} options={[7, 14, 30]} />}
          icon={Activity}
        >
          {obLoading ? <Loader /> : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={obData?.data || []}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="date" tick={axisStyle} tickLine={false} axisLine={false} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={36} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'hsl(20 8% 28%)', strokeWidth: 1 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="received" stroke="#8B5CF6" strokeWidth={2} dot={false} name="Received" />
                <Line type="monotone" dataKey="approved" stroke="#10B981" strokeWidth={2} dot={false} name="Approved" />
                <Line type="monotone" dataKey="rejected" stroke="#EF4444" strokeWidth={2} dot={false} name="Rejected" />
                <Line type="monotone" dataKey="sent"     stroke="#0EA5E9" strokeWidth={2} dot={false} name="Sent" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* API Requests / Day — per-key stacked bars */}
        <ChartCard
          title="API Requests / Day"
          subtitle="Calls by external API consumers"
          delay={0.2}
          controls={<RangeSelector value={apiDays} onChange={setApiDays} options={[7, 14, 30]} />}
          icon={TrendingUp}
        >
          {apiLoading ? <Loader /> : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={apiData?.daily || []}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="date" tick={axisStyle} tickLine={false} axisLine={false} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={36} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(20 8% 18% / 0.5)' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {(apiData?.keys ?? ['Requests']).map((keyName, i) => {
                  const KEY_COLORS = ['#F59E0B', '#8B5CF6', '#0EA5E9', '#10B981', '#EF4444', '#6366F1'];
                  return (
                    <Bar key={keyName} dataKey={keyName} stackId="a"
                      fill={KEY_COLORS[i % KEY_COLORS.length]}
                      radius={i === (apiData?.keys.length ?? 1) - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                      name={keyName}
                    />
                  );
                })}
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

      </div>
    </div>
  );
}
