/**
 * Settings — the firewall's control panel.
 *
 * Layout: a grouped left rail (Channels / Knowledge / Agents / Workspace) with
 * live connection dots, and one focused pane per destination on the right.
 * Every service that used to live inside nested tab bars + accordions gets its
 * own addressable pane at /settings/<id>; the Overview pane is a status
 * directory across all of them.
 */

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutGrid, Server, Bot, Zap, Shield, Bell, Lock, Palette,
  ChevronRight, RefreshCw, AlertTriangle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useConnectionStore, useSyncStore } from '@/store';
import { cn } from '@/lib/utils';
import { SERVICE_THEME } from '@/lib/serviceTheme';
import { ServiceLogo } from '@/components/shared/ServiceBadge';
import { StatusBadge } from '@/components/shared/StatusDot';
import { ServiceAccordion, type Service } from '@/components/settings/ChatServiceAccordions';
import { TwitterAccordion } from '@/components/settings/TwitterSection';
import { GoogleServicesAccordion } from '@/components/settings/GoogleServices';
import { NotionAccordion } from '@/components/settings/NotionSection';
import { ObsidianVaultTab } from '@/components/settings/ObsidianTab';
import { GoogleDriveTab } from '@/components/settings/GoogleDriveTab';
import { SmbSharesTab } from '@/components/settings/SmbTab';
import { AgentAccessTab } from '@/components/settings/AgentAccessTab';
import { InstallTab } from '@/components/settings/InstallTab';
import { PermissionsTab } from '@/components/settings/PermissionsTab';
import { NotificationsTab } from '@/components/settings/NotificationsTab';
import { SecurityTab } from '@/components/settings/SecurityTab';
import { AppearanceTab } from '@/components/settings/AppearanceTab';

// ─────────────────────────────────────────────────────────────────────────────
// Pane registry
// ─────────────────────────────────────────────────────────────────────────────

const PANE_IDS = [
  'overview',
  'slack', 'discord', 'telegram', 'twitter', 'google',
  'notion', 'obsidian', 'drive', 'smb',
  'agents', 'install',
  'permissions', 'notifications', 'security', 'appearance',
] as const;
type PaneId = typeof PANE_IDS[number];

const isPaneId = (v: string | undefined): v is PaneId =>
  !!v && (PANE_IDS as readonly string[]).includes(v);

// Old URLs (two generations of them) keep working.
const LEGACY_TABS: Record<string, PaneId> = {
  connections: 'overview',
  messaging: 'slack',
  'email-calendar': 'google',
  ai: 'agents',
  files: 'drive',
  vault: 'obsidian',
  install: 'install',
  settings: 'permissions',
};

interface PaneMeta {
  title: string;
  sub: string;
  /** Renders the glyph via ServiceLogo + theme tint */
  service?: string;
  /** Fallback glyph for non-service panes */
  icon?: LucideIcon;
  /** Connection-store keys that drive the rail dot + pane status badge */
  statusKeys?: string[];
}

const PANES: Record<PaneId, PaneMeta> = {
  overview:      { title: 'Overview',       sub: 'Everything Conduit can reach, at a glance', icon: LayoutGrid },
  slack:         { title: 'Slack',          sub: 'Workspace channels, DMs, and sync',                        service: 'slack',    statusKeys: ['slack'] },
  discord:       { title: 'Discord',        sub: 'Servers, channels, and DMs',                               service: 'discord',  statusKeys: ['discord'] },
  telegram:      { title: 'Telegram',       sub: 'Chats, groups, and sync',                                  service: 'telegram', statusKeys: ['telegram'] },
  twitter:       { title: 'Twitter / X',    sub: 'DMs via cookie session — no developer account needed',     service: 'twitter',  statusKeys: ['twitter'] },
  google:        { title: 'Google',         sub: 'Gmail, Calendar, and Meet notes across your accounts',     service: 'gmail',    statusKeys: ['gmail', 'calendar'] },
  notion:        { title: 'Notion',         sub: 'Passthrough workspace access — nothing stored locally',    service: 'notion',   statusKeys: ['notion'] },
  obsidian:      { title: 'Obsidian Vault', sub: 'Git-synced vault for reading and editing notes',           service: 'obsidian', statusKeys: ['obsidian'] },
  drive:         { title: 'Google Drive',   sub: 'Browse, read, and edit Drive files with your Google account', service: 'gdrive' },
  smb:           { title: 'Network Shares', sub: 'Windows / Samba shares for file reading and writing',      icon: Server },
  agents:        { title: 'Agent Access',   sub: 'API keys and the REST surface your agents call',           icon: Bot },
  install:       { title: 'Install Skill',  sub: 'Teach any agent the Conduit API in one paste',             icon: Zap },
  permissions:   { title: 'Permissions',    sub: 'What you and each API key can do, per service',            icon: Shield },
  notifications: { title: 'Notifications',  sub: 'Sounds and alerts for each event type',                    icon: Bell },
  security:      { title: 'Security',       sub: 'Password login and two-factor authentication',             icon: Lock },
  appearance:    { title: 'Appearance',     sub: 'Theme, accent, type size, and motion',                     icon: Palette },
};

