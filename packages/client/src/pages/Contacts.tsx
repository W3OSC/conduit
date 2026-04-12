import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, X, MessageSquare, ChevronRight, Users,
  Loader2, Hash, AtSign, Phone, Trash2, ExternalLink, Mail,
} from 'lucide-react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { api, type Contact, type ContactMessage, type ChatTreeMap } from '@/lib/api';
import { ServiceIcon } from '@/components/shared/ServiceBadge';
import { Skeleton } from '@/components/shared/Skeleton';
import { cn, timeAgo, formatDate } from '@/lib/utils';
import { toast } from '@/store';

// ─── Google contact helpers ───────────────────────────────────────────────────
// gmail + calendar contacts share the same email address as platformId.
// We merge them into a single "google" display entry — keeping whichever record
// has more data (display name, last activity, etc.) and treating both sources
// as one for the purposes of filtering and the detail panel.

type MergedContact = Contact & { _googleMerged?: boolean };

function mergeGoogleContacts(contacts: Contact[]): MergedContact[] {
  const googleByEmail = new Map<string, MergedContact>();
  const rest: MergedContact[] = [];

  for (const c of contacts) {
    if (c.source === 'gmail' || c.source === 'calendar') {
      const email = c.platformId.toLowerCase();
      const existing = googleByEmail.get(email);
      if (!existing) {
        googleByEmail.set(email, { ...c, source: 'gmail', _googleMerged: true });
      } else {
        // Keep richer display name
        if (!existing.displayName && c.displayName) existing.displayName = c.displayName;
        // Keep most recent activity
        if (c.lastMessageAt && (!existing.lastMessageAt || c.lastMessageAt > existing.lastMessageAt)) {
          existing.lastMessageAt = c.lastMessageAt;
        }
        if (c.firstSeenAt && (!existing.firstSeenAt || c.firstSeenAt < existing.firstSeenAt)) {
          existing.firstSeenAt = c.firstSeenAt;
        }
      }
    } else {
      rest.push(c);
    }
  }

  return [...rest, ...googleByEmail.values()];
}

// ─── Avatar ────────────────────────────────────────────────────────────────────

