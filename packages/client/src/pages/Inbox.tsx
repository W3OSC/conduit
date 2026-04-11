/**
 * Inbox — unified command centre.
 *
 * Layout (CSS Grid, fills the full <main> area):
 *
 *   ┌──────────────┬──────────────┐
 *   │              │    Email     │  row 1 — 45fr
 *   │   Messages   ├──────────────┤
 *   │              │   Calendar   │  row 2 — 30fr
 *   ├──────────────┴──────────────┤
 *   │         Twitter             │  row 3 — 25fr
 *   └─────────────────────────────┘
 *
 * Each card is a stable-size flex column. All content areas use
 * overflow-y-auto so the card never grows — only scrolls internally.
 * Skeleton states match the pixel geometry of real content so nothing
 * shifts when data arrives.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare, Mail, CalendarDays, X as Twitter,
  CheckCheck, ChevronRight, Clock, MapPin, Video, Star,
  ExternalLink, AtSign, BellOff,
} from 'lucide-react';
import { api, type GmailMessage, type CalendarEvent, type Tweet, type ChatTreeMap } from '@/lib/api';
import { useConnectionStore, useUnreadStore } from '@/store';
import { ServiceIcon } from '@/components/shared/ServiceBadge';
import { Skeleton } from '@/components/shared/Skeleton';
import { cn, timeAgo, formatDate } from '@/lib/utils';

// ─── Animation ────────────────────────────────────────────────────────────────

const fade = (delay = 0) => ({
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] as number[], delay },
});

// ─── Shared: Card header ──────────────────────────────────────────────────────

function CardHeader({
  icon: Icon,
  title,
  iconClass,
  count,
  linkLabel,
  linkTo,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  iconClass?: string;
  count?: number;
  linkLabel?: string;
  linkTo?: string;
}) {
  const navigate = useNavigate();
  const hasCount = count != null && count > 0;

  return (
    <div className="flex items-center gap-2 h-8 flex-shrink-0 mb-3">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <Icon className={cn('w-4 h-4 flex-shrink-0', iconClass ?? 'text-muted-foreground')} />
        <h2 className="text-sm font-semibold leading-none">{title}</h2>
        {/* Always render badge to reserve space; invisible when empty */}
        <span
          className={cn(
            'chip chip-amber text-[10px] font-bold px-1.5 py-0.5 transition-opacity',
            hasCount ? 'opacity-100' : 'opacity-0 pointer-events-none select-none',
          )}
          aria-hidden={!hasCount}
        >
          {hasCount ? (count > 99 ? '99+' : count) : '0'}
        </span>
      </div>
      {/* Always render link to reserve space; invisible when no link */}
      <button
        onClick={() => linkTo && navigate(linkTo)}
        className={cn(
          'btn-ghost text-xs gap-1 text-muted-foreground hover:text-primary flex-shrink-0 transition-opacity',
          linkLabel && linkTo ? 'opacity-100' : 'opacity-0 pointer-events-none select-none',
        )}
        tabIndex={linkLabel && linkTo ? 0 : -1}
        aria-hidden={!(linkLabel && linkTo)}
      >
        {linkLabel ?? 'Open'} <ChevronRight className="w-3 h-3" />
      </button>
    </div>
  );
}

// ─── Shared: Not connected placeholder ───────────────────────────────────────