const NAV_GROUPS: Array<{ label: string | null; items: PaneId[] }> = [
  { label: null,        items: ['overview'] },
  { label: 'Channels',  items: ['slack', 'discord', 'telegram', 'twitter', 'google'] },
  { label: 'Knowledge', items: ['notion', 'obsidian', 'drive', 'smb'] },
  { label: 'Agents',    items: ['agents', 'install'] },
  { label: 'Workspace', items: ['permissions', 'notifications', 'security', 'appearance'] },
];

type ConnState = 'connected' | 'disconnected' | 'connecting' | 'error';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// Small pieces
// ─────────────────────────────────────────────────────────────────────────────

/** Collapse a pane's status keys into one displayable state. */
function useAggStatus(keys?: string[]): { status: ConnState | null; syncing: boolean; error?: string; displayName?: string } {
  const statuses = useConnectionStore((s) => s.statuses);
  const progress = useSyncStore((s) => s.progress);
  if (!keys?.length) return { status: null, syncing: false };
  const sts = keys.map((k) => (statuses[k]?.status ?? 'disconnected') as ConnState);
  const status: ConnState =
    sts.includes('connected') ? 'connected' :
    sts.includes('error') ? 'error' :
    sts.includes('connecting') ? 'connecting' : 'disconnected';
  const syncing = keys.some((k) => progress[k]?.status === 'running');
  const errKey = keys.find((k) => statuses[k]?.error);
  const nameKey = keys.find((k) => statuses[k]?.displayName);
  return {
    status, syncing,
    error: errKey ? statuses[errKey]?.error : undefined,
    displayName: nameKey ? statuses[nameKey]?.displayName : undefined,
  };
}

function StateDot({ status, syncing, className }: { status: ConnState | null; syncing: boolean; className?: string }) {
  if (!status) return null;
  if (syncing) return <RefreshCw className={cn('w-3 h-3 text-primary animate-spin flex-shrink-0', className)} />;
  return (
    <span className={cn(
      'w-1.5 h-1.5 rounded-full flex-shrink-0',
      status === 'connected' && 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]',
      status === 'error' && 'bg-red-400',
      status === 'connecting' && 'bg-primary animate-pulse',
      status === 'disconnected' && 'bg-muted-foreground/25',
      className,
    )} />
  );
}

function PaneGlyph({ id, size = 'md' }: { id: PaneId; size?: 'md' | 'lg' }) {
  const meta = PANES[id];
  const box = size === 'lg' ? 'w-10 h-10 rounded-xl' : 'w-8 h-8 rounded-lg';
  const glyph = size === 'lg' ? 'w-5 h-5' : 'w-4 h-4';
  if (meta.service) {
    const t = SERVICE_THEME[meta.service];
    return (
      <div className={cn(box, 'border flex items-center justify-center flex-shrink-0', t.bg, t.border, t.text)}>
        <ServiceLogo service={meta.service} className={glyph} />
      </div>
    );
  }
  const Icon = meta.icon!;
  return (
    <div className={cn(box, 'border border-border bg-secondary flex items-center justify-center flex-shrink-0')}>
      <Icon className={cn(glyph, 'text-muted-foreground')} strokeWidth={1.8} />
    </div>
  );
}

// ── Rail ─────────────────────────────────────────────────────────────────────

