/**
 * NotificationCenter
 *
 * A bell-icon button in the TopBar that opens a dropdown panel showing
 * recent notifications (messages, emails, calendar updates, outbox).
 * Muted chats are excluded from notifications — the WS handler gates those
 * before adding to the store.
 */

import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, MessageSquare, Mail, CalendarDays, SendHorizonal, X, CheckCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useNotificationStore, type AppNotification, type NotificationType } from '@/store';

// ── Icons per notification type ───────────────────────────────────────────────

const TYPE_ICON: Record<NotificationType, React.ComponentType<{ className?: string }>> = {
  message:  MessageSquare,
  email:    Mail,
  calendar: CalendarDays,
  outbox:   SendHorizonal,
};

const TYPE_COLOR: Record<NotificationType, string> = {
  message:  'text-amber-400',
  email:    'text-blue-400',
  calendar: 'text-emerald-400',
  outbox:   'text-purple-400',
};

// ── Relative time helper ───────────────────────────────────────────────────────

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Notification item ─────────────────────────────────────────────────────────

function NotifItem({ n, onDismiss }: { n: AppNotification; onDismiss: (id: string) => void }) {
  const navigate = useNavigate();
  const Icon = TYPE_ICON[n.type];

  const handleClick = () => {
    if (n.source && n.chatId) {
      navigate('/chat', { state: { chatId: n.chatId, source: n.source } });
    } else if (n.type === 'email') {
      navigate('/email');
    } else if (n.type === 'calendar') {
      navigate('/calendar');
    } else if (n.type === 'outbox') {
      navigate('/outbox');
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.15 }}
      className={cn(
        'group relative flex items-start gap-2.5 px-3 py-2.5 cursor-pointer',
        'hover:bg-white/[0.04] transition-colors',
        !n.read && 'border-l-2 border-primary/60 pl-[10px]',
      )}
      onClick={handleClick}
    >
      <div className={cn('mt-0.5 flex-shrink-0', TYPE_COLOR[n.type])}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground/90 truncate">{n.title}</p>
        <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">{n.body}</p>
        <p className="text-[10px] text-muted-foreground/40 mt-1">{relTime(n.timestamp)}</p>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(n.id); }}
        className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5 text-muted-foreground/40 hover:text-foreground"
      >
        <X className="w-3 h-3" />
      </button>
    </motion.div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount   = useNotificationStore((s) => s.unreadCount);
  const markAllRead   = useNotificationStore((s) => s.markAllRead);
  const dismiss       = useNotificationStore((s) => s.dismiss);
  const clear         = useNotificationStore((s) => s.clear);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const handleOpen = () => {
    setOpen((v) => !v);
    if (!open && unreadCount > 0) markAllRead();
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="relative flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground px-1"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </motion.span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 top-10 w-80 max-h-[480px] flex flex-col bg-card border border-border rounded-xl shadow-xl overflow-hidden z-50"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/60 flex-shrink-0">
              <span className="text-xs font-semibold text-foreground">Notifications</span>
              <div className="flex items-center gap-1">
                {notifications.length > 0 && (
                  <>
                    <button
                      onClick={markAllRead}
                      className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
                      title="Mark all read"
                    >
                      <CheckCheck className="w-3 h-3" />
                    </button>
                    <button
                      onClick={clear}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
                      title="Clear all"
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground/40">
                  <Bell className="w-6 h-6" />
                  <p className="text-xs">No notifications</p>
                </div>
              ) : (
                <AnimatePresence initial={false}>
                  {notifications.map((n) => (
                    <NotifItem key={n.id} n={n} onDismiss={dismiss} />
                  ))}
                </AnimatePresence>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