function ContactAvatar({ contact, size = 10 }: { contact: Contact; size?: number }) {
  const [imgErr, setImgErr] = useState(false);
  const name = contact.displayName || contact.username || contact.platformId;
  const hue = name.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffff, 0) % 360;

  if (contact.avatarUrl && !imgErr) {
    return (
      <img
        src={contact.avatarUrl}
        alt={name}
        onError={() => setImgErr(true)}
        className={cn(`w-${size} h-${size} rounded-full object-cover flex-shrink-0`)}
      />
    );
  }

  return (
    <div
      className={cn(`w-${size} h-${size} rounded-full flex-shrink-0 flex items-center justify-center text-sm font-bold text-white select-none`)}
      style={{ background: `hsl(${hue}, 52%, 40%)` }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// ─── History row ──────────────────────────────────────────────────────────────

function HistoryRow({ msg, source, onOpen }: {
  msg: ContactMessage;
  source: string;
  onOpen: () => void;
}) {
  const isEmail = source === 'gmail' || source === 'calendar';
  return (
    <div className="rounded-xl bg-secondary/40 px-3 py-2.5 space-y-1 group">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn(
            'chip text-[10px] flex-shrink-0',
            isEmail ? 'chip-amber' : msg.context === 'dm' ? 'chip-sky' : 'chip-violet',
          )}>
            {isEmail ? 'Email' : msg.context === 'dm' ? 'DM' : (msg.chatName || 'Group')}
          </span>
          <span className="text-[10px] text-muted-foreground">{timeAgo(msg.timestamp)}</span>
        </div>
        <button
          onClick={onOpen}
          className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10"
          title={isEmail ? 'Open in Email' : 'Open in Chat'}
        >
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>
      <p className="text-xs text-foreground/80 leading-relaxed line-clamp-3">{msg.content || '(no content)'}</p>
    </div>
  );
}

// ─── Contact detail slide-over ────────────────────────────────────────────────

function ContactDetail({ contact, onClose }: { contact: MergedContact; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [openingChat, setOpeningChat] = useState(false);

  // Google contacts = gmail or calendar source
  const isGoogle = contact.source === 'gmail' || contact.source === 'calendar';

  // Always load history on mount — for google contacts query both sources and merge
  const { data: gmailHistory, isLoading: gmailHistoryLoading } = useQuery({
    queryKey: ['contact-history', 'gmail', contact.platformId],
    queryFn: () => api.contactHistory('gmail', contact.platformId, { limit: 50 }),
    enabled: isGoogle,
  });
  const { data: calHistory, isLoading: calHistoryLoading } = useQuery({
    queryKey: ['contact-history', 'calendar', contact.platformId],
    queryFn: () => api.contactHistory('calendar', contact.platformId, { limit: 50 }),
    enabled: isGoogle,
  });
  const { data: regularHistory, isLoading: regularHistoryLoading } = useQuery({
    queryKey: ['contact-history', contact.source, contact.platformId],
    queryFn: () => api.contactHistory(contact.source, contact.platformId, { limit: 50 }),
    enabled: !isGoogle,
  });

  const historyLoading = isGoogle ? (gmailHistoryLoading || calHistoryLoading) : regularHistoryLoading;
  const historyMessages = isGoogle
    ? [...(gmailHistory?.messages ?? []), ...(calHistory?.messages ?? [])]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 50)
    : (regularHistory?.messages ?? []);

  // Chat tree for mutual group name resolution (non-google only)
  const { data: treeData } = useQuery({ queryKey: ['chats'], queryFn: api.chats, staleTime: 60000, enabled: !isGoogle });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      // Delete both gmail and calendar entries for google contacts
      if (isGoogle) {
        await Promise.allSettled([
          api.deleteContact('gmail', contact.platformId),
          api.deleteContact('calendar', contact.platformId),
        ]);
        return;
      }
      return api.deleteContact(contact.source, contact.platformId);
    },
    onSuccess: () => {
      toast({ title: 'Contact removed from local database', variant: 'default' });
      qc.invalidateQueries({ queryKey: ['contacts'] });
      onClose();
    },
    onError: (e: Error) => toast({ title: 'Delete failed', description: e.message, variant: 'destructive' }),
  });

  // Open Email page with this contact pre-searched
  const openInEmail = () => {
    navigate('/email', { state: { search: contact.platformId } });
  };

  // Resolve the DM channel ID then navigate to Chat
  const openInChat = async () => {
    setOpeningChat(true);
    try {
      const result = await api.contactDmChannel(contact.source, contact.platformId);
      navigate('/chat', {
        state: {
          chatId: result.channelId,
          source: contact.source,
          name: contact.displayName || result.channelName || contact.platformId,
          messageCount: 0,
        },
      });
    } catch {
      toast({ title: 'No DM found', description: 'Could not find a DM conversation with this contact', variant: 'destructive' });
    }
    setOpeningChat(false);
  };

  // Navigate directly to a specific group/channel in Chat, optionally to a specific message
  const openInChatAt = (chatId: string, chatName: string, messageId?: string, timestamp?: string) => {
    navigate('/chat', {
      state: {
        chatId,
        source: contact.source,
        name: chatName,
        messageCount: 0,
        ...(messageId ? { scrollToMessageId: messageId, scrollToTimestamp: timestamp } : {}),
      },
    });
  };

  // Resolve mutual group names from the chat tree (non-google only)
  const sharedGroups = useMemo((): Array<{ id: string; name: string }> => {
    if (isGoogle) return [];
    const ids = contact.mutualGroupIds ?? [];
    if (ids.length === 0 || !treeData) return [];
    const tree = (treeData as ChatTreeMap)[contact.source];
    if (!tree) return [];
    const result: Array<{ id: string; name: string }> = [];
    for (const id of ids) {
      let found = false;
      for (const section of tree.sections) {
        const chat = section.chats.find((c) => c.id === id);
        if (chat) { result.push({ id, name: chat.name }); found = true; break; }
      }
      if (!found) result.push({ id, name: id });
    }
    return result;
  }, [contact.mutualGroupIds, treeData, contact.source, isGoogle]);

  const name = contact.displayName || contact.username || contact.platformId;
  const subName = contact.username && contact.username !== contact.displayName ? contact.username : null;

  // Derive lastMessageAt from history if the contact field is blank
  const lastMessageAt = contact.lastMessageAt || (historyMessages[0]?.timestamp ?? null);

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col h-full border-l border-border bg-card"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3">
          <ContactAvatar contact={contact} size={10} />
          <div>
            <h2 className="text-sm font-semibold">{name}</h2>
            {subName && <p className="text-xs text-muted-foreground">{subName}</p>}
          </div>
        </div>
        <button onClick={onClose} className="btn-ghost p-1.5">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Profile */}
        <div className="p-5 space-y-4 border-b border-border">
          {/* Service icon — show gmail for google contacts */}
          <ServiceIcon service={isGoogle ? 'gmail' : contact.source} size="sm" />

          <div className="space-y-2">
            {/* Email address for google contacts */}
            {isGoogle && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Mail className="w-3.5 h-3.5" />
                <span className="truncate">{contact.platformId}</span>
              </div>
            )}
            {contact.phone && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Phone className="w-3.5 h-3.5" />
                <span>{contact.phone}</span>
              </div>
            )}
            {!isGoogle && contact.username && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <AtSign className="w-3.5 h-3.5" />
                <span>{contact.username}</span>
              </div>
            )}
            {contact.bio && (
              <p className="text-xs text-muted-foreground bg-secondary/50 rounded-lg px-3 py-2">
                {contact.bio}
              </p>
            )}
            {contact.statusText && (
              <p className="text-xs text-muted-foreground italic">"{contact.statusText}"</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="bg-secondary/40 rounded-xl p-2.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">First Seen</p>
              <p className="text-xs font-medium">{contact.firstSeenAt ? formatDate(contact.firstSeenAt, 'MMM d, yyyy') : '—'}</p>
            </div>
            <div className="bg-secondary/40 rounded-xl p-2.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Last Active</p>
              <p className="text-xs font-medium">{lastMessageAt ? timeAgo(lastMessageAt) : '—'}</p>
            </div>
          </div>

          {/* Primary action button */}
          {isGoogle ? (
            <button onClick={openInEmail} className="btn-primary text-xs w-full">
              <Mail className="w-3.5 h-3.5" />
              Open in Email
            </button>
          ) : (
            <button onClick={openInChat} disabled={openingChat} className="btn-primary text-xs w-full">
              {openingChat ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
              {openingChat ? 'Opening…' : 'Open in Chat'}
            </button>
          )}

          {/* Shared groups / channels (non-google only) */}
          {sharedGroups.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Shared Groups &amp; Channels
              </p>
              <div className="flex flex-wrap gap-1.5">
                {sharedGroups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => openInChatAt(g.id, g.name)}
                    className="flex items-center gap-1 chip chip-zinc hover:bg-warm-700/80 transition-colors text-xs"
                    title={`Open ${g.name} in Chat`}
                  >
                    <Hash className="w-3 h-3 opacity-60" />
                    <span className="truncate max-w-[140px]">{g.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Message / Email History */}
        <div className="p-5 space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            {isGoogle ? 'Email History' : 'Message History'}
          </p>
          {historyLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : !historyMessages.length ? (
            <p className="text-xs text-muted-foreground text-center py-4">No messages found</p>
          ) : (
            <div className="space-y-2">
              {historyMessages.map((m) => (
                <HistoryRow
                  key={m.id}
                  msg={m}
                  source={m.source}
                  onOpen={isGoogle
                    ? () => navigate('/email', { state: { gmailId: m.messageId, search: contact.platformId } })
                    : () => openInChatAt(m.chatId, m.chatName || m.chatId, m.messageId, m.timestamp)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-border flex-shrink-0">
        <button
          onClick={() => deleteMutation.mutate()}
          disabled={deleteMutation.isPending}
          className="btn-ghost text-xs text-muted-foreground hover:text-red-400 w-full justify-center gap-1.5"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Remove from local database
        </button>
      </div>
    </motion.div>
  );
}

// ─── Contact list item ────────────────────────────────────────────────────────

function ContactRow({ contact, selected, onClick }: {
  contact: MergedContact; selected: boolean; onClick: () => void;
}) {
  const isGoogle = contact.source === 'gmail' || contact.source === 'calendar';
  const name = contact.displayName || contact.username || contact.platformId;
  // For google contacts show the email address as subline; for others show username/status
  const subline = isGoogle
    ? contact.platformId
    : (contact.username !== contact.displayName ? contact.username : contact.statusText);

  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-3 border-b border-border/60 text-left transition-colors',
        selected ? 'bg-primary/8 border-l-2 border-l-primary' : 'hover:bg-white/[0.025] border-l-2 border-l-transparent',
      )}
    >
      <ContactAvatar contact={contact} size={10} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 justify-between">
          <span className={cn('text-sm font-medium truncate', selected && 'text-foreground font-semibold')}>{name}</span>
          {/* Show gmail icon for merged google contacts */}
          <ServiceIcon service={isGoogle ? 'gmail' : contact.source} size="sm" className="flex-shrink-0" />
        </div>
        <div className="flex items-center gap-2 mt-0.5 justify-between">
          <p className="text-xs text-muted-foreground truncate flex-1">{subline ?? ''}</p>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {!isGoogle && contact.messageCount != null && contact.messageCount > 0 && (
              <span className="text-[10px] text-muted-foreground/40 font-mono">
                {contact.messageCount.toLocaleString()}
              </span>
            )}
            {contact.lastMessageAt && (
              <span className="text-[10px] text-muted-foreground/60">{timeAgo(contact.lastMessageAt)}</span>
            )}
          </div>
        </div>
      </div>
    </motion.button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

import { ServiceFilterChip, AllFilterChip } from '@/components/shared/ServiceBadge';

export default function Contacts() {
  const location = useLocation();
  const [search, setSearch]           = useState('');
  // 'google' is a virtual filter that fetches both gmail + calendar
  const [source, setSource]           = useState<string>('all');
  const [criteriaFilter, setCriteria] = useState<string>('');
  const [selected, setSelected]       = useState<MergedContact | null>(null);
  const [page, setPage]               = useState(0);
  const [pendingSelect, setPendingSelect] = useState<{ source: string; platformId: string } | null>(null);
  const LIMIT = 60;

  const { data: connections, isLoading: connectionsLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: api.connections,
    staleTime: 30000,
  });
  const anyConnected = connections ? Object.values(connections).some((s) => s.status === 'connected') : true;

  // Read navigation state from Chat page: { source, platformId }
  useEffect(() => {
    const state = location.state as { source?: string; platformId?: string } | null;
    if (state?.source && state?.platformId) {
      // Treat gmail/calendar nav as 'google'
      const navSource = (state.source === 'gmail' || state.source === 'calendar') ? 'google' : state.source;
      setPendingSelect({ source: state.source, platformId: state.platformId });
      setSource(navSource);
    }
  }, [location.state]);

  // When filtering by 'google', fetch both gmail and calendar, then merge client-side
  const isGoogleFilter = source === 'google';

  const { data: gmailData, isLoading: gmailLoading } = useQuery({
    queryKey: ['contacts', 'gmail', search, criteriaFilter, page],
    queryFn: () => api.contacts({ source: 'gmail', q: search || undefined, limit: LIMIT, offset: page * LIMIT }),
    enabled: isGoogleFilter || source === 'all',
  });
  const { data: calData, isLoading: calLoading } = useQuery({
    queryKey: ['contacts', 'calendar', search, criteriaFilter, page],
    queryFn: () => api.contacts({ source: 'calendar', q: search || undefined, limit: LIMIT, offset: page * LIMIT }),
    enabled: isGoogleFilter || source === 'all',
  });
  const { data: regularData, isLoading: regularLoading } = useQuery({
    queryKey: ['contacts', source, search, criteriaFilter, page],
    queryFn: () => api.contacts({
      source: source === 'all' ? undefined : source,
      q: search || undefined,
      criteria: (criteriaFilter || undefined) as 'dm' | 'owned' | 'small' | 'native' | undefined,
      limit: LIMIT,
      offset: page * LIMIT,
    }),
    enabled: !isGoogleFilter,
  });

  const isLoading = isGoogleFilter ? (gmailLoading || calLoading) : regularLoading;

  // Build merged contact list
  const { contactList, total } = useMemo(() => {
    if (isGoogleFilter) {
      const combined = [
        ...(gmailData?.contacts ?? []),
        ...(calData?.contacts ?? []),
      ];
      const merged = mergeGoogleContacts(combined);
      return { contactList: merged, total: merged.length };
    }

    if (source === 'all') {
      const allContacts = regularData?.contacts ?? [];
      const merged = mergeGoogleContacts(allContacts);
      return { contactList: merged, total: regularData?.total ?? 0 };
    }

    return {
      contactList: (regularData?.contacts ?? []) as MergedContact[],
      total: regularData?.total ?? 0,
    };
  }, [isGoogleFilter, source, gmailData, calData, regularData]);

  // Auto-select contact once list loads (navigated from Chat)
  useEffect(() => {
    if (!pendingSelect || contactList.length === 0) return;
    const match = contactList.find(
      (c) => c.platformId === pendingSelect.platformId &&
             (c.source === pendingSelect.source ||
              ((pendingSelect.source === 'gmail' || pendingSelect.source === 'calendar') && c.source === 'gmail')),
    );
    if (match) {
      setSelected(match);
      setPendingSelect(null);
    }
  }, [contactList, pendingSelect]);

  if (connectionsLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin opacity-40" />
      </div>
    );
  }

  if (!anyConnected && total === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
        <div className="w-20 h-20 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center">
          <Users className="w-10 h-10 opacity-20" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">No services connected</p>
          <p className="text-xs opacity-60 mt-1">Connect a service in <Link to="/settings/connections" className="underline underline-offset-2 hover:text-foreground transition-colors">Settings → Connections</Link> to start syncing contacts</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left panel: list ── */}
      <div className="w-80 flex-shrink-0 flex flex-col border-r border-border bg-card/50">

        {/* Search + filters */}
        <div className="p-3 border-b border-border space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              className="w-full bg-secondary/60 border border-border/60 rounded-xl pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/50"
              placeholder="Search contacts…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </div>
          {/* Source filter — gmail and calendar are combined under 'google' */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <AllFilterChip active={source === 'all'} onClick={() => { setSource('all'); setPage(0); }} />
            {(['slack', 'discord', 'telegram', 'twitter'] as const).map((s) => (
              <ServiceFilterChip key={s} service={s} active={source === s} onClick={() => { setSource(s); setPage(0); }} />
            ))}
            {/* Single Google chip (covers gmail + calendar) */}
            <ServiceFilterChip service="gmail" active={source === 'google'} onClick={() => { setSource('google'); setPage(0); }} />
          </div>
        </div>

        {/* Count */}
        <div className="px-4 py-2 border-b border-border/50">
          <p className="text-xs text-muted-foreground">
            {total.toLocaleString()} contact{total !== 1 ? 's' : ''}
          </p>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-2">
                  <Skeleton className="w-10 h-10 rounded-full flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : contactList.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
              <Users className="w-9 h-9 opacity-20" />
              <p className="text-sm">No contacts found</p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {contactList.map((c) => (
                <ContactRow
                  key={`${c.source}-${c.platformId}`}
                  contact={c}
                  selected={selected?.platformId === c.platformId && selected?.source === c.source}
                  onClick={() => setSelected(c)}
                />
              ))}
            </AnimatePresence>
          )}
        </div>

        {/* Pagination */}
        {total > LIMIT && (
          <div className="flex items-center justify-between px-4 py-2 border-t border-border">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="btn-ghost text-xs disabled:opacity-40">Previous</button>
            <span className="text-xs text-muted-foreground">{page * LIMIT + 1}–{Math.min((page + 1) * LIMIT, total)} of {total}</span>
            <button onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * LIMIT >= total} className="btn-ghost text-xs disabled:opacity-40">Next</button>
          </div>
        )}
      </div>

      {/* ── Right panel: detail or empty ── */}
      <div className="flex-1 min-w-0">
        <AnimatePresence mode="wait">
          {selected ? (
            <ContactDetail
              key={`${selected.source}-${selected.platformId}`}
              contact={selected}
              onClose={() => setSelected(null)}
            />
          ) : (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground"
            >
              <div className="w-20 h-20 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center">
                <Users className="w-10 h-10 opacity-20" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">Select a contact</p>
                <p className="text-xs opacity-60 mt-1">
                  {total > 0
                    ? `${total.toLocaleString()} contacts`
                    : 'No contacts synced yet'}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
