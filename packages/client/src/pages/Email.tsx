/**
 * Email Inbox page — three-column Gmail-style layout.
 * HTML email bodies rendered in sandboxed iframes (no JS, blocked images by default).
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, RefreshCw, Archive, Trash2, Star, StarOff, Mail, MailOpen,
  Reply, ReplyAll, Forward, Flag, Tag, ChevronRight, Loader2,
  Paperclip, AlertCircle, Send, X, ExternalLink, Image as ImageIcon,
  InboxIcon, AtSign, Inbox,
} from 'lucide-react';
import { api, type GmailMessage, type GmailLabel, type GmailActionParams } from '@/lib/api';
import { Skeleton } from '@/components/shared/Skeleton';
import { cn, timeAgo, formatDate } from '@/lib/utils';
import { toast } from '@/store';
import { useLocation } from 'react-router-dom';

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseLabels(raw: string | null): string[] {
  try { return JSON.parse(raw || '[]') as string[]; } catch { return []; }
}

function parseAddresses(raw: string | null): string[] {
  try { return JSON.parse(raw || '[]') as string[]; } catch { return []; }
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

const SYSTEM_LABELS: Record<string, { name: string; icon: React.ComponentType<{ className?: string }> }> = {
  INBOX:   { name: 'Inbox',   icon: Inbox },
  STARRED: { name: 'Starred', icon: Star },
  SENT:    { name: 'Sent',    icon: Send },
  DRAFTS:  { name: 'Drafts',  icon: Mail },
  SPAM:    { name: 'Spam',    icon: Flag },
  TRASH:   { name: 'Trash',   icon: Trash2 },
};

// ── Sandboxed Email Body Frame ─────────────────────────────────────────────────

function EmailBodyFrame({ html, text }: { html: string; text: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [showImages, setShowImages] = useState(false);
  const [height, setHeight] = useState(400);

  const content = html || `<pre style="white-space:pre-wrap;font-family:sans-serif;padding:16px">${text}</pre>`;

  // Inject CSP and optional image blocking
  const processedHtml = content.replace(
    /<img([^>]*)\ssrc=/gi,
    showImages ? '<img$1 src=' : '<img$1 data-blocked-src=',
  );

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; color: #e8e0d4; background: transparent; word-break: break-word; }
  a { color: #f59e0b; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  blockquote { border-left: 3px solid #f59e0b44; margin: 8px 0; padding-left: 12px; color: #9a8a7a; }
  pre { background: #1a1714; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
  table { max-width: 100%; }
  [data-blocked-src] { display: inline-block; width: 40px; height: 40px; background: #2a2420; border: 1px dashed #4a3f35; border-radius: 4px; }
</style>
</head>
<body>${processedHtml}</body>
</html>`;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(fullHtml);
    doc.close();

    // Adjust height to content
    const adjust = () => {
      if (iframe.contentDocument?.body) {
        setHeight(Math.min(Math.max(iframe.contentDocument.body.scrollHeight + 32, 200), 800));
      }
    };
    setTimeout(adjust, 150);
  }, [fullHtml]);

  return (
    <div className="space-y-2">
      {html && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImages(!showImages)}
            className={cn('chip text-xs', showImages ? 'chip-amber' : 'chip-zinc')}
          >
            <ImageIcon className="w-3 h-3" />
            {showImages ? 'Images shown' : 'Load images'}
          </button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        sandbox="allow-same-origin"
        style={{ height, border: 'none', width: '100%', background: 'transparent' }}
        title="email-body"
      />
    </div>
  );
}

// ── Compose / Reply Modal ──────────────────────────────────────────────────────

interface ComposeModalProps {
  mode: 'compose' | 'reply' | 'reply_all' | 'forward';
  original?: GmailMessage;
  onClose: () => void;
}

function ComposeModal({ mode, original, onClose }: ComposeModalProps) {
  const qc = useQueryClient();
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(() => {
    if (!original) return '';
    const s = original.subject || '';
    if (mode === 'reply' || mode === 'reply_all') return s.startsWith('Re:') ? s : `Re: ${s}`;
    if (mode === 'forward') return s.startsWith('Fwd:') ? s : `Fwd: ${s}`;
    return '';
  });
  const [body, setBody] = useState('');
  const [showCc, setShowCc] = useState(false);

  useEffect(() => {
    if (mode === 'reply' && original?.fromAddress) setTo(original.fromAddress);
    if (mode === 'reply_all' && original) {
      const all = [original.fromAddress, ...parseAddresses(original.toAddresses)].filter(Boolean).join(', ');
      setTo(all);
    }
    if (mode === 'forward') setTo('');
  }, [mode, original]);

  const send = useMutation({
    mutationFn: () => api.gmailAction({
      action: mode,
      messageId: original?.gmailId,
      threadId: original?.threadId,
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      cc: cc ? cc.split(',').map((s) => s.trim()).filter(Boolean) : [],
      subject,
      body,
    }),
    onSuccess: () => {
      toast({ title: 'Added to outbox for approval', variant: 'success' });
      qc.invalidateQueries({ queryKey: ['outbox'] });
      onClose();
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const titles = { compose: 'New Message', reply: 'Reply', reply_all: 'Reply All', forward: 'Forward' };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4">
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20 }}
        className="card-warm w-full max-w-2xl flex flex-col overflow-hidden"
        style={{ maxHeight: '85vh' }}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="text-sm font-semibold">{titles[mode]}</h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground w-8">To</label>
              <input value={to} onChange={(e) => setTo(e.target.value)} className="input-warm flex-1 text-xs py-2" placeholder="recipient@example.com" />
              <button onClick={() => setShowCc(!showCc)} className="btn-ghost text-xs py-1 px-2">Cc</button>
            </div>
            {showCc && (
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-8">Cc</label>
                <input value={cc} onChange={(e) => setCc(e.target.value)} className="input-warm flex-1 text-xs py-2" placeholder="cc@example.com" />
              </div>
            )}
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground w-8">Re</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="input-warm flex-1 text-xs py-2" placeholder="Subject" />
            </div>
          </div>
          <textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message here…"
            rows={12}
            className="input-warm resize-none text-sm w-full"
          />
          {original && (
            <div className="text-xs text-muted-foreground border-l-2 border-border pl-3 space-y-1 mt-2">
              <p className="font-medium">— Original message —</p>
              <p>From: {original.fromName} &lt;{original.fromAddress}&gt;</p>
              <p>Subject: {original.subject}</p>
              <p className="text-muted-foreground/60 italic">{original.snippet}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3.5 border-t border-border">
          <p className="text-xs text-muted-foreground">Will be sent to outbox for approval</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary text-xs">Cancel</button>
            <button onClick={() => send.mutate()} disabled={!to || send.isPending} className="btn-primary text-xs">
              {send.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Send to Outbox
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ── Message Detail ─────────────────────────────────────────────────────────────

function MessageDetail({ message, onClose }: { message: GmailMessage; onClose: () => void }) {
  const qc = useQueryClient();
  const [composeMode, setComposeMode] = useState<'reply' | 'reply_all' | 'forward' | null>(null);
  const [showImages, setShowImages] = useState(false);

  const { data: bodyData, isLoading: bodyLoading } = useQuery({
    queryKey: ['gmail-body', message.gmailId],
    queryFn: () => api.gmailBody(message.gmailId),
    staleTime: 5 * 60 * 1000,
  });

  const action = useMutation({
    mutationFn: (params: GmailActionParams) => api.gmailAction(params),
    onSuccess: (_data, params) => {
      toast({ title: `Action queued: ${params.action}`, variant: 'success' });
      qc.invalidateQueries({ queryKey: ['gmail-messages'] });
    },
    onError: (e: Error) => toast({ title: 'Action failed', description: e.message, variant: 'destructive' }),
  });

  const labels = parseLabels(message.labels);
  const toAddresses = parseAddresses(message.toAddresses);
  const isStarred = message.isStarred;
  const isRead = message.isRead;

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-border flex-shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold leading-tight truncate">{message.subject || '(no subject)'}</h2>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {labels.map((l) => (
                <span key={l} className={cn('chip text-[10px]',
                  l === 'INBOX' ? 'chip-sky' : l === 'UNREAD' ? 'chip-amber' : l === 'STARRED' ? 'chip-amber' : 'chip-zinc',
                )}>{l.toLowerCase()}</span>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5 flex-shrink-0"><X className="w-4 h-4" /></button>
        </div>

        {/* Sender info */}
        <div className="px-6 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{message.fromName || message.fromAddress}</p>
              <p className="text-xs text-muted-foreground">{message.fromAddress}</p>
              {toAddresses.length > 0 && (
                <p className="text-xs text-muted-foreground">To: {toAddresses.slice(0, 3).join(', ')}{toAddresses.length > 3 ? ` +${toAddresses.length - 3}` : ''}</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground flex-shrink-0">{message.internalDate ? formatDate(message.internalDate, 'MMM d, yyyy HH:mm') : ''}</p>
          </div>
        </div>

        {/* Action toolbar */}
        <div className="flex items-center gap-1 px-6 py-2 border-b border-border flex-shrink-0 flex-wrap">
          <button onClick={() => setComposeMode('reply')} className="btn-ghost text-xs gap-1.5"><Reply className="w-3.5 h-3.5" />Reply</button>
          <button onClick={() => setComposeMode('reply_all')} className="btn-ghost text-xs gap-1.5"><ReplyAll className="w-3.5 h-3.5" />Reply All</button>
          <button onClick={() => setComposeMode('forward')} className="btn-ghost text-xs gap-1.5"><Forward className="w-3.5 h-3.5" />Forward</button>
          <div className="w-px h-4 bg-border mx-1" />
          <button onClick={() => action.mutate({ action: 'archive', messageId: message.gmailId })} className="btn-ghost text-xs gap-1.5"><Archive className="w-3.5 h-3.5" />Archive</button>
          <button onClick={() => action.mutate({ action: 'trash', messageId: message.gmailId })} className="btn-ghost text-xs gap-1.5 text-red-400 hover:text-red-300"><Trash2 className="w-3.5 h-3.5" />Trash</button>
          <button onClick={() => action.mutate({ action: 'spam', messageId: message.gmailId })} className="btn-ghost text-xs gap-1.5 text-orange-400 hover:text-orange-300"><Flag className="w-3.5 h-3.5" />Spam</button>
          <button onClick={() => action.mutate({ action: isStarred ? 'unstar' : 'star', messageId: message.gmailId })} className={cn('btn-ghost text-xs gap-1.5', isStarred ? 'text-primary' : '')}>{isStarred ? <StarOff className="w-3.5 h-3.5" /> : <Star className="w-3.5 h-3.5" />}{isStarred ? 'Unstar' : 'Star'}</button>
          <button onClick={() => action.mutate({ action: isRead ? 'mark_unread' : 'mark_read', messageId: message.gmailId })} className="btn-ghost text-xs gap-1.5">{isRead ? <Mail className="w-3.5 h-3.5" /> : <MailOpen className="w-3.5 h-3.5" />}{isRead ? 'Mark Unread' : 'Mark Read'}</button>
          <button onClick={() => action.mutate({ action: 'unsubscribe', messageId: message.gmailId })} className="btn-ghost text-xs gap-1.5 text-muted-foreground/60"><X className="w-3.5 h-3.5" />Unsubscribe</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {bodyLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-4/6" />
              <Skeleton className="h-32 w-full mt-4" />
            </div>
          ) : bodyData ? (
            <EmailBodyFrame html={bodyData.html} text={bodyData.text} />
          ) : (
            <p className="text-sm text-muted-foreground">{message.snippet}</p>
          )}

          {/* Attachments */}
          {bodyData?.attachments && bodyData.attachments.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Attachments</p>
              <div className="flex flex-wrap gap-2">
                {bodyData.attachments.map((a, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs">
                    <Paperclip className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="font-medium">{a.name}</span>
                    <span className="text-muted-foreground">{formatBytes(a.size)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {composeMode && (
          <ComposeModal mode={composeMode} original={message} onClose={() => setComposeMode(null)} />
        )}
      </AnimatePresence>
    </>
  );
}

// ── Message List Item ──────────────────────────────────────────────────────────

function MessageItem({ message, selected, onClick }: { message: GmailMessage; selected: boolean; onClick: () => void }) {
  const isUnread = !message.isRead;
  const labels = parseLabels(message.labels);

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left flex items-start gap-3 px-4 py-3 border-b border-border/60 transition-colors hover:bg-white/[0.025]',
        selected && 'bg-primary/8 border-l-2 border-l-primary',
        !selected && 'border-l-2 border-l-transparent',
      )}
    >
      <div className="flex flex-col items-center gap-1.5 flex-shrink-0 mt-0.5">
        {isUnread && !selected && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />}
        {(!isUnread || selected) && <span className="w-2 h-2" />}
        {message.isStarred && <Star className="w-3.5 h-3.5 text-primary fill-primary" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 mb-0.5">
          <span className={cn('text-sm truncate', isUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/80')}>
            {message.fromName || message.fromAddress || 'Unknown'}
          </span>
          <span className="text-[11px] text-muted-foreground flex-shrink-0">
            {message.internalDate ? timeAgo(message.internalDate) : ''}
          </span>
        </div>
        <p className={cn('text-xs truncate mb-0.5', isUnread ? 'text-foreground/80' : 'text-muted-foreground')}>
          {message.subject || '(no subject)'}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">{message.snippet}</p>
        {message.hasAttachments && <Paperclip className="w-3 h-3 text-muted-foreground/50 mt-0.5" />}
      </div>
    </button>
  );
}

// ── Label Sidebar ──────────────────────────────────────────────────────────────

function LabelSidebar({ activeLabel, onSelect }: { activeLabel: string; onSelect: (label: string) => void }) {
  const { data: labelsData } = useQuery({ queryKey: ['gmail-labels'], queryFn: api.gmailLabels, staleTime: 60000 });

  const systemLabels = Object.entries(SYSTEM_LABELS);
  const customLabels = (labelsData?.labels || []).filter((l) => l.type === 'user');

  return (
    <div className="w-44 flex-shrink-0 border-r border-border bg-card/50 flex flex-col">
      <div className="px-3 py-3 border-b border-border">
        <p className="section-label px-2">Folders</p>
      </div>
      <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
        {systemLabels.map(([id, { name, icon: Icon }]) => (
          <button
            key={id}
            onClick={() => onSelect(id)}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors mx-2',
              activeLabel === id
                ? 'bg-primary/12 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-white/5',
            )}
            style={{ width: 'calc(100% - 16px)' }}
          >
            <Icon className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">{name}</span>
          </button>
        ))}

        {customLabels.length > 0 && (
          <>
            <div className="px-5 pt-3 pb-1">
              <p className="section-label">Labels</p>
            </div>
            {customLabels.map((l) => (
              <button
                key={l.id}
                onClick={() => onSelect(l.id)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors mx-2',
                  activeLabel === l.id
                    ? 'bg-primary/12 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-white/5',
                )}
                style={{ width: 'calc(100% - 16px)' }}
              >
                <Tag className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{l.name}</span>
                {l.messagesUnread ? <span className="ml-auto text-[10px] text-primary font-bold">{l.messagesUnread}</span> : null}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function Email() {
  const qc = useQueryClient();
  const location = useLocation();
  const navState = location.state as { search?: string; gmailId?: string } | null;

  const [activeLabel, setActiveLabel] = useState('INBOX');
  // Pre-fill search from navigation state (e.g. opened from Contacts page)
  const [search, setSearch] = useState<string>(navState?.search ?? '');
  const [selected, setSelected] = useState<GmailMessage | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  // Track whether we've already auto-selected the requested message
  const pendingGmailId = useRef<string | null>(navState?.gmailId ?? null);

  const { data: statusData } = useQuery({ queryKey: ['gmail-status'], queryFn: api.gmailStatus, refetchInterval: 30000 });

  const { data, isLoading } = useQuery({
    queryKey: ['gmail-messages', activeLabel, search],
    queryFn: () => api.gmailMessages({
      label: activeLabel,
      q: search || undefined,
      limit: 100,
    }),
    refetchInterval: 60000,
  });

  const messages = data?.messages || [];

  // Auto-select the specific message requested via navigation state
  useEffect(() => {
    if (!pendingGmailId.current || messages.length === 0) return;
    const match = messages.find((m) => m.gmailId === pendingGmailId.current);
    if (match) {
      setSelected(match);
      pendingGmailId.current = null;
    }
  }, [messages]);

  const syncMutation = useMutation({
    mutationFn: api.gmailSync,
    onSuccess: () => { toast({ title: 'Sync started', variant: 'default' }); qc.invalidateQueries({ queryKey: ['gmail-messages'] }); },
  });

  if (!statusData?.connected) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-3.5rem)] gap-4 text-muted-foreground">
        <div className="w-20 h-20 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center">
          <Mail className="w-10 h-10 opacity-20" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">Gmail not connected</p>
          <p className="text-xs opacity-60 mt-1">Add your Google credentials in Services → Email & Calendar</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Label sidebar */}
      <LabelSidebar activeLabel={activeLabel} onSelect={(l) => { setActiveLabel(l); setSelected(null); }} />

      {/* Message list */}
      <div className="w-80 flex-shrink-0 border-r border-border flex flex-col bg-card/30">
        {/* Toolbar */}
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center gap-2">
            <button onClick={() => setComposeOpen(true)} className="btn-primary text-xs py-1.5 px-3">
              <Mail className="w-3.5 h-3.5" /> Compose
            </button>
            <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} className="btn-secondary text-xs py-1.5 px-3 flex-shrink-0">
              <RefreshCw className={cn('w-3.5 h-3.5', syncMutation.isPending && 'animate-spin')} />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search mail…"
              className="w-full bg-secondary/60 border border-border/60 rounded-xl pl-8 pr-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/50"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex gap-3 p-2">
                  <Skeleton className="w-2 h-2 rounded-full flex-shrink-0 mt-2" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-full" />
                    <Skeleton className="h-2.5 w-2/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
              <InboxIcon className="w-8 h-8 opacity-20" />
              <p className="text-sm">No messages</p>
            </div>
          ) : (
            messages.map((msg) => (
              <MessageItem
                key={msg.gmailId}
                message={msg}
                selected={selected?.gmailId === msg.gmailId}
                onClick={() => setSelected(msg)}
              />
            ))
          )}
        </div>
      </div>

      {/* Message detail */}
      <div className="flex-1 min-w-0 bg-background">
        <AnimatePresence mode="wait">
          {selected ? (
            <motion.div
              key={selected.gmailId}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="h-full"
            >
              <MessageDetail message={selected} onClose={() => setSelected(null)} />
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground"
            >
              <div className="w-20 h-20 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center">
                <Mail className="w-10 h-10 opacity-20" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">Select a message</p>
                <p className="text-xs opacity-60 mt-1">{messages.length.toLocaleString()} messages in {activeLabel.toLowerCase()}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Compose modal */}
      <AnimatePresence>
        {composeOpen && <ComposeModal mode="compose" onClose={() => setComposeOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}