function RailItem({ id, active, onSelect }: { id: PaneId; active: boolean; onSelect: () => void }) {
  const meta = PANES[id];
  const agg = useAggStatus(meta.statusKeys);
  const connected = agg.status === 'connected';
  return (
    <button
      onClick={onSelect}
      className={cn(
        'relative w-full flex items-center gap-2.5 pl-3 pr-2.5 py-[7px] rounded-lg text-[13px] font-medium text-left transition-all duration-150',
        active ? 'bg-secondary text-foreground shadow-warm-sm' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50',
      )}
    >
      {active && (
        <motion.span
          layoutId="settings-rail"
          className="absolute left-0 inset-y-[7px] w-0.5 rounded-r-full bg-primary"
          transition={{ type: 'spring', bounce: 0.2, duration: 0.35 }}
        />
      )}
      {meta.service ? (
        <ServiceLogo
          service={meta.service}
          className={cn('w-4 h-4 flex-shrink-0 transition-colors',
            connected || active ? SERVICE_THEME[meta.service].text : 'text-muted-foreground/50')}
        />
      ) : (() => {
        const Icon = meta.icon!;
        return <Icon className={cn('w-4 h-4 flex-shrink-0', active ? 'text-foreground' : 'text-muted-foreground/60')} strokeWidth={1.8} />;
      })()}
      <span className="flex-1 truncate">{meta.title}</span>
      <StateDot status={agg.status} syncing={agg.syncing} />
    </button>
  );
}

function MobileRailChip({ id, active, onSelect }: { id: PaneId; active: boolean; onSelect: () => void }) {
  const meta = PANES[id];
  const agg = useAggStatus(meta.statusKeys);
  const Icon = meta.icon;
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all flex-shrink-0',
        active ? 'bg-secondary text-foreground shadow-warm-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {meta.service
        ? <ServiceLogo service={meta.service} className={cn('w-3.5 h-3.5', agg.status === 'connected' || active ? SERVICE_THEME[meta.service].text : 'text-muted-foreground/50')} />
        : Icon && <Icon className="w-3.5 h-3.5" strokeWidth={1.8} />}
      {meta.title}
      <StateDot status={agg.status} syncing={agg.syncing} />
    </button>
  );
}

// ── Pane header ──────────────────────────────────────────────────────────────

function PaneHeader({ id, chip }: { id: PaneId; chip?: React.ReactNode }) {
  const meta = PANES[id];
  const agg = useAggStatus(meta.statusKeys);
  return (
    <header className="mb-4">
      <div className="flex items-center gap-3.5">
        <PaneGlyph id={id} size="lg" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-lg font-bold tracking-tight leading-tight">{meta.title}</h1>
            {agg.displayName && (
              <span className="text-xs text-muted-foreground truncate">{agg.displayName}</span>
            )}
          </div>
          <p className="text-[13px] text-muted-foreground mt-0.5">{meta.sub}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {agg.syncing && <RefreshCw className="w-3.5 h-3.5 text-primary animate-spin" />}
          {agg.status && <StatusBadge status={agg.status} />}
          {chip}
        </div>
      </div>
      {agg.error && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{agg.error}</span>
        </p>
      )}
    </header>
  );
}

// ── Overview pane ────────────────────────────────────────────────────────────

const OVERVIEW_CHANNELS: Array<{ id: PaneId; countKey?: string }> = [
  { id: 'slack', countKey: 'slack' },
  { id: 'discord', countKey: 'discord' },
  { id: 'telegram', countKey: 'telegram' },
  { id: 'twitter', countKey: 'twitter' },
  { id: 'google', countKey: 'gmail' },
];

const OVERVIEW_KNOWLEDGE: Array<{ id: PaneId; blurb: string }> = [
  { id: 'notion',   blurb: 'Passthrough API access' },
  { id: 'obsidian', blurb: 'Git-synced note vault' },
  { id: 'drive',    blurb: 'Files on your Google account' },
  { id: 'smb',      blurb: 'Windows / Samba shares' },
];

const OVERVIEW_WORKSPACE: PaneId[] = ['agents', 'install', 'permissions', 'notifications', 'security', 'appearance'];