function NotConnected({ service, label }: { service: string; label: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full text-muted-foreground">
      <ServiceIcon service={service} size="md" className="opacity-30" />
      <div className="text-center space-y-1">
        <p className="text-xs font-medium text-foreground/50">{label} not connected</p>
        <button
          onClick={() => navigate('/connections')}
          className="btn-ghost text-xs gap-1 text-primary/70 hover:text-primary"
        >
          Connect in Settings <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Section 1: Messages ──────────────────────────────────────────────────────

function ChatRow({
  entry,
  onOpen,
  muted = false,
  mutedIcon = false,
}: {
  entry: {
    chatId: string; source: string; name: string;
    avatarUrl?: string | null; count: number; lastTs?: string;
  };
  onOpen: () => void;
  muted?: boolean;
  mutedIcon?: boolean;
}) {
  const hue = entry.name.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffff, 0) % 360;

  return (
    <button
      onClick={onOpen}
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-left transition-colors',
        'hover:bg-white/[0.04] group',
        !muted && entry.count > 0 && 'border-l-2 border-primary/50',
        muted && 'pl-2.5',
      )}
    >
      {/* Avatar */}
      {entry.avatarUrl ? (
        <img
          src={entry.avatarUrl}
          alt={entry.name}
          className={cn('w-7 h-7 rounded-full object-cover flex-shrink-0', muted && 'opacity-50')}
        />
      ) : (
        <div
          className={cn(
            'w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[11px] font-bold text-white',
            muted && 'opacity-40',
          )}
          style={{ background: `hsl(${hue},52%,38%)` }}
        >
          {entry.name.charAt(0).toUpperCase()}
        </div>
      )}

      {/* Text */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cn('text-xs truncate flex-1', muted ? 'text-muted-foreground/70' : 'font-semibold text-foreground')}>
            {entry.name}
          </span>
          <ServiceIcon
            service={entry.source}
            size="sm"
            className={cn('flex-shrink-0', muted ? 'opacity-20' : 'opacity-60')}
          />
        </div>
        {entry.lastTs && (
          <p className="text-[10px] text-muted-foreground/50 leading-none mt-0.5">
            {timeAgo(entry.lastTs)}
          </p>
        )}
      </div>

      {/* Unread badge / mute indicator — always same width to prevent shift */}
      <div className="w-5 flex-shrink-0 flex justify-end">
        {mutedIcon && entry.count > 0 ? (
          <div className="flex flex-col items-center gap-0.5">
            <BellOff className="w-3 h-3 text-muted-foreground/30" />
            <span className="text-[9px] text-muted-foreground/40 font-medium leading-none">
              {entry.count > 99 ? '99+' : entry.count}
            </span>
          </div>
        ) : entry.count > 0 ? (
          <span className="min-w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center px-1">
            {entry.count > 99 ? '99+' : entry.count}
          </span>
        ) : null}
      </div>
    </button>
  );
}

function MessagesSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 px-2 py-2">
          <Skeleton className="w-7 h-7 rounded-full flex-shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-2.5 w-3/5" />
            <Skeleton className="h-2 w-2/5" />
          </div>
          <Skeleton className="w-4 h-4 rounded-full flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

function SectionDivider({ label, hasAbove }: { label: string; hasAbove: boolean }) {
  return (
    <div className={cn('flex items-center gap-2 py-1', hasAbove && 'mt-1')}>
      {hasAbove && <div className="flex-1 h-px bg-border/30" />}
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 px-1 flex-shrink-0">
        {label}
      </span>
      {hasAbove && <div className="flex-1 h-px bg-border/30" />}
    </div>
  );
}

