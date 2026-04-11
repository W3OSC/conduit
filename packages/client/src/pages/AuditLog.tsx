import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, ChevronRight, ChevronDown, ScrollText } from 'lucide-react';
import { api, type AuditLogItem } from '@/lib/api';
import { ServiceBadge } from '@/components/shared/ServiceBadge';
import { TableSkeleton } from '@/components/shared/Skeleton';
import { cn, timeAgo } from '@/lib/utils';

const ACTION_CHIP: Record<string, string> = {
  read:         'chip chip-sky',
  send_request: 'chip chip-violet',
  approve:      'chip chip-emerald',
  reject:       'chip chip-red',
  send:         'chip chip-emerald',
  connect:      'chip chip-sky',
  disconnect:   'chip chip-zinc',
  key_created:  'chip chip-amber',
  key_revoked:  'chip chip-red',
  test:         'chip chip-sky',
};

function SelectFilter({ value, onChange, placeholder, options }: {
  value: string; onChange: (v: string) => void; placeholder: string;
  options: Array<{ label: string; value: string }>;
}) {
  return (
    <select
      value={value} onChange={(e) => onChange(e.target.value)}
      className="input-warm text-xs py-2 bg-secondary"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function LogRow({ item }: { item: AuditLogItem }) {
  const [open, setOpen] = useState(false);
  const detail = item.detail
    ? (() => { try { return JSON.parse(item.detail); } catch { return item.detail; } })()
    : null;

  return (
    <>
      <motion.tr
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        onClick={() => detail && setOpen(!open)}
        className={cn(
          'border-b border-border transition-colors',
          detail ? 'cursor-pointer hover:bg-secondary/30' : 'hover:bg-secondary/20',
        )}
      >
        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap" title={item.timestamp ?? ''}>
          {timeAgo(item.timestamp)}
        </td>
        <td className="px-4 py-3">
          <span className={cn('chip text-[10px]', ACTION_CHIP[item.action] ?? 'chip chip-zinc')}>
            {item.action.replace(/_/g, ' ')}
          </span>
        </td>
        <td className="px-4 py-3">
          {item.service
            ? <ServiceBadge service={item.service} size="xs" />
            : <span className="text-muted-foreground text-xs">—</span>}
        </td>
        <td className="px-4 py-3">
          <span className={cn(
            'chip text-[10px]',
            item.actor === 'api' ? 'chip-violet' : 'chip-sky',
          )}>
            {item.actor}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
          {item.targetId ?? '—'}
        </td>
        <td className="px-4 py-3">
          {detail
            ? <div className="flex items-center gap-1 text-xs text-muted-foreground">
                {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                details
              </div>
            : <span className="text-muted-foreground text-xs">—</span>}
        </td>
      </motion.tr>
      <AnimatePresence>
        {open && detail && (
          <motion.tr
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="border-b border-border bg-secondary/10"
          >
            <td colSpan={6} className="px-6 py-3">
              <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap leading-relaxed">
                {typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}
              </pre>
            </td>
          </motion.tr>
        )}
      </AnimatePresence>
    </>
  );
}

export default function AuditLog() {
  const [actionFilter, setActionFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', actionFilter, serviceFilter, actorFilter],
    queryFn: () => api.auditLog({ action: actionFilter || undefined, service: serviceFilter || undefined, actor: actorFilter || undefined, limit: 200 }),
    refetchInterval: 15000,
  });

  const items = data?.items || [];

  return (
    <div className="p-4 space-y-4 animate-fade-in overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Audit Log</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{data?.total ?? 0} total events</p>
        </div>
        <button
          onClick={() => window.open('/api/audit-log/export', '_blank')}
          className="btn-secondary text-xs"
        >
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <SelectFilter
          value={actionFilter} onChange={setActionFilter} placeholder="All Actions"
          options={['read','send_request','approve','reject','send','connect','disconnect','key_created','key_revoked','test'].map((a) => ({ label: a.replace(/_/g,' '), value: a }))}
        />
        <SelectFilter
          value={serviceFilter} onChange={setServiceFilter} placeholder="All Services"
          options={['slack','discord','telegram','gmail','calendar','twitter'].map((s) => ({ label: s, value: s }))}
        />
        <SelectFilter
          value={actorFilter} onChange={setActorFilter} placeholder="All Actors"
          options={[{ label: 'UI', value: 'ui' }, { label: 'API', value: 'api' }]}
        />
        {(actionFilter || serviceFilter || actorFilter) && (
          <button onClick={() => { setActionFilter(''); setServiceFilter(''); setActorFilter(''); }}
            className="btn-ghost text-xs text-primary"
          >Clear filters</button>
        )}
      </div>

      {/* Table */}
      <div className="card-warm overflow-hidden">
        {isLoading ? (
          <div className="p-4"><TableSkeleton rows={8} /></div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-3 text-muted-foreground">
            <div className="w-14 h-14 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center">
              <ScrollText className="w-7 h-7 opacity-20" />
            </div>
            <p className="text-sm">No audit log entries</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-secondary/40 border-b border-border">
                {['Time', 'Action', 'Service', 'Actor', 'Target', 'Detail'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => <LogRow key={item.id} item={item} />)}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