function ChannelCard({ id, countKey, statusData, onOpen }: {
  id: PaneId; countKey?: string;
  statusData?: Awaited<ReturnType<typeof api.status>>;
  onOpen: () => void;
}) {
  const meta = PANES[id];
  const agg = useAggStatus(meta.statusKeys);
  const msgs = countKey ? statusData?.messageCounts?.[countKey] ?? 0 : 0;
  const chats = countKey ? statusData?.chatCounts?.[countKey] ?? 0 : 0;
  const statusText =
    agg.syncing ? 'Syncing…' :
    agg.status === 'connected' ? (agg.displayName || 'Connected') :
    agg.status === 'error' ? (agg.error || 'Error') :
    agg.status === 'connecting' ? 'Connecting…' : 'Not connected';
  return (
    <button onClick={onOpen} className="card-warm-hover group flex items-center gap-3 p-3.5 text-left w-full min-w-0">
      <PaneGlyph id={id} size="lg" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold truncate">{meta.title}</p>
          <StateDot status={agg.status} syncing={agg.syncing} />
        </div>
        <p className={cn('text-xs truncate mt-0.5',
          agg.status === 'error' ? 'text-red-400' : 'text-muted-foreground')}>
          {statusText}
        </p>
      </div>
      {agg.status === 'connected' && (
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-semibold tabular-nums leading-tight">{compact.format(msgs)}</p>
          <p className="text-2xs text-muted-foreground tabular-nums">{compact.format(chats)} chats</p>
        </div>
      )}
      <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors flex-shrink-0" />
    </button>
  );
}

function KnowledgeCard({ id, blurb, onOpen }: { id: PaneId; blurb: string; onOpen: () => void }) {
  const meta = PANES[id];
  const agg = useAggStatus(meta.statusKeys);
  return (
    <button onClick={onOpen} className="card-warm-hover group flex items-center gap-3 p-3 text-left w-full min-w-0">
      <PaneGlyph id={id} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{meta.title}</p>
          <StateDot status={agg.status} syncing={agg.syncing} />
        </div>
        <p className="text-2xs text-muted-foreground truncate">{blurb}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors flex-shrink-0" />
    </button>
  );
}

