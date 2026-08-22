import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, MessageSquare, SendHorizonal, Sliders, ScrollText,
  Users, Mail, CalendarDays, X as Twitter, Inbox, BookOpen,
  ArrowUpCircle, Copy, Check, RefreshCw,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn, copyToClipboard } from '@/lib/utils';
import { useConnectionStore, useUpdateStore, useSyncStore, useThemeStore } from '@/store';
import { api } from '@/lib/api';
import { toast } from '@/store';
import { AppIcon } from '@/components/shared/AppIcon';
import { ServiceLogo, SERVICE_CONFIG } from '@/components/shared/ServiceBadge';

const SERVICES = [
  { id: 'slack',    label: 'Slack'    },
  { id: 'discord',  label: 'Discord'  },
  { id: 'telegram', label: 'Telegram' },
  { id: 'twitter',  label: 'Twitter'  },
  { id: 'gmail',    label: 'Gmail'    },
  { id: 'calendar', label: 'Calendar' },
  { id: 'notion',   label: 'Notion'   },
  { id: 'obsidian', label: 'Files'    },
] as const;

type SidebarNavItem = {
  to: string;
  icon: typeof Inbox;
  label: string;
  service?: string;
  badge?: boolean;
};

const INBOX_ITEM: SidebarNavItem  = { to: '/',       icon: Inbox,         label: 'Inbox'  };
const OUTBOX_ITEM: SidebarNavItem = { to: '/outbox', icon: SendHorizonal, label: 'Outbox', badge: true };

const MAIN_ITEMS: SidebarNavItem[] = [
  { to: '/files',     icon: BookOpen,        label: 'Files',     service: 'obsidian' },
  { to: '/chat',      icon: MessageSquare,   label: 'Chat',      service: 'slack'    },
  { to: '/twitter',   icon: Twitter,         label: 'Twitter',   service: 'twitter'  },
  { to: '/email',     icon: Mail,            label: 'Email',     service: 'gmail'    },
  { to: '/calendar',  icon: CalendarDays,    label: 'Calendar',  service: 'calendar' },
];

const FOOTER_ITEMS: SidebarNavItem[] = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard'  },
  { to: '/settings',  icon: Sliders,         label: 'Settings'   },
  { to: '/audit-log', icon: ScrollText,      label: 'Audit Log'  },
];

// ── Version / Update footer ───────────────────────────────────────────────────