function InboxMessagesSection() {
  const navigate     = useNavigate();
  const unreadCounts = useUnreadStore((s) => s.unreadCounts);
  const mutedChats   = useUnreadStore((s) => s.mutedChats);
  const markReadOptimistic = useUnreadStore((s) => s.markReadOptimistic);

  const { data: treeData, isLoading } = useQuery({
    queryKey: ['chats'],
    queryFn: api.chats,
    staleTime: 30_000,
  });

  type ChatRow = {
    chatId: string; source: string; name: string;
    avatarUrl?: string | null; count: number; lastTs?: string; isDm: boolean;
  };

  const { unreadEntries, mutedEntries, recentEntries } = useMemo(() => {
    if (!treeData) return { unreadEntries: [], mutedEntries: [], recentEntries: [] };
    const all: ChatRow[] = [];
    const tree = treeData as ChatTreeMap;

    for (const [, svcTree] of Object.entries(tree)) {
      for (const section of svcTree.sections) {
        const isDm = section.type === 'dms' || section.type === 'flat';
        for (const chat of section.chats) {
          const count = unreadCounts[`${svcTree.source}:${chat.id}`] || 0;
          all.push({ chatId: chat.id, source: svcTree.source, name: chat.name, avatarUrl: chat.avatarUrl, count, lastTs: chat.lastTs, isDm });
        }
      }
    }

    // Unread: has messages, NOT muted — needs attention
    const unread = all
      .filter((c) => c.count > 0 && !mutedChats[`${c.source}:${c.chatId}`])
      .sort((a, b) => b.count !== a.count ? b.count - a.count : (b.lastTs || '').localeCompare(a.lastTs || ''));

    // Muted: has unread messages but the chat is muted — shown separately, dimmed
    const muted = all
      .filter((c) => c.count > 0 && mutedChats[`${c.source}:${c.chatId}`])
      .sort((a, b) => b.count !== a.count ? b.count - a.count : (b.lastTs || '').localeCompare(a.lastTs || ''));

    // Recent: no unread, DM-type only, sorted by last message time
    const seenIds = new Set([...unread, ...muted].map((c) => `${c.source}:${c.chatId}`));
    const recent = all
      .filter((c) => c.count === 0 && c.isDm && (c.lastTs || '') !== '')
      .filter((c) => !seenIds.has(`${c.source}:${c.chatId}`))
      .sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''))
      .slice(0, 30);

    return { unreadEntries: unread, mutedEntries: muted, recentEntries: recent };
  }, [treeData, unreadCounts, mutedChats]);

  // Sidebar-badge-equivalent count: only non-muted unread
  const totalUnread = unreadEntries.reduce((s, e) => s + e.count, 0);
  const hasContent  = unreadEntries.length > 0 || mutedEntries.length > 0 || recentEntries.length > 0;

  const openChat = (entry: ChatRow) => {
    markReadOptimistic(entry.source, entry.chatId);
    api.markChatRead(entry.source, entry.chatId).catch(() => {/* best-effort */});
    navigate('/chat', {
      state: { chatId: entry.chatId, source: entry.source, name: entry.name, messageCount: 0 },
    });
  };

  return (
    <motion.div {...fade(0)} className="card-warm p-4 h-full flex flex-col min-h-0">
      <CardHeader
        icon={MessageSquare}
        title="Messages"
        iconClass="text-primary"
        count={totalUnread}
        linkLabel="All chats"
        linkTo="/chat"
      />

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0 -mx-1 px-1">
        {isLoading ? (
          <MessagesSkeleton />
        ) : !hasContent ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <CheckCheck className="w-7 h-7 opacity-20" />
            <p className="text-xs">All caught up</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {/* ── Unread (non-muted) ── */}
            {unreadEntries.map((entry) => (
              <ChatRow
                key={`${entry.source}:${entry.chatId}`}
                entry={entry}
                onOpen={() => openChat(entry)}
              />
            ))}

            {/* ── Muted (unread but silenced) ── */}
            {mutedEntries.length > 0 && (
              <>
                <SectionDivider label="Muted" hasAbove={unreadEntries.length > 0} />
                {mutedEntries.map((entry) => (
                  <ChatRow
                    key={`${entry.source}:${entry.chatId}`}
                    entry={entry}
                    onOpen={() => openChat(entry)}
                    muted
                    mutedIcon
                  />
                ))}
              </>
            )}

            {/* ── Recent (no unread, DM-only) ── */}
            {recentEntries.length > 0 && (
              <>
                <SectionDivider label="Recent" hasAbove={unreadEntries.length > 0 || mutedEntries.length > 0} />
                {recentEntries.map((entry) => (
                  <ChatRow
                    key={`${entry.source}:${entry.chatId}`}
                    entry={entry}
                    onOpen={() => openChat(entry)}
                    muted
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Section 2: Email ─────────────────────────────────────────────────────────

function EmailSkeleton() {
  return (
    <div className="space-y-px">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-start gap-2.5 py-2.5 px-1">
          <Skeleton className="w-3.5 h-3.5 rounded flex-shrink-0 mt-0.5" />
          <div className="flex-1 space-y-1.5">
            <div className="flex justify-between gap-2">
              <Skeleton className="h-2.5 w-2/5" />
              <Skeleton className="h-2 w-10 flex-shrink-0" />
            </div>
            <Skeleton className="h-2.5 w-3/4" />
            <Skeleton className="h-2 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function InboxEmailSection() {
  const navigate = useNavigate();
  const statuses = useConnectionStore((s) => s.statuses);
  const gmailConnected = statuses['gmail']?.status === 'connected';

  const { data, isLoading } = useQuery({
    queryKey: ['inbox-gmail'],
    queryFn: () => api.gmailMessages({ unread: true, limit: 8 }),
    enabled: gmailConnected,
    refetchInterval: 60_000,
  });

  const messages   = data?.messages ?? [];
  const unreadCount = data?.total ?? 0;

  return (
    <motion.div {...fade(0.05)} className="card-warm p-4 h-full flex flex-col min-h-0">
      <CardHeader
        icon={Mail}
        title="Email"
        iconClass="text-red-400"
        count={gmailConnected ? unreadCount : undefined}
        linkLabel={gmailConnected ? 'Open Gmail' : undefined}
        linkTo={gmailConnected ? '/email' : undefined}
      />

      <div className="flex-1 overflow-y-auto min-h-0">
        {!gmailConnected ? (
          <NotConnected service="gmail" label="Gmail" />
        ) : isLoading ? (
          <EmailSkeleton />
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Mail className="w-7 h-7 opacity-20" />
            <p className="text-xs">No unread emails</p>
          </div>
        ) : (
          <div className="divide-y divide-border/20">
            {messages.map((msg: GmailMessage) => (
              <button
                key={msg.gmailId}
                onClick={() => navigate('/email')}
                className="w-full flex items-start gap-2.5 py-2.5 px-1 text-left hover:bg-white/[0.03] transition-colors rounded-lg group"
              >
                {/* Star indicator — fixed width column so text always aligns */}
                <div className="w-3.5 flex-shrink-0 mt-0.5">
                  {msg.isStarred
                    ? <Star className="w-3.5 h-3.5 text-primary fill-primary" />
                    : <div className="w-3.5 h-3.5" />
                  }
                </div>

                <div className="flex-1 min-w-0">
                  {/* Sender + timestamp on one line */}
                  <div className="flex items-baseline gap-2 justify-between mb-0.5">
                    <span className={cn(
                      'text-xs truncate',
                      !msg.isRead ? 'font-semibold text-foreground' : 'text-muted-foreground',
                    )}>
                      {msg.fromName || msg.fromAddress || 'Unknown'}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">
                      {msg.internalDate ? timeAgo(msg.internalDate) : ''}
                    </span>
                  </div>

                  {/* Subject */}
                  <p className={cn(
                    'text-xs truncate leading-snug',
                    !msg.isRead ? 'text-foreground/80' : 'text-muted-foreground/70',
                  )}>
                    {msg.subject || '(no subject)'}
                  </p>

                  {/* Snippet */}
                  <p className="text-[11px] text-muted-foreground/45 truncate leading-snug mt-0.5">
                    {msg.snippet}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Section 3: Calendar ──────────────────────────────────────────────────────

const DAY_LABELS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getDayStrip() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    return { date: d, dateStr: d.toISOString().split('T')[0], isToday: i === 0 };
  });
}

function isRecentlyChanged(event: CalendarEvent) {
  if (!event.updatedAt) return false;
  return Date.now() - new Date(event.updatedAt).getTime() < 24 * 60 * 60 * 1000;
}

function isSoon(event: CalendarEvent) {
  const diff = new Date(event.startTime).getTime() - Date.now();
  return diff > 0 && diff < 2 * 60 * 60 * 1000;
}

function CalendarSkeleton() {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <div className="flex-shrink-0 space-y-1 text-center w-8">
            <Skeleton className="h-2 w-6 mx-auto" />
            <Skeleton className="h-3.5 w-5 mx-auto" />
          </div>
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-2.5 w-3/4" />
            <Skeleton className="h-2 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function InboxCalendarSection() {
  const navigate = useNavigate();
  const statuses = useConnectionStore((s) => s.statuses);
  const calConnected = statuses['calendar']?.status === 'connected';

  const now  = new Date();
  const from = now.toISOString();
  const to   = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, isLoading } = useQuery({
    queryKey: ['inbox-calendar'],
    queryFn: () => api.calendarEvents({ from, to, limit: 50 }),
    enabled: calConnected,
    refetchInterval: 120_000,
  });

  const strip  = getDayStrip();
  const events = (data?.events ?? []) as CalendarEvent[];

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const day = e.startTime.split('T')[0];
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(e);
    }
    return map;
  }, [events]);

  const upcoming = events
    .filter((e) => new Date(e.startTime) >= now)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .slice(0, 8);

  return (
    <motion.div {...fade(0.08)} className="card-warm p-4 h-full flex flex-col min-h-0">
      <CardHeader
        icon={CalendarDays}
        title="Calendar"
        iconClass="text-primary"
        linkLabel={calConnected ? 'Open' : undefined}
        linkTo={calConnected ? '/calendar' : undefined}
      />

      {!calConnected ? (
        <div className="flex-1 flex items-center justify-center">
          <NotConnected service="calendar" label="Google Calendar" />
        </div>
      ) : (
        <>
          {/* 7-day strip — fixed height via explicit h-[76px] per cell */}
          <div className="grid grid-cols-7 gap-1 mb-3 flex-shrink-0">
            {strip.map(({ date, dateStr, isToday }) => {
              const dayEvents = byDay.get(dateStr) || [];
              return (
                <div
                  key={dateStr}
                  className={cn(
                    'h-[76px] rounded-xl p-1.5 flex flex-col items-center gap-0.5 overflow-hidden',
                    isToday
                      ? 'bg-primary/10 border border-primary/25'
                      : 'bg-secondary/40 border border-transparent',
                  )}
                >
                  <span className={cn(
                    'text-[10px] font-medium leading-none',
                    isToday ? 'text-primary' : 'text-muted-foreground/60',
                  )}>
                    {DAY_LABELS[date.getDay()]}
                  </span>
                  <span className={cn(
                    'text-sm font-bold leading-none mt-0.5',
                    isToday ? 'text-primary' : 'text-foreground/80',
                  )}>
                    {date.getDate()}
                  </span>
                  {/* Event pills — capped at 2, container overflow-hidden keeps height stable */}
                  <div className="flex flex-col gap-0.5 w-full mt-1 overflow-hidden">
                    {dayEvents.slice(0, 2).map((e) => (
                      <div
                        key={e.eventId}
                        className={cn(
                          'w-full rounded text-[9px] leading-tight px-1 py-0.5 truncate flex-shrink-0',
                          isRecentlyChanged(e)
                            ? 'bg-primary/20 text-primary'
                            : isSoon(e)
                              ? 'bg-primary/20 text-primary'
                              : 'bg-secondary/80 text-muted-foreground/70',
                        )}
                        title={e.title || ''}
                      >
                        {e.title || '(no title)'}
                      </div>
                    ))}
                    {dayEvents.length > 2 && (
                      <span className="text-[9px] text-muted-foreground/40 text-center leading-none flex-shrink-0">
                        +{dayEvents.length - 2}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Upcoming events — scrollable */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {isLoading ? (
              <CalendarSkeleton />
            ) : upcoming.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-xs text-muted-foreground/50">No upcoming events this week</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {upcoming.map((event) => {
                  const startDate = new Date(event.startTime);
                  const isNew  = isRecentlyChanged(event);
                  const soon   = isSoon(event);
                  return (
                    <button
                      key={event.eventId}
                      onClick={() => navigate('/calendar')}
                      className={cn(
                        'w-full flex items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                        'hover:bg-white/[0.04]',
                        soon && 'bg-primary/5 border border-primary/15',
                      )}
                    >
                      {/* Date column — fixed width */}
                      <div className="flex-shrink-0 w-8 text-center">
                        <p className="text-[9px] text-muted-foreground/50 uppercase leading-none">
                          {MONTH_LABELS[startDate.getMonth()]}
                        </p>
                        <p className="text-sm font-bold leading-tight text-foreground/80">
                          {startDate.getDate()}
                        </p>
                      </div>

                      {/* Event info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold truncate flex-1 text-foreground/90">
                            {event.title || '(no title)'}
                          </span>
                          {isNew  && <span className="chip chip-amber text-[9px] flex-shrink-0 py-0.5 px-1.5">New</span>}
                          {soon   && <span className="chip chip-sky  text-[9px] flex-shrink-0 py-0.5 px-1.5">Soon</span>}
                          {event.meetLink && <Video className="w-3 h-3 text-emerald-400 flex-shrink-0" />}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {!event.allDay && (
                            <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5" />
                              {formatDate(event.startTime, 'HH:mm')}
                              {event.endTime && ` – ${formatDate(event.endTime, 'HH:mm')}`}
                            </span>
                          )}
                          {event.location && (
                            <span className="text-[10px] text-muted-foreground/50 flex items-center gap-1 truncate">
                              <MapPin className="w-2.5 h-2.5 flex-shrink-0" />
                              <span className="truncate">{event.location}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </motion.div>
  );
}

// ─── Section 4: Twitter — horizontal split (Mentions | Latest) ────────────────

function TweetMicroRow({ tweet, onOpen }: { tweet: Tweet; onOpen: () => void }) {
  const hue = (tweet.username || '').split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffff, 0) % 360;

  return (
    <button
      onClick={onOpen}
      className="w-full flex items-start gap-2 py-2 px-2 rounded-xl hover:bg-white/[0.04] transition-colors text-left group"
    >
      {/* Avatar */}
      <div
        className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-white mt-0.5"
        style={{ background: `hsl(${hue},52%,38%)` }}
      >
        {(tweet.name || tweet.username || '?').charAt(0).toUpperCase()}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1 mb-0.5">
          <span className="text-[11px] font-semibold truncate text-foreground/90 leading-none">
            {tweet.name || tweet.username}
          </span>
          <span className="text-[10px] text-muted-foreground/50 leading-none flex-shrink-0">
            @{tweet.username}
          </span>
          {tweet.timestamp > 0 && (
            <span className="text-[10px] text-muted-foreground/40 leading-none flex-shrink-0 ml-auto">
              {timeAgo(new Date(tweet.timestamp * 1000).toISOString())}
            </span>
          )}
        </div>
        <p className="text-[11px] text-foreground/70 leading-relaxed line-clamp-2">
          {tweet.text}
        </p>
      </div>

      {/* External link */}
      <ExternalLink className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary/60 flex-shrink-0 mt-1 transition-colors" />
    </button>
  );
}

function TwitterColumnSkeleton() {
  return (
    <div className="space-y-0.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-start gap-2 py-2 px-2">
          <Skeleton className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5" />
          <div className="flex-1 space-y-1.5">
            <div className="flex gap-2">
              <Skeleton className="h-2.5 w-1/3" />
              <Skeleton className="h-2 w-1/4" />
            </div>
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function InboxTwitterSection() {
  const navigate = useNavigate();
  const statuses = useConnectionStore((s) => s.statuses);
  const twitterConnected = statuses['twitter']?.status === 'connected';

  const { data: mentionsData, isLoading: mentionsLoading } = useQuery({
    queryKey: ['inbox-twitter-mentions'],
    queryFn: () => api.twitterMentions(5),
    enabled: twitterConnected,
    refetchInterval: 120_000,
    staleTime: 15 * 60 * 1000,
  });

  const { data: feedData, isLoading: feedLoading } = useQuery({
    queryKey: ['inbox-twitter-feed'],
    queryFn: () => api.twitterFeed(5),
    enabled: twitterConnected,
    refetchInterval: 120_000,
    staleTime: 15 * 60 * 1000,
  });

  const isLoading = mentionsLoading || feedLoading;
  const mentions  = mentionsData?.tweets ?? [];
  const feed      = feedData?.tweets ?? [];

  return (
    <motion.div {...fade(0.12)} className="card-warm p-4 h-full flex flex-col min-h-0">
      <CardHeader
        icon={Twitter}
        title="Twitter / X"
        iconClass="text-sky-400"
        linkLabel={twitterConnected ? 'Open Twitter' : undefined}
        linkTo={twitterConnected ? '/twitter' : undefined}
      />

      {!twitterConnected ? (
        <div className="flex-1 flex items-center justify-center">
          <NotConnected service="twitter" label="Twitter / X" />
        </div>
      ) : (
        /* Horizontal split — Mentions on left, Latest on right */
        <div className="flex-1 flex gap-0 min-h-0 overflow-hidden">

          {/* ── Mentions column ── */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex items-center gap-1.5 mb-2 px-2 flex-shrink-0">
              <AtSign className="w-3 h-3 text-sky-400" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                Mentions
              </span>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {isLoading ? (
                <TwitterColumnSkeleton />
              ) : mentions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-1.5 text-muted-foreground/50">
                  <AtSign className="w-5 h-5 opacity-20" />
                  <p className="text-[11px]">No mentions</p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {mentions.map((tweet) => (
                    <TweetMicroRow
                      key={tweet.id}
                      tweet={tweet}
                      onOpen={() => navigate('/twitter')}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Vertical divider */}
          <div className="w-px bg-border/30 flex-shrink-0 mx-1" />

          {/* ── Latest feed column ── */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="flex items-center gap-1.5 mb-2 px-2 flex-shrink-0">
              <Twitter className="w-3 h-3 text-sky-400" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                Latest
              </span>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {isLoading ? (
                <TwitterColumnSkeleton />
              ) : feed.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-1.5 text-muted-foreground/50">
                  <Twitter className="w-5 h-5 opacity-20" />
                  <p className="text-[11px]">No recent posts</p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {feed.map((tweet) => (
                    <TweetMicroRow
                      key={tweet.id}
                      tweet={tweet}
                      onOpen={() => navigate('/twitter')}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─── Main Inbox page ──────────────────────────────────────────────────────────

export default function Inbox() {
  return (
    <div
      className="grid gap-3 p-3 h-full"
      style={{
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '45fr 30fr 25fr',
        gridTemplateAreas: `
          "messages email"
          "messages calendar"
          "twitter  twitter"
        `,
      }}
    >
      <div style={{ gridArea: 'messages' }} className="min-h-0 flex flex-col">
        <InboxMessagesSection />
      </div>

      <div style={{ gridArea: 'email' }} className="min-h-0 flex flex-col">
        <InboxEmailSection />
      </div>

      <div style={{ gridArea: 'calendar' }} className="min-h-0 flex flex-col">
        <InboxCalendarSection />
      </div>

      <div style={{ gridArea: 'twitter' }} className="min-h-0 flex flex-col">
        <InboxTwitterSection />
      </div>
    </div>
  );
}