function OverviewPane({ statusData, go }: {
  statusData?: Awaited<ReturnType<typeof api.status>>;
  go: (id: PaneId) => void;
}) {
  return (
    <div className="space-y-6">
      <section>
        <p className="section-label mb-2">Channels</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {OVERVIEW_CHANNELS.map(({ id, countKey }) => (
            <ChannelCard key={id} id={id} countKey={countKey} statusData={statusData} onOpen={() => go(id)} />
          ))}
        </div>
      </section>

      <section>
        <p className="section-label mb-2">Knowledge</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {OVERVIEW_KNOWLEDGE.map(({ id, blurb }) => (
            <KnowledgeCard key={id} id={id} blurb={blurb} onOpen={() => go(id)} />
          ))}
        </div>
      </section>

      <section>
        <p className="section-label mb-2">Agents &amp; workspace</p>
        <div className="card-warm overflow-hidden divide-y divide-border/50">
          {OVERVIEW_WORKSPACE.map((id) => {
            const meta = PANES[id];
            const Icon = meta.icon!;
            return (
              <button key={id} onClick={() => go(id)}
                className="group w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-secondary/40 transition-colors">
                <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" strokeWidth={1.8} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{meta.title}</p>
                  <p className="text-2xs text-muted-foreground truncate">{meta.sub}</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors flex-shrink-0" />
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function Connections() {
  const navigate = useNavigate();
  const { tab } = useParams<{ tab: string }>();
  const setAllStatuses = useConnectionStore((s) => s.setAllStatuses);
  const seedFromActiveSyncs = useSyncStore((s) => s.seedFromActiveSyncs);
  const syncProgress = useSyncStore((s) => s.progress);
  const statuses = useConnectionStore((s) => s.statuses);

  // URL is the single source of truth for the active pane.
  const pane: PaneId = isPaneId(tab) ? tab : LEGACY_TABS[tab ?? ''] ?? 'overview';
  const go = (id: PaneId) => navigate(`/settings/${id}`);

  const anyRunning = Object.values(syncProgress).some((p) => p?.status === 'running');

  const { data: connections } = useQuery({
    queryKey: ['connections'],
    queryFn: api.connections,
    refetchInterval: 8000,
  });

  // Page-level status poll — powers the rail dots, overview counts, and every
  // pane's live counters. Fast-polls while any sync is running.
  const { data: statusData } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: anyRunning ? 2000 : 15000,
  });

  // Seed stores so dots/spinners are live for every service, not just open panes.
  useEffect(() => {
    if (statusData?.activeSyncs) seedFromActiveSyncs(statusData.activeSyncs);
  }, [statusData?.activeSyncs, seedFromActiveSyncs]);

  useEffect(() => {
    if (connections) setAllStatuses(connections);
  }, [connections, setAllStatuses]);

  // Fresh pane, fresh scroll.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [pane]);

  const channelKeys = ['slack', 'discord', 'telegram', 'twitter', 'gmail'];
  const onlineCount = channelKeys.filter((k) => statuses[k]?.status === 'connected').length;

  const paneBody = (() => {
    switch (pane) {
      case 'overview':      return <OverviewPane statusData={statusData} go={go} />;
      case 'slack':
      case 'discord':
      case 'telegram':      return <ServiceAccordion service={pane as Service} standalone />;
      case 'twitter':       return <TwitterAccordion standalone />;
      case 'google':        return <GoogleServicesAccordion standalone />;
      case 'notion':        return <NotionAccordion standalone />;
      case 'obsidian':      return <div className="card-warm p-4 sm:p-5"><ObsidianVaultTab /></div>;
      case 'drive':         return <div className="card-warm p-4 sm:p-5"><GoogleDriveTab /></div>;
      case 'smb':           return <div className="card-warm p-4 sm:p-5"><SmbSharesTab /></div>;
      case 'agents':        return <div className="card-warm p-4 sm:p-5"><AgentAccessTab /></div>;
      case 'install':       return <div className="card-warm p-4 sm:p-5"><InstallTab /></div>;
      case 'permissions':   return <div className="card-warm p-4 sm:p-5"><PermissionsTab /></div>;
      case 'notifications': return <div className="card-warm p-4 sm:p-5"><NotificationsTab /></div>;
      case 'security':      return <div className="card-warm p-4 sm:p-5"><SecurityTab /></div>;
      case 'appearance':    return <div className="card-warm p-4 sm:p-5 max-w-xl"><AppearanceTab /></div>;
    }
  })();

  return (
    <div className="h-full flex flex-col lg:flex-row animate-fade-in">

      {/* Mobile pane picker */}
      <div className="lg:hidden flex-shrink-0 border-b border-border/60 overflow-x-auto">
        <div className="flex items-center gap-1 p-2 min-w-max">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label ?? gi} className="flex items-center gap-1">
              {gi > 0 && <div className="w-px h-4 bg-border mx-1 flex-shrink-0" />}
              {group.items.map((id) => (
                <MobileRailChip key={id} id={id} active={pane === id} onSelect={() => go(id)} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Desktop rail */}
      <aside className="hidden lg:flex flex-col w-60 flex-shrink-0 border-r border-border/60 overflow-y-auto px-3 py-4">
        <div className="flex items-baseline justify-between px-3 mb-1">
          <h2 className="text-base font-bold tracking-tight">Settings</h2>
          <span className={cn('text-[10px] font-medium tabular-nums',
            onlineCount === channelKeys.length ? 'text-emerald-500' : onlineCount > 0 ? 'text-primary' : 'text-muted-foreground/50')}>
            {onlineCount}/{channelKeys.length} online
          </span>
        </div>
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label ?? gi}>
            {group.label
              ? <p className="section-label px-3 pt-4 pb-1.5">{group.label}</p>
              : <div className="pt-2" />}
            <div className="space-y-0.5">
              {group.items.map((id) => (
                <RailItem key={id} id={id} active={pane === id} onSelect={() => go(id)} />
              ))}
            </div>
          </div>
        ))}
      </aside>

      {/* Content */}
      <main ref={scrollRef} className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 lg:px-8 py-5 lg:py-7 pb-16">
          <AnimatePresence mode="wait">
            <motion.div
              key={pane}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            >
              <PaneHeader
                id={pane}
                chip={pane === 'overview'
                  ? <span className={cn('chip', onlineCount > 0 ? 'chip-emerald' : 'chip-zinc')}>{onlineCount}/{channelKeys.length} channels online</span>
                  : undefined}
              />
              {paneBody}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