function SidebarVersionFooter() {
  const updateStore = useUpdateStore();
  const [copied, setCopied] = useState(false);
  const [applying, setApplying] = useState(false);

  // Seed the update store once on mount; refresh every hour.
  // The WS poller also pushes update:available events so the store
  // stays live between fetches.
  useQuery({
    queryKey: ['update-status'],
    queryFn: async () => {
      const status = await api.updateStatus();
      updateStore.set(status);
      return status;
    },
    staleTime: 60 * 60 * 1000,   // 1 hour
    refetchInterval: 60 * 60 * 1000,
    retry: false,
  });

  const { version, hasUpdate, commitsBehind, isDocker } = updateStore;

  const localCommand = 'git pull && npm run build';

  function copyCommand() {
    copyToClipboard(localCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  async function handleApply() {
    setApplying(true);
    try {
      const result = await api.applyUpdate();
      if (result.success) {
        toast({ variant: 'success', title: 'Update pulled', description: result.followUp });
        // Refetch status to reflect new version
        updateStore.set({ hasUpdate: false, commitsBehind: 0 });
      } else {
        toast({ variant: 'destructive', title: 'Update failed', description: result.message });
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'Update failed', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-1.5">
      {/* Version row */}
      <div className="flex items-center gap-1.5">
        <span className={cn(
          'text-[10px] font-mono tabular-nums',
          hasUpdate ? 'text-primary' : 'text-muted-foreground/50',
        )}>
          {version || '…'}
        </span>
        {hasUpdate && (
          <span className="flex items-center gap-0.5 text-[9px] font-medium text-primary">
            <ArrowUpCircle className="w-2.5 h-2.5" />
            {commitsBehind} new
          </span>
        )}
      </div>

      {/* Update banner — only shown when update is available */}
      <AnimatePresence>
        {hasUpdate && (
          <motion.div
            key="update-banner"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="rounded-lg border border-primary/25 bg-primary/8 px-2 py-1.5 space-y-1.5">
              <p className="text-[10px] text-primary font-medium leading-snug">
                Update available
              </p>

              {isDocker ? (
                /* Docker: one-click pull + instructions */
                <div className="space-y-1">
                  <p className="text-[9px] text-muted-foreground/70 leading-snug">
                    Pull changes, then rebuild the image to apply.
                  </p>
                  <button
                    onClick={handleApply}
                    disabled={applying}
                    className={cn(
                      'w-full flex items-center justify-center gap-1',
                      'rounded-md bg-primary/15 hover:bg-primary/25',
                      'text-[10px] font-medium text-primary',
                      'border border-primary/20 px-2 py-1',
                      'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                  >
                    {applying ? (
                      <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                    ) : (
                      <ArrowUpCircle className="w-2.5 h-2.5" />
                    )}
                    {applying ? 'Pulling…' : 'Pull update'}
                  </button>
                </div>
              ) : (
                /* Local: show the command with a copy button */
                <div className="space-y-1">
                  <p className="text-[9px] text-muted-foreground/70 leading-snug">
                    Run then restart the server:
                  </p>
                  <div className="flex items-center gap-1 rounded-md bg-muted border border-border px-1.5 py-1">
                    <code className="flex-1 text-[9px] text-muted-foreground font-mono truncate">
                      {localCommand}
                    </code>
                    <button
                      onClick={copyCommand}
                      className="flex-shrink-0 text-muted-foreground/70 hover:text-foreground transition-colors"
                      title="Copy command"
                    >
                      {copied
                        ? <Check className="w-2.5 h-2.5 text-emerald-400" />
                        : <Copy className="w-2.5 h-2.5" />
                      }
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

export function Sidebar() {
  const location = useLocation();
  // Server-authoritative badge: WS outbox events invalidate ['outbox'], the
  // interval is only a slow fallback. (The old Zustand counter started at 0 on
  // every reload and drifted on missed events.)
  const { data: outboxBadge } = useQuery({
    queryKey: ['outbox', 'badge'],
    queryFn: () => api.outbox(undefined, undefined, { limit: 1 }),
    refetchInterval: 120_000,
  });
  const pendingCount = outboxBadge?.pendingCount ?? 0;
  const statuses = useConnectionStore((s) => s.statuses);
  const syncProgress = useSyncStore((s) => s.progress);
  const sidebarCompact = useThemeStore((s) => s.sidebarCompact);

  const connectedCount = SERVICES.filter((s) => statuses[s.id]?.status === 'connected').length;

  const renderTile = (item: SidebarNavItem, opts: { half?: boolean } = {}) => {
    const { to, icon: Icon, label, service, badge } = item;
    // Dim rather than hide disconnected services — a menu that changes
    // shape as connections flap is disorienting, and hiding the entry
    // made the page's own "not connected" guidance unreachable.
    const dimmed = !!service && statuses[service]?.status !== 'connected';
    const isActive = to === '/'
      ? location.pathname === '/'
      : location.pathname.startsWith(to);

    return (
      <NavLink key={to} to={to} title={sidebarCompact ? label : undefined} className={opts.half ? 'flex-1 min-w-0' : undefined}>
        {() => (
          <div className={cn(
            'relative flex items-center rounded-xl text-sm font-medium',
            'transition-all duration-150 group',
            sidebarCompact
              ? 'justify-center px-2 py-2.5 gap-0'
              : opts.half ? 'justify-center gap-2 px-2 py-2.5' : 'gap-3 px-3 py-2.5',
            isActive
              ? 'bg-primary/12 text-primary'
              : 'text-sidebar-foreground hover:bg-secondary/60 hover:text-foreground',
            dimmed && !isActive && 'opacity-40 hover:opacity-80',
          )}>
            {isActive && (
              <motion.div
                layoutId="sidebar-indicator"
                className="absolute left-0 inset-y-1.5 w-0.5 bg-primary rounded-r-full"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.35 }}
              />
            )}
            <Icon
              className={cn(
                'flex-shrink-0 transition-colors',
                sidebarCompact ? 'w-5 h-5' : 'w-[17px] h-[17px]',
                isActive ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground',
              )}
              strokeWidth={isActive ? 2.2 : 1.7}
            />
            {!sidebarCompact && (
              <span className={cn('truncate', !opts.half && 'flex-1')}>{label}</span>
            )}
            {!sidebarCompact && badge && pendingCount > 0 && (
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className={cn(
                  'flex items-center justify-center rounded-full bg-primary font-bold text-primary-foreground',
                  opts.half
                    ? 'absolute -top-1 -right-1 h-4 min-w-[16px] px-1 text-[9px]'
                    : 'h-5 min-w-[20px] px-1.5 text-[10px]',
                )}
              >
                {pendingCount > 99 ? '99+' : pendingCount}
              </motion.span>
            )}
            {/* Compact mode badges — dot only */}
            {sidebarCompact && badge && pendingCount > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-primary" />
            )}
          </div>
        )}
      </NavLink>
    );
  };

  return (
    <aside className={cn(
      'flex flex-col h-full bg-sidebar border-r border-sidebar-border flex-shrink-0 overflow-hidden transition-all duration-200',
      sidebarCompact ? 'w-14' : 'w-56',
    )}>
      {/* Wordmark */}
      <div className={cn(
        'flex items-center border-b border-sidebar-border',
        sidebarCompact ? 'flex-col justify-center gap-1.5 px-2 py-3' : 'h-14 px-5 justify-between',
      )}>
        <div className="flex items-center gap-2.5">
          <AppIcon size="sm" />
          {!sidebarCompact && <span className="text-sm font-bold tracking-tight text-foreground">Conduit</span>}
        </div>
        <NavLink
          to="/contacts"
          title="Contacts"
          className={cn(
            'flex items-center justify-center rounded-lg p-1.5 transition-colors',
            location.pathname.startsWith('/contacts')
              ? 'bg-primary/12 text-primary'
              : 'text-muted-foreground/70 hover:bg-secondary/60 hover:text-foreground',
          )}
        >
          <Users className="w-[17px] h-[17px]" strokeWidth={1.7} />
        </NavLink>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {sidebarCompact ? (
          <>
            {renderTile(INBOX_ITEM)}
            {renderTile(OUTBOX_ITEM)}
          </>
        ) : (
          <div className="flex gap-1">
            {renderTile(INBOX_ITEM, { half: true })}
            <div className="w-px my-1.5 bg-sidebar-border" />
            {renderTile(OUTBOX_ITEM, { half: true })}
          </div>
        )}
        {MAIN_ITEMS.map((item) => renderTile(item))}
        <div className={cn('my-1.5 h-px bg-sidebar-border', sidebarCompact ? 'mx-1' : 'mx-3')} />
        {FOOTER_ITEMS.map((item) => renderTile(item))}
      </nav>

      {/* Bottom — service status + version */}
      <div className={cn('py-3 border-t border-sidebar-border space-y-2', sidebarCompact ? 'px-1' : 'px-3')}>
        {!sidebarCompact && (
          <div className="flex items-center justify-between px-2">
            <p className="section-label">Connections</p>
            <span className={cn('text-[10px] font-medium',
              connectedCount === SERVICES.length ? 'text-emerald-500' : connectedCount > 0 ? 'text-primary' : 'text-muted-foreground/50',
            )}>
              {connectedCount}/{SERVICES.length}
            </span>
          </div>
        )}

        {/* Logo circles row */}
        <div className={cn('flex flex-wrap gap-1.5', sidebarCompact ? 'justify-center px-0' : 'px-2')}>
          {SERVICES.map(({ id, label }) => {
            const status = (statuses[id]?.status ?? 'disconnected') as 'connected' | 'disconnected' | 'connecting' | 'error';
            const isSyncing = syncProgress[id]?.status === 'running';
            const cfg = SERVICE_CONFIG[id];

            const iconColor =
              status === 'connected'    ? cfg?.text ?? 'text-muted-foreground' :
              status === 'error'        ? 'text-red-400' :
              status === 'connecting'   ? 'text-primary' :
              'text-muted-foreground/50';

            const ringColor =
              status === 'connected'    ? 'ring-emerald-500/50' :
              status === 'error'        ? 'ring-red-500/50' :
              status === 'connecting'   ? 'ring-primary/50' :
              'ring-border';

            const bgColor =
              status === 'connected'    ? (cfg?.bg ?? 'bg-secondary/50') :
              status === 'error'        ? 'bg-red-500/8' :
              status === 'connecting'   ? 'bg-primary/8' :
              'bg-secondary/40';

            const statusLabel =
              status === 'connected'    ? 'Connected' :
              status === 'error'        ? 'Error' :
              status === 'connecting'   ? 'Connecting' :
              'Disconnected';

            return (
              <div
                key={id}
                className="relative flex-shrink-0"
                title={`${label} — ${isSyncing ? 'Syncing…' : statusLabel}`}
              >
                {/* Logo circle */}
                <div className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center ring-1 transition-all duration-300',
                  bgColor,
                  ringColor,
                  status === 'connecting' && 'animate-pulse',
                )}>
                  <ServiceLogo service={id} className={cn('w-3.5 h-3.5 transition-colors duration-300', iconColor)} />
                </div>

                {/* Sync spinner overlay */}
                {isSyncing && (
                  <div className="absolute inset-0 rounded-full pointer-events-none">
                    <div className="w-full h-full rounded-full border-2 border-transparent border-t-primary/80 animate-spin" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {!sidebarCompact && (
          <div className="px-2 pt-0.5">
            <SidebarVersionFooter />
          </div>
        )}
      </div>
    </aside>
  );
}
