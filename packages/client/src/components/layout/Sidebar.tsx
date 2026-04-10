import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, MessageSquare, SendHorizonal, Sliders, ScrollText,
  Users, Mail, CalendarDays, Twitter, Inbox, Bot, BookOpen,
  ArrowUpCircle, Copy, Check, RefreshCw,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { useOutboxStore, useConnectionStore, useUnreadStore, useUpdateStore } from '@/store';
import { api } from '@/lib/api';
import { toast } from '@/store';
import { StatusDot } from '@/components/shared/StatusDot';
import { AppIcon } from '@/components/shared/AppIcon';

const SERVICES = [
  { id: 'slack',    label: 'Slack'    },
  { id: 'discord',  label: 'Discord'  },
  { id: 'telegram', label: 'Telegram' },
  { id: 'twitter',  label: 'Twitter'  },
  { id: 'gmail',    label: 'Gmail'    },
  { id: 'calendar', label: 'Calendar' },
  { id: 'obsidian', label: 'Vault'    },
] as const;

const NAV_ITEMS = [
  { to: '/',            icon: Inbox,           label: 'Inbox'      },
  { to: '/dashboard',   icon: LayoutDashboard, label: 'Dashboard'  },
  { to: '/ai',          icon: Bot,             label: 'AI'         },
  { to: '/vault',       icon: BookOpen,        label: 'Vault'      },
  { to: '/chat',        icon: MessageSquare,   label: 'Chat'       },
  { to: '/outbox',      icon: SendHorizonal,   label: 'Outbox',    badge: true },
  { to: '/contacts',    icon: Users,           label: 'Contacts'   },
  { to: '/twitter',     icon: Twitter,         label: 'Twitter'    },
  { to: '/email',       icon: Mail,            label: 'Email'      },
  { to: '/calendar',    icon: CalendarDays,    label: 'Calendar'   },
  { divider: true },
  { to: '/connections', icon: Sliders,         label: 'Settings'   },
  { to: '/audit-log',   icon: ScrollText,      label: 'Audit Log'  },
] as const;

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
    navigator.clipboard.writeText(localCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
          hasUpdate ? 'text-amber-500' : 'text-warm-600',
        )}>
          {version || '…'}
        </span>
        {hasUpdate && (
          <span className="flex items-center gap-0.5 text-[9px] font-medium text-amber-500">
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
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-2 py-1.5 space-y-1.5">
              <p className="text-[10px] text-amber-400 font-medium leading-snug">
                Update available
              </p>

              {isDocker ? (
                /* Docker: one-click pull + instructions */
                <div className="space-y-1">
                  <p className="text-[9px] text-warm-500 leading-snug">
                    Pull changes, then rebuild the image to apply.
                  </p>
                  <button
                    onClick={handleApply}
                    disabled={applying}
                    className={cn(
                      'w-full flex items-center justify-center gap-1',
                      'rounded-md bg-amber-500/15 hover:bg-amber-500/25',
                      'text-[10px] font-medium text-amber-400',
                      'border border-amber-500/20 px-2 py-1',
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
                  <p className="text-[9px] text-warm-500 leading-snug">
                    Run then restart the server:
                  </p>
                  <div className="flex items-center gap-1 rounded-md bg-black/20 border border-white/5 px-1.5 py-1">
                    <code className="flex-1 text-[9px] text-warm-400 font-mono truncate">
                      {localCommand}
                    </code>
                    <button
                      onClick={copyCommand}
                      className="flex-shrink-0 text-warm-500 hover:text-warm-300 transition-colors"
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
  const pendingCount = useOutboxStore((s) => s.pendingCount);
  const statuses = useConnectionStore((s) => s.statuses);
  const totalUnread = useUnreadStore((s) => s.getTotalUnread());

  const connectedCount = SERVICES.filter((s) => statuses[s.id]?.status === 'connected').length;

  return (
    <aside className="flex flex-col w-56 h-full bg-sidebar border-r border-sidebar-border flex-shrink-0 overflow-hidden">
      {/* Wordmark */}
      <div className="flex items-center h-14 px-5 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <AppIcon size="sm" />
          <span className="text-sm font-bold tracking-tight text-foreground">Conduit</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2.5 py-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item, idx) => {
          if ('divider' in item) {
            return <div key={`divider-${idx}`} className="my-1.5 mx-3 h-px bg-sidebar-border" />;
          }

          const { to, icon: Icon, label } = item;
          const badge = 'badge' in item ? (item as { badge?: boolean }).badge : false;
          const isActive = to === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(to);

          return (
            <NavLink key={to} to={to}>
              {() => (
                <div className={cn(
                  'relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium',
                  'transition-all duration-150 group',
                  isActive
                    ? 'bg-amber-500/12 text-amber-400'
                    : 'text-sidebar-foreground hover:bg-white/5 hover:text-foreground',
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
                      'w-[17px] h-[17px] flex-shrink-0 transition-colors',
                      isActive ? 'text-amber-400' : 'text-warm-500 group-hover:text-foreground',
                    )}
                    strokeWidth={isActive ? 2.2 : 1.7}
                  />
                  <span className="flex-1">{label}</span>
                  {badge && to === '/outbox' && pendingCount > 0 && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground"
                    >
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </motion.span>
                  )}
                  {to === '/chat' && totalUnread > 0 && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground"
                    >
                      {totalUnread > 99 ? '99+' : totalUnread}
                    </motion.span>
                  )}
                </div>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Bottom — service status + version */}
      <div className="px-3 py-3 border-t border-sidebar-border space-y-2.5">
        <p className="section-label px-2">Services</p>
        <div className="space-y-0.5">
          {SERVICES.map(({ id, label }) => {
            const status = (statuses[id]?.status ?? 'disconnected') as 'connected' | 'disconnected' | 'connecting' | 'error';
            return (
              <div key={id} className="flex items-center gap-2.5 px-2 py-1">
                <StatusDot status={status} className="w-1.5 h-1.5" />
                <span className={cn('text-xs flex-1', status === 'connected' ? 'text-sidebar-foreground' : 'text-warm-500')}>
                  {label}
                </span>
              </div>
            );
          })}
        </div>
        <div className="px-2 pt-1 flex items-center justify-between">
          <SidebarVersionFooter />
          <span className={cn('text-[10px] font-medium self-start',
            connectedCount === SERVICES.length ? 'text-emerald-500' : connectedCount > 0 ? 'text-amber-500' : 'text-warm-600',
          )}>
            {connectedCount}/{SERVICES.length} online
          </span>
        </div>
      </div>
    </aside>
  );
}
