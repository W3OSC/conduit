import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send, Search, MessageSquare, ArrowDown, ChevronDown, ChevronRight,
  Hash, MessageCircle, Users, Radio, Inbox, X as Twitter, Loader2 as Loader2Chat,
  CheckCheck, ExternalLink, MailOpen, RefreshCw,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type Message, type ChatEntry, type ChatSection, type ServiceTree, type ChatTreeMap, type MessageAttachments, type MessageAttachmentFile, type ChatNavState } from '@/lib/api';
import { useMessageStreamStore, useUnreadStore } from '@/store';
import { ServiceFilterChip, AllFilterChip } from '@/components/shared/ServiceBadge';
import { Skeleton } from '@/components/shared/Skeleton';
import { cn, timeAgo, formatDate, SERVICE_ACCENT } from '@/lib/utils';
import { toast } from '@/store';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isSameDay(a: string, b: string) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function dayLabel(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return formatDate(ts, 'MMMM d, yyyy');
}

function bubbleTimestamp(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return formatDate(ts, 'h:mm a');
  return formatDate(ts, 'MMM d, h:mm a');
}

function stringToHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
  return h % 360;
}

function getSender(msg: Message): string {
  return msg.senderName || msg.authorName || msg.userName || 'Unknown';
}

function getSenderId(msg: Message): string {
  return String(msg.senderId ?? msg.authorId ?? msg.userId ?? getSender(msg));
}

// ─── Service metadata ─────────────────────────────────────────────────────────

const SERVICE_ORDER = ['slack', 'discord', 'telegram', 'twitter'];

const SERVICE_LABEL: Record<string, string> = {
  slack: 'Slack', discord: 'Discord', telegram: 'Telegram', twitter: 'Twitter / X',
};

const SERVICE_COLOR: Record<string, string> = {
  slack: 'text-violet-400', discord: 'text-indigo-400', telegram: 'text-sky-400',
  twitter: 'text-sky-300',
};

// ─── Platform deep-link URL ────────────────────────────────────────────────────

function getPlatformUrl(chat: import('@/lib/api').ChatEntry): string | null {
  switch (chat.source) {
    case 'discord':
      if (chat.guildId) {
        // Server channel: discord.com/channels/{guildId}/{channelId}
        return `https://discord.com/channels/${chat.guildId}/${chat.id}`;
      }
      // DM: discord.com/channels/@me/{channelId}
      return `https://discord.com/channels/@me/${chat.id}`;

    case 'slack':
      // Works without teamId; Slack routes to the user's active workspace
      return `https://slack.com/app_redirect?channel=${chat.id}`;

    case 'telegram': {
      const rawId = Number(chat.id);
      // GramJS encodes supergroup/channel IDs as raw + 1_000_000_000_000
      // t.me/c/ expects the raw MTProto ID without that offset
      if (rawId > 1_000_000_000_000) {
        const channelId = rawId - 1_000_000_000_000;
        const msgId = chat.lastMessageId;
        if (msgId) return `https://t.me/c/${channelId}/${msgId}`;
      }
      // Private DMs by numeric ID: no resolvable t.me link available
      return null;
    }

    case 'twitter':
      return `https://x.com/messages/${chat.id}`;

    default:
      return null;
  }
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────────

interface BreadcrumbSegment {
  label: string;
  key: string;
}

function getBreadcrumbSegments(
  treeData: ChatTreeMap | undefined,
  selected: ChatEntry | null,
): BreadcrumbSegment[] {
  if (!selected || !treeData) return [];

  const tree = treeData[selected.source];
  if (!tree) return [];

  const platformLabel = SERVICE_LABEL[selected.source] || selected.source;

  // Find which section contains this chat
  for (const section of tree.sections) {
    const found = section.chats.find((c) => c.id === selected.id);
    if (found) {
      return [
        { label: platformLabel, key: 'platform' },
        { label: section.label, key: 'section' },
        { label: selected.name, key: 'chat' },
      ];
    }
    // Check nested children (future-proofing)
    if (section.children) {
      for (const child of section.children) {
        const foundInChild = child.chats.find((c) => c.id === selected.id);
        if (foundInChild) {
          return [
            { label: platformLabel, key: 'platform' },
            { label: section.label, key: 'section' },
            { label: child.label, key: 'subsection' },
            { label: selected.name, key: 'chat' },
          ];
        }
      }
    }
  }

  // Fallback: just platform + chat name (e.g. for deep-link nav from Contacts)
  return [
    { label: platformLabel, key: 'platform' },
    { label: selected.name, key: 'chat' },
  ];
}

function ChatBreadcrumb({
  treeData,
  selected,
  serviceColor,
}: {
  treeData: ChatTreeMap | undefined;
  selected: ChatEntry | null;
  serviceColor: string;
}) {
  const segments = getBreadcrumbSegments(treeData, selected);
  if (segments.length === 0) return null;

  return (
    <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50 min-w-0 overflow-hidden">
      {segments.map((seg, i) => (
        <span key={seg.key} className="flex items-center gap-1 min-w-0">
          {i > 0 && <span className="flex-shrink-0 opacity-40">›</span>}
          <span
            className={cn(
              'truncate',
              i === 0 && serviceColor,
              i === segments.length - 1 && 'text-muted-foreground/70 font-medium',
            )}
          >
            {seg.label}
          </span>
        </span>
      ))}
    </div>
  );
}

// ─── Section icon ─────────────────────────────────────────────────────────────

function SectionIcon({ type, source }: { type: ChatSection['type']; source: string }) {
  if (type === 'dms') {
    if (source === 'twitter') return <Twitter className="w-3.5 h-3.5" />;
    return <MessageCircle className="w-3.5 h-3.5" />;
  }
  if (type === 'server') return <Users className="w-3.5 h-3.5" />;
  if (type === 'channels') return <Hash className="w-3.5 h-3.5" />;
  return <Inbox className="w-3.5 h-3.5" />;
}

// ─── Chat entry icon ──────────────────────────────────────────────────────────

function EntryAvatar({ type, name, avatarUrl }: { type: ChatSection['type']; name: string; avatarUrl?: string | null }) {
  const [imgErr, setImgErr] = useState(false);

  if (type === 'dms') {
    if (avatarUrl && !imgErr) {
      return (
        <img
          src={avatarUrl}
          alt={name}
          onError={() => setImgErr(true)}
          className="w-6 h-6 rounded-full flex-shrink-0 object-cover"
        />
      );
    }
    return (
      <div
        className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-white"
        style={{ background: `hsl(${stringToHue(name)},52%,38%)` }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
    );
  }
  // Channel-style icon
  return <Hash className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />;
}

// ─── Avatar (for message bubbles) ────────────────────────────────────────────

function Avatar({ msg, size = 8 }: { msg: Message; size?: number }) {
  const [imgErr, setImgErr] = useState(false);
  const name = getSender(msg);
  const hue = stringToHue(getSenderId(msg));
  const sz = `w-${size} h-${size}`;

  if (msg.avatarUrl && !imgErr) {
    return (
      <img
        src={msg.avatarUrl}
        alt={name}
        onError={() => setImgErr(true)}
        className={cn(sz, 'rounded-full flex-shrink-0 object-cover')}
        title={name}
      />
    );
  }

  return (
    <div
      className={cn(sz, 'rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold text-white select-none')}
      style={{ background: `hsl(${hue},52%,40%)` }}
      title={name}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// ─── Message content ──────────────────────────────────────────────────────────

function MessageContent({ content, source, isMe }: { content: string; source: string; isMe: boolean }) {
  const hasMarkdown = /[*_`\[#>~]|https?:\/\//.test(content);

  if (!hasMarkdown) {
    const parts = content.split(/(@\S+)/g);
    return (
      <p className={cn('text-sm leading-relaxed break-words whitespace-pre-wrap', isMe ? 'text-primary-foreground/95' : 'text-foreground/90')}>
        {parts.map((part, i) =>
          part.startsWith('@') ? (
            <span key={i} className={cn('font-semibold rounded px-0.5', isMe ? 'text-primary-foreground' : (SERVICE_ACCENT[source] || 'text-primary'))}>
              {part}
            </span>
          ) : part,
        )}
      </p>
    );
  }

  return (
    <div className={cn(
      'prose prose-sm max-w-none',
      'prose-p:my-0.5 prose-p:leading-relaxed prose-code:rounded prose-code:text-xs prose-code:font-mono',
      'prose-pre:rounded-lg prose-pre:p-3 prose-pre:text-xs prose-pre:overflow-x-auto',
      'prose-blockquote:border-l-2 prose-blockquote:pl-3 prose-blockquote:not-italic',
      'prose-ul:my-1 prose-ol:my-1 prose-li:my-0',
      isMe
        ? 'prose-invert prose-a:text-primary-foreground/80 prose-code:bg-black/20 prose-pre:bg-black/20 prose-strong:text-primary-foreground prose-blockquote:border-primary-foreground/40 prose-blockquote:text-primary-foreground/60'
        : 'prose-invert prose-a:text-primary prose-code:bg-secondary prose-pre:bg-secondary prose-strong:text-foreground prose-blockquote:border-primary/40 prose-blockquote:text-muted-foreground',
    )}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className={cn('hover:underline break-all', isMe ? 'text-primary-foreground/80' : 'text-primary')}>{children}</a>,
        img: ({ src, alt }) => <img src={src} alt={alt || ''} className="max-w-xs max-h-48 rounded-lg mt-1 object-contain" loading="lazy" />,
      }}>{content}</ReactMarkdown>
    </div>
  );
}

// ─── Attachment renderer ──────────────────────────────────────────────────────

function isImageType(file: MessageAttachmentFile): boolean {
  const ct = (file.contentType || file.filetype || '').toLowerCase();
  const name = (file.filename || file.url || '').toLowerCase();
  return ct.startsWith('image/') || ct === 'png' || ct === 'jpg' || ct === 'jpeg' || ct === 'gif' || ct === 'webp'
    || /\.(png|jpg|jpeg|gif|webp|svg|avif)(\?|$)/i.test(name);
}

function AttachmentFile({ file, isMe }: { file: MessageAttachmentFile; isMe: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(false);

  const displayUrl = file.proxyURL || file.url;

  if (isImageType(file) && !err) {
    return (
      <a href={file.url} target="_blank" rel="noopener noreferrer" className="block mt-1.5">
        <img
          src={displayUrl}
          alt={file.filename || 'attachment'}
          onLoad={() => setLoaded(true)}
          onError={() => setErr(true)}
          className={cn(
            'rounded-xl object-cover max-w-xs max-h-64 transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
            isMe ? 'bg-black/10' : 'bg-secondary',
          )}
          style={file.width && file.height
            ? { aspectRatio: `${file.width}/${file.height}` }
            : undefined}
        />
        {!loaded && (
          <div className={cn('rounded-xl w-48 h-32 animate-pulse', isMe ? 'bg-black/15' : 'bg-secondary')} />
        )}
      </a>
    );
  }

  // Non-image file link
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex items-center gap-2 mt-1.5 px-3 py-2 rounded-xl text-xs transition-colors',
        isMe
          ? 'bg-black/15 text-primary-foreground/80 hover:bg-black/25'
          : 'bg-secondary/60 text-muted-foreground hover:bg-secondary border border-border/50',
      )}
    >
      <span className="text-base">📎</span>
      <span className="truncate max-w-[200px]">{file.filename || 'Attachment'}</span>
    </a>
  );
}

function AttachmentRenderer({ attachmentsJson, isMe }: { attachmentsJson: string | null | undefined; isMe: boolean }) {
  if (!attachmentsJson) return null;
  let parsed: MessageAttachments;
  try { parsed = JSON.parse(attachmentsJson) as MessageAttachments; }
  catch { return null; }

  const files = parsed.files || [];
  const embedImages = parsed.embedImages || [];

  if (!files.length && !embedImages.length) return null;

  return (
    <div className="space-y-1">
      {files.map((f, i) => <AttachmentFile key={i} file={f} isMe={isMe} />)}
      {embedImages.map((img, i) => (
        <a key={`embed-${i}`} href={img.url} target="_blank" rel="noopener noreferrer" className="block mt-1.5">
          <img
            src={img.proxyURL || img.url}
            alt="embed"
            className="rounded-xl object-cover max-w-xs max-h-64"
          />
        </a>
      ))}
    </div>
  );
}

// ─── Date divider ─────────────────────────────────────────────────────────────

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-4 px-4 select-none">
      <div className="flex-1 h-px bg-border/40" />
      <span className="text-[11px] font-medium text-muted-foreground/50 px-2.5 py-1 rounded-full border border-border/35 bg-background">
        {label}
      </span>
      <div className="flex-1 h-px bg-border/40" />
    </div>
  );
}

// ─── Conversation header avatar ──────────────────────────────────────────────

function ConvAvatar({ name, avatarUrl, size = 7 }: { name: string; avatarUrl?: string | null; size?: number }) {
  const [imgErr, setImgErr] = useState(false);
  const hue = stringToHue(name);
  const sz = `w-${size} h-${size}`;

  if (avatarUrl && !imgErr) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        onError={() => setImgErr(true)}
        className={cn(sz, 'rounded-full flex-shrink-0 object-cover')}
      />
    );
  }

  return (
    <div
      className={cn(sz, 'rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold text-white')}
      style={{ background: `hsl(${hue},52%,40%)` }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function BubbleRow({ msg, prevMsg, nextMsg, highlighted = false }: {
  msg: Message;
  prevMsg: Message | null;
  nextMsg: Message | null;
  highlighted?: boolean;
}) {
  const navigate = useNavigate();
  const isMe = !!msg.isMe;
  const sender = getSender(msg);
  const senderId = getSenderId(msg);

  // Navigate to the Contacts page with this sender pre-selected
  const openContact = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Don't open contacts for our own messages
    if (isMe) return;
    navigate('/contacts', {
      state: { source: msg.source, platformId: senderId },
    });
  };
  const ts = msg.timestamp;
  const prevSenderId = prevMsg ? getSenderId(prevMsg) : null;
  const nextSenderId = nextMsg ? getSenderId(nextMsg) : null;
  const showDateDivider = !prevMsg || !isSameDay(prevMsg.timestamp, ts);
  const isFirstInRun = !prevMsg || prevSenderId !== senderId || !isSameDay(prevMsg.timestamp, ts) || new Date(ts).getTime() - new Date(prevMsg.timestamp).getTime() > 5 * 60 * 1000;
  const isLastInRun  = !nextMsg || nextSenderId !== senderId || !isSameDay(ts, nextMsg.timestamp) || new Date(nextMsg.timestamp).getTime() - new Date(ts).getTime() > 5 * 60 * 1000;

  const bubbleRadius = isMe
    ? cn('rounded-2xl rounded-tr-md', !isFirstInRun && 'rounded-tr-2xl', !isLastInRun && 'rounded-br-md')
    : cn('rounded-2xl rounded-tl-md', !isFirstInRun && 'rounded-tl-2xl', !isLastInRun && 'rounded-bl-md');

  // Highlight ring — shown when navigated from Contacts "open in chat" for a specific message
  const highlightClass = highlighted
    ? 'ring-2 ring-primary/60 ring-offset-1 ring-offset-background transition-all'
    : '';

  return (
    <>
      {showDateDivider && <DateDivider label={dayLabel(ts)} />}
      {isMe ? (
        <div className={cn('flex items-end gap-2 px-4 group flex-row', isFirstInRun ? 'mt-3' : 'mt-0.5')}>
          <div className="flex-1" />
          <div className={cn('flex flex-col max-w-[70%] min-w-0 items-end')}>
            <div className={cn('relative px-3.5 py-2.5 break-words', bubbleRadius, 'bg-amber-gradient text-primary-foreground shadow-warm-sm', highlightClass)}>
              {(msg.content || '') && <MessageContent content={msg.content || ''} source={msg.source} isMe={true} />}
              <AttachmentRenderer attachmentsJson={msg.attachments} isMe={true} />
            </div>
            {isLastInRun && (
              <span className="text-[10px] text-muted-foreground/50 mt-1 mx-1">
                {bubbleTimestamp(ts)}
              </span>
            )}
          </div>
          <div className="w-8 flex-shrink-0 flex items-end pb-0.5 self-end">
            {isLastInRun ? <Avatar msg={msg} size={8} /> : <div className="w-8" />}
          </div>
        </div>
      ) : (
        <div className={cn('flex items-end gap-2 px-4 group flex-row', isFirstInRun ? 'mt-3' : 'mt-0.5')}>
          {/* Clickable avatar — opens contact */}
          <div className="w-8 flex-shrink-0 flex items-end pb-0.5 self-end">
            {isLastInRun ? (
              <button onClick={openContact} className="cursor-pointer hover:opacity-80 transition-opacity rounded-full" title={`View ${sender}`}>
                <Avatar msg={msg} size={8} />
              </button>
            ) : <div className="w-8" />}
          </div>
          <div className={cn('flex flex-col max-w-[70%] min-w-0 items-start')}>
            {isFirstInRun && (
              <button
                onClick={openContact}
                className={cn('text-[11px] font-semibold mb-1 ml-1 hover:underline cursor-pointer', SERVICE_ACCENT[msg.source] || 'text-muted-foreground')}
                title={`View ${sender} in Contacts`}
              >{sender}</button>
            )}
            <div className={cn('relative px-3.5 py-2.5 break-words', bubbleRadius, 'bg-secondary/80 text-foreground border border-border/50', highlightClass)}>
              {(msg.content || '') && <MessageContent content={msg.content || ''} source={msg.source} isMe={false} />}
              <AttachmentRenderer attachmentsJson={msg.attachments} isMe={false} />
            </div>
            {isLastInRun && (
              <span className="text-[10px] text-muted-foreground/50 mt-1 mx-1">
                {bubbleTimestamp(ts)}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Tree sidebar ─────────────────────────────────────────────────────────────

// A single leaf chat entry in the tree
function ChatLeaf({ entry, section, selected, onClick, unreadCount, isMuted }: {
  entry: ChatEntry;
  section: ChatSection;
  selected: boolean;
  onClick: () => void;
  unreadCount: number;
  isMuted: boolean;
}) {
  const hasUnread = unreadCount > 0;
  // Muted chats with unreads don't show the urgency cues (bold, colored badge)
  const showUrgency = hasUnread && !isMuted;
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-left transition-all group relative',
        selected
          ? 'bg-primary/10 text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.03]',
      )}
    >
      {selected && <span className="absolute left-0 inset-y-1 w-0.5 bg-primary rounded-r-full" />}

      <EntryAvatar type={section.type} name={entry.name} avatarUrl={entry.avatarUrl} />
      <span className={cn(
        'flex-1 text-xs truncate',
        selected && 'font-semibold text-foreground',
        showUrgency && !selected && 'font-semibold text-foreground/90',
      )}>
        {entry.name}
      </span>
      {/* Unread count badge — colored for active unreads, grey for muted unreads */}
      {hasUnread && !selected ? (
        <span className={cn(
          'flex-shrink-0 min-w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center px-1',
          isMuted
            ? 'bg-muted-foreground/20 text-muted-foreground/50'
            : 'bg-primary text-primary-foreground',
        )}>
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      ) : (
        !hasUnread && entry.messageCount > 0 && !selected && (
          <span className="text-[10px] text-muted-foreground/35 flex-shrink-0">{entry.messageCount.toLocaleString()}</span>
        )
      )}
    </button>
  );
}

// A collapsible section (DMs, Channels, a Server)
function SectionNode({ section, source, selectedId, onSelect, search }: {
  section: ChatSection;
  source: string;
  selectedId: string | null;
  onSelect: (entry: ChatEntry) => void;
  search: string;
}) {
  const getUnreadForEntry = useUnreadStore((s) => s.getUnreadForEntry);
  const getIsMuted = useUnreadStore((s) => s.getIsMuted);
  const [open, setOpen] = useState(true);

  const filteredChats = useMemo(() => {
    if (!search) return section.chats;
    const q = search.toLowerCase();
    return section.chats.filter((c) => c.name.toLowerCase().includes(q));
  }, [section.chats, search]);

  const sectionUnread = filteredChats.reduce((sum, c) => sum + getUnreadForEntry(source, c.id), 0);
  // Unmuted unread count — used to decide badge colour
  const sectionUnreadUnmuted = filteredChats.reduce(
    (sum, c) => sum + (getIsMuted(source, c.id) ? 0 : getUnreadForEntry(source, c.id)), 0,
  );
  const sectionBadgeMuted = sectionUnread > 0 && sectionUnreadUnmuted === 0;

  if (filteredChats.length === 0 && !section.children?.length) return null;

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left group hover:bg-white/[0.025] transition-colors"
      >
        <span className={cn('transition-transform duration-150 text-muted-foreground/50', open ? 'rotate-90' : '')}>
          <ChevronRight className="w-3 h-3" />
        </span>
        <SectionIcon type={section.type} source={source} />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 truncate">
          {section.label}
        </span>
        {sectionUnread > 0 && (
          <span className={cn(
            'min-w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center px-1 flex-shrink-0',
            sectionBadgeMuted
              ? 'bg-muted-foreground/20 text-muted-foreground/50'
              : 'bg-primary text-primary-foreground',
          )}>
            {sectionUnread > 99 ? '99+' : sectionUnread}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/30 ml-1">{filteredChats.length}</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {filteredChats.map((entry) => (
              <ChatLeaf
                key={entry.id}
                entry={entry}
                section={section}
                selected={selectedId === entry.id}
                onClick={() => onSelect(entry)}
                unreadCount={getUnreadForEntry(source, entry.id)}
                isMuted={getIsMuted(source, entry.id)}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// A top-level service node (Slack, Discord, etc.)
function ServiceNode({ tree, selectedId, onSelect, search, collapsed }: {
  tree: ServiceTree;
  selectedId: string | null;
  onSelect: (entry: ChatEntry) => void;
  search: string;
  collapsed: boolean;
}) {
  const getUnreadForEntry = useUnreadStore((s) => s.getUnreadForEntry);
  const getIsMuted = useUnreadStore((s) => s.getIsMuted);
  const [open, setOpen] = useState(true);
  const source = tree.source;

  const allChats = tree.sections.flatMap((s) => s.chats);
  const totalChats = tree.sections.reduce((n, s) => n + s.chats.length, 0);
  const serviceUnread = allChats.reduce((sum, c) => sum + getUnreadForEntry(source, c.id), 0);
  const serviceUnreadUnmuted = allChats.reduce(
    (sum, c) => sum + (getIsMuted(source, c.id) ? 0 : getUnreadForEntry(source, c.id)), 0,
  );
  const serviceBadgeMuted = serviceUnread > 0 && serviceUnreadUnmuted === 0;

  if (collapsed) return null;

  return (
    <div className="border-b border-border/20 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.02] transition-colors group"
      >
        <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground/50 transition-transform duration-150 flex-shrink-0', !open && '-rotate-90')} />
        <span className={cn('text-xs font-bold tracking-tight flex-1', SERVICE_COLOR[source] || 'text-foreground')}>
          {SERVICE_LABEL[source] || source}
        </span>
        {serviceUnread > 0 && (
          <span className={cn(
            'min-w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center px-1 flex-shrink-0',
            serviceBadgeMuted
              ? 'bg-muted-foreground/20 text-muted-foreground/50'
              : 'bg-primary text-primary-foreground',
          )}>
            {serviceUnread > 99 ? '99+' : serviceUnread}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/30 ml-1">{totalChats}</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="pb-1">
              {tree.sections.map((section) => (
                <SectionNode
                  key={section.id}
                  section={section}
                  source={source}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  search={search}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Main Chat page ───────────────────────────────────────────────────────────

// ─── Unread folder ────────────────────────────────────────────────────────────

function UnreadFolder({ treeData, selectedId, onSelect, filter }: {
  treeData: ChatTreeMap | undefined;
  selectedId: string | null;
  onSelect: (entry: ChatEntry, source: string) => void;
  filter: string;
}) {
  const unreadCounts = useUnreadStore((s) => s.unreadCounts);
  const mutedChats = useUnreadStore((s) => s.mutedChats);
  const [open, setOpen] = useState(true);

  // Build list of entries that have unread > 0 and are NOT muted,
  // scoped to the active service filter when not 'all'.
  // (muted chats only show a grey badge in the service tree, not here)
  const unreadEntries = useMemo(() => {
    const result: Array<{ entry: ChatEntry; count: number }> = [];
    if (!treeData) return result;
    for (const [key, count] of Object.entries(unreadCounts)) {
      if (count <= 0) continue;
      if (mutedChats[key]) continue; // skip muted chats
      const colonIdx = key.indexOf(':');
      const source   = key.slice(0, colonIdx);
      const chatId   = key.slice(colonIdx + 1);
      if (filter !== 'all' && filter !== source) continue; // respect active filter
      const tree = treeData[source];
      if (!tree) continue;
      for (const section of tree.sections) {
        const entry = section.chats.find((c) => c.id === chatId);
        if (entry) { result.push({ entry, count }); break; }
      }
    }
    return result.sort((a, b) => b.count - a.count);
  }, [unreadCounts, mutedChats, treeData, filter]);

  const totalUnread = unreadEntries.reduce((sum, { count }) => sum + count, 0);
  const isEmpty = totalUnread === 0;

  return (
    <div className="border-b border-border/30">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.02] transition-colors"
      >
        <ChevronDown className={cn('w-3 h-3 text-muted-foreground/50 transition-transform flex-shrink-0', !open && '-rotate-90')} />
        <CheckCheck className={cn('w-3.5 h-3.5 flex-shrink-0', isEmpty ? 'text-muted-foreground/40' : 'text-primary')} />
        <span className={cn('text-xs font-bold tracking-tight flex-1', isEmpty ? 'text-muted-foreground/50' : 'text-foreground/80')}>
          Unread
        </span>
        {!isEmpty ? (
          <span className="min-w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1 flex-shrink-0">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground/30">0</span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {isEmpty ? (
              <p className="px-8 py-2.5 text-[11px] text-muted-foreground/40 italic">
                All caught up
              </p>
            ) : (
              <div className="pb-1">
                {unreadEntries.map(({ entry, count }) => (
                  <button
                    key={`${entry.source}:${entry.id}`}
                    onClick={() => onSelect(entry, entry.source)}
                    className={cn(
                      'w-full flex items-center gap-2 pl-5 pr-3 py-1.5 text-left transition-all',
                      selectedId === entry.id
                        ? 'bg-primary/10 text-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-white/[0.03]',
                    )}
                  >
                    <EntryAvatar type="dms" name={entry.name} avatarUrl={entry.avatarUrl} />
                    <span className="flex-1 text-xs font-semibold truncate text-foreground/90">{entry.name}</span>
                    <span className="flex-shrink-0 text-[10px] text-muted-foreground/50 capitalize mr-1">{SERVICE_LABEL[entry.source] || entry.source}</span>
                    <span className="flex-shrink-0 min-w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1">
                      {count > 99 ? '99+' : count}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const PAGE_SIZE = 50;

export default function Chat() {
  const location = useLocation();
  const [selected, setSelected] = useState<ChatEntry | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [composer, setComposer] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();
  const recentMessages = useMessageStreamStore((s) => s.recentMessages);
  const markReadOptimistic = useUnreadStore((s) => s.markReadOptimistic);
  const markUnreadOptimistic = useUnreadStore((s) => s.markUnreadOptimistic);
  const markAllReadOptimistic = useUnreadStore((s) => s.markAllReadOptimistic);
  const navApplied = useRef(false);
  // Persists the full nav state so it's available in async fetchInitial even after
  // navApplied is set to true by the auto-select effect
  const pendingNavState = useRef<ChatNavState | null>(null);

  // ── Pagination state ──────────────────────────────────────────────────────────
  // All loaded message pages, oldest first. Each page is a sorted array.
  const [pages, setPages] = useState<Message[][]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Virtuoso offset — grows as pages are prepended so the viewport doesn't jump
  const [firstItemIndex, setFirstItemIndex] = useState(0);
  // Message to scroll-to and highlight — set after messages load, consumed once
  const [scrollTarget, setScrollTarget] = useState<{ id: string; done: boolean } | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Data fetching ────────────────────────────────────────────────────────────

  const { data: treeData, isLoading: treeLoading, isError: treeError, refetch: refetchChats } = useQuery({
    queryKey: ['chats'],
    queryFn: api.chats,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });

  const { data: permissionsData } = useQuery({ queryKey: ['permissions'], queryFn: api.permissions });

  const serviceTrees = useMemo(() => {
    if (!treeData) return [];
    return SERVICE_ORDER.filter((s) => treeData[s]).map((s) => treeData[s]);
  }, [treeData]);

  // Reset pagination when conversation changes + mark as read immediately on open
  useEffect(() => {
    setPages([]);
    setFirstItemIndex(0);
    setHasOlderMessages(false);
    setScrollTarget(null);
    setHighlightedMessageId(null);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    // Mark chat as read when conversation opens.
    // Optimistic local zero for instant badge clear; server confirms via unread:update WS push.
    if (selected) {
      markReadOptimistic(selected.source, selected.id);
      api.markChatRead(selected.source, selected.id).catch(() => {/* best-effort */});
    }
  }, [selected?.id, selected?.source]);

  // Load the initial page for a conversation (or the "around" page if scrolling to a message)
  useEffect(() => {
    if (!selected) return;
    // Use pendingNavState ref so this works even after navApplied is set to true
    const navState = pendingNavState.current;

    const fetchInitial = async () => {
      try {
        const params = navState?.scrollToTimestamp
          ? { source: selected.source, chat_id: selected.id, limit: PAGE_SIZE, around: navState.scrollToTimestamp }
          : { source: selected.source, chat_id: selected.id, limit: PAGE_SIZE };

        const data = await api.messages(params);
        const sorted = [...data.messages].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        setPages([sorted]);
        setFirstItemIndex(0);
        setHasOlderMessages(data.total > PAGE_SIZE || !!navState?.scrollToTimestamp);

        if (navState?.scrollToMessageId) {
          // Set the scroll target — a separate effect will execute the scroll
          // once messages are actually rendered in the DOM
          setScrollTarget({ id: navState.scrollToMessageId, done: false });
          // Don't pin to bottom when navigating to a specific message
          setAtBottom(false);
        } else {
          setAtBottom(true);
        }
      } catch { /* ignore */ }
    };

    fetchInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.source]);

  // Auto-select when navigated from Contacts
  useEffect(() => {
    if (navApplied.current) return;
    const state = location.state as ChatNavState | null;
    if (!state?.chatId || !state?.source) return;
    if (serviceTrees.length === 0) return;

    // Persist full nav state so fetchInitial can use it even after navApplied = true
    pendingNavState.current = state;
    navApplied.current = true;

    for (const tree of serviceTrees) {
      if (tree.source !== state.source) continue;
      for (const section of tree.sections) {
        const match = section.chats.find((c) => c.id === state.chatId);
        if (match) { setSelected(match); setFilter(state.source); return; }
      }
    }

    setSelected({ id: state.chatId, source: state.source, name: state.name || state.chatId, messageCount: state.messageCount ?? 0 });
    setFilter(state.source);
  }, [location.state, serviceTrees]);

  // Load older messages when user reaches the top
  const loadOlderMessages = useCallback(async () => {
    if (!selected || loadingOlder || !hasOlderMessages || pages.length === 0) return;
    const oldest = pages[0]?.[0];
    if (!oldest?.timestamp) return;

    setLoadingOlder(true);
    try {
      const data = await api.messages({
        source: selected.source,
        chat_id: selected.id,
        limit: PAGE_SIZE,
        before: oldest.timestamp,
      });
      if (data.messages.length === 0) { setHasOlderMessages(false); return; }
      const sorted = [...data.messages].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

      setFirstItemIndex((prev) => prev - sorted.length);
      setPages((prev) => [sorted, ...prev]);
      setHasOlderMessages(data.messages.length >= PAGE_SIZE);
    } catch { /* ignore */ }
    setLoadingOlder(false);
  }, [selected, loadingOlder, hasOlderMessages, pages]);

  // Flatten all pages + live messages, deduplicated
  const messages = useMemo(() => {
    if (!selected) return [];
    const live = recentMessages.filter(
      (m) => m.source === selected.source &&
        (String(m.chatId) === selected.id || String(m.channelId ?? '') === selected.id),
    );
    const flat = pages.flat();
    const all = [...flat, ...live];
    const seen = new Set<string>();
    const deduped: Message[] = [];
    for (const m of all) {
      const key = m.messageId ? String(m.messageId) : `${m.timestamp}-${m.content}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(m); }
    }
    return deduped.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  }, [pages, recentMessages, selected]);

  const msgsLoading = pages.length === 0 && !!selected;

  // ── Scroll-to-message ─────────────────────────────────────────────────────────
  // Executes once messages are rendered — uses double-rAF to wait for Virtuoso's
  // layout pass before calling scrollToIndex.
  useEffect(() => {
    if (!scrollTarget || scrollTarget.done || messages.length === 0) return;
    const idx = messages.findIndex((m) => String(m.messageId) === String(scrollTarget.id));
    if (idx < 0) return;

    setScrollTarget((prev) => prev ? { ...prev, done: true } : null);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: idx, behavior: 'smooth', align: 'center' });
        setHighlightedMessageId(scrollTarget.id);
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        highlightTimer.current = setTimeout(() => setHighlightedMessageId(null), 2500);
      });
    });
  }, [messages, scrollTarget]);

  // ── Scroll ───────────────────────────────────────────────────────────────────

  // Keep pinned to bottom when new messages arrive and user is already at bottom
  useEffect(() => {
    if (atBottom && messages.length > 0 && !highlightedMessageId) {
      virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' });
    }
  }, [messages.length, atBottom, highlightedMessageId]);

  // ── Send ─────────────────────────────────────────────────────────────────────

  const selectedPerm = permissionsData?.find((p) => p.service === selected?.source);
  const canSend = selectedPerm?.sendEnabled ?? false;

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      api.createOutboxItem({ source: selected!.source, recipient_id: selected!.id, recipient_name: selected!.name, content }),
    onSuccess: (item) => {
      setComposer(''); composerRef.current?.focus();
      if (item.status === 'sent') toast({ title: 'Message sent', variant: 'success' });
      else toast({ title: 'Added to outbox', description: 'Pending approval' });
      qc.invalidateQueries({ queryKey: ['outbox'] });
    },
    onError: (e: Error) => toast({ title: 'Failed to send', description: e.message, variant: 'destructive' }),
  });

  const handleSend = useCallback(() => {
    if (!composer.trim() || !selected || !canSend) return;
    sendMutation.mutate(composer.trim());
  }, [composer, selected, canSend, sendMutation]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setComposer(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden bg-background">

      {/* ── Tree Sidebar ── */}
      <div className="w-64 flex-shrink-0 border-r border-border flex flex-col bg-sidebar">

        {/* Search + filter */}
        <div className="p-2.5 border-b border-border space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50 pointer-events-none" />
            <input
              className="w-full bg-secondary/50 border border-border/50 rounded-lg pl-7 pr-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground/40"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {/* Service filter chips */}
          <div className="flex items-center gap-1.5">
            <AllFilterChip active={filter === 'all'} onClick={() => setFilter('all')} />
            {(['slack', 'discord', 'telegram', 'twitter'] as const).map((f) => (
              <ServiceFilterChip key={f} service={f} active={filter === f} onClick={() => setFilter(f)} />
            ))}
            <button
              className="ml-auto flex-shrink-0 p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary/60 transition-colors"
              title="Mark all chats read"
              onClick={() => {
                markAllReadOptimistic();
                api.markAllChatsRead().catch(() => {});
              }}
            >
              <CheckCheck className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto">
          {/* Unread folder — always at top, greyed when empty */}
          {!treeLoading && (
            <UnreadFolder
              treeData={treeData}
              selectedId={selected?.id ?? null}
              filter={filter}
              onSelect={(entry) => {
                setSelected(entry);
                setFilter(entry.source);
                markReadOptimistic(entry.source, entry.id);
                api.markChatRead(entry.source, entry.id).catch(() => {/* best-effort */});
              }}
            />
          )}

          {treeLoading ? (
            <div className="p-3 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-3 w-1/3 ml-3" />
                  {Array.from({ length: 4 }).map((_, j) => (
                    <Skeleton key={j} className="h-6 mx-3 rounded-lg" />
                  ))}
                </div>
              ))}
            </div>
          ) : treeError ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
              <RefreshCw className="w-6 h-6 opacity-30" />
              <p className="text-xs">Failed to load conversations</p>
              <button
                onClick={() => refetchChats()}
                className="text-xs text-primary hover:underline"
              >Retry</button>
            </div>
          ) : serviceTrees.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
              <MessageSquare className="w-8 h-8 opacity-20" />
              <p className="text-xs">No conversations synced</p>
            </div>
          ) : (
            serviceTrees.map((tree) => (
              <ServiceNode
                key={tree.source}
                tree={tree}
                selectedId={selected?.id ?? null}
                onSelect={(entry) => {
                  setSelected(entry);
                  markReadOptimistic(entry.source, entry.id);
                  api.markChatRead(entry.source, entry.id).catch(() => {/* best-effort */});
                }}
                search={search}
                collapsed={filter !== 'all' && filter !== tree.source}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Message area ── */}
      {selected ? (
        <div className="flex-1 flex flex-col min-w-0 relative">

           {/* Header */}
           <div className="flex items-center gap-3 px-5 py-2 min-h-12 border-b border-border bg-card/40 backdrop-blur-sm flex-shrink-0">
             <ConvAvatar name={selected.name} avatarUrl={selected.avatarUrl} size={7} />

            <div className="flex-1 flex flex-col justify-center min-w-0">
              <h2 className="text-sm font-semibold truncate leading-tight">{selected.name}</h2>
              <ChatBreadcrumb
                treeData={treeData}
                selected={selected}
                serviceColor={SERVICE_COLOR[selected.source] || 'text-muted-foreground/60'}
              />
            </div>
            <span className="text-xs text-muted-foreground/50 hidden sm:block flex-shrink-0">
              {selected.messageCount.toLocaleString()} messages
            </span>
            {/* Mark as unread — hidden for Discord (no reliable read cursor API) */}
            {selected?.source !== 'discord' && (
              <button
                onClick={() => {
                  if (!selected) return;
                  markUnreadOptimistic(selected.source, selected.id);
                  api.markChatUnread(selected.source, selected.id).catch(() => {});
                }}
                title="Mark as unread"
                className="p-1.5 rounded hover:bg-accent text-muted-foreground/50 hover:text-foreground transition-colors flex-shrink-0"
              >
                <MailOpen className="w-3.5 h-3.5" />
              </button>
            )}
            {(() => {
              const url = getPlatformUrl(selected);
              if (!url) return null;
              const label = selected.source.charAt(0).toUpperCase() + selected.source.slice(1);
              return (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open in ${label}`}
                  className="p-1.5 rounded hover:bg-accent text-muted-foreground/50 hover:text-foreground transition-colors flex-shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              );
            })()}
          </div>

          {/* Messages */}
          <div className="flex-1 min-h-0">
            {msgsLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <MessageSquare className="w-10 h-10 opacity-15" />
                <p className="text-sm">No messages</p>
              </div>
            ) : (
              <Virtuoso
                ref={virtuosoRef}
                style={{ height: '100%' }}
                data={messages}
                firstItemIndex={Math.max(0, firstItemIndex)}
                initialTopMostItemIndex={messages.length - 1}
                followOutput={atBottom ? 'smooth' : false}
                alignToBottom={!scrollTarget}
                atBottomStateChange={(bottom) => {
                  setAtBottom(bottom);
                  if (bottom && selected) {
                    markReadOptimistic(selected.source, selected.id);
                    api.markChatRead(selected.source, selected.id).catch(() => {/* best-effort */});
                  }
                }}
                atBottomThreshold={120}
                startReached={loadOlderMessages}
                itemContent={(index, msg) => {
                  const msgId = msg.messageId ? String(msg.messageId) : null;
                  const isHighlighted = !!msgId && msgId === highlightedMessageId;
                  return (
                    <BubbleRow
                      key={`${msg.messageId}-${index}`}
                      msg={msg}
                      prevMsg={index > 0 ? messages[index - 1] : null}
                      nextMsg={index < messages.length - 1 ? messages[index + 1] : null}
                      highlighted={isHighlighted}
                    />
                  );
                }}
                components={{
                  Footer: () => <div className="h-3" />,
                  Header: () => (
                    <div className="text-center py-4">
                      {loadingOlder ? (
                        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                          <Loader2Chat className="w-3.5 h-3.5 animate-spin" />
                          Loading older messages…
                        </div>
                      ) : hasOlderMessages ? (
                        <button onClick={loadOlderMessages} className="btn-ghost text-xs text-muted-foreground">
                          Load older messages
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground/40">Beginning of conversation</span>
                      )}
                    </div>
                  ),
                }}
              />
            )}
          </div>

          {/* Scroll to bottom */}
          <AnimatePresence>
            {!atBottom && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}
                onClick={() => virtuosoRef.current?.scrollToIndex({ index: 999999, behavior: 'smooth' })}
                className="absolute bottom-24 right-5 w-8 h-8 rounded-full bg-primary shadow-amber flex items-center justify-center text-primary-foreground z-10"
              >
                <ArrowDown className="w-4 h-4" />
              </motion.button>
            )}
          </AnimatePresence>

          {/* Composer */}
          <div className="flex-shrink-0 px-4 pb-4 pt-2 border-t border-border bg-card/20">
            <div
              className={cn('rounded-2xl border transition-all', canSend ? 'border-border/60 focus-within:border-primary/30 bg-secondary/40 cursor-text' : 'border-border/30 bg-secondary/20 opacity-50 cursor-not-allowed')}
              onClick={() => composerRef.current?.focus()}
            >
              <textarea
                ref={composerRef}
                value={composer}
                onChange={handleComposerChange}
                onKeyDown={handleKeyDown}
                placeholder={canSend ? `Message ${selected.name}…` : 'Sending is disabled for this service'}
                disabled={!canSend || sendMutation.isPending}
                rows={1}
                className="w-full bg-transparent px-4 py-3 text-sm focus:outline-none placeholder:text-muted-foreground/40 resize-none disabled:cursor-not-allowed"
                style={{ maxHeight: 160 }}
              />
              <div className="flex items-center justify-between px-3 pb-2.5">
                <span className="text-[10px] text-muted-foreground/30">
                  {canSend ? (selectedPerm?.directSendFromUi && !selectedPerm?.requireApproval ? 'Sends immediately' : 'Goes to outbox') : 'Disabled'}
                </span>
                <button
                  onClick={handleSend}
                  disabled={!composer.trim() || !canSend || sendMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-40 transition-all"
                >
                  <Send className="w-3.5 h-3.5" />Send
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
          <div className="w-20 h-20 rounded-2xl bg-secondary/40 border border-border flex items-center justify-center">
            <MessageSquare className="w-10 h-10 opacity-15" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">Select a conversation</p>
            <p className="text-xs text-muted-foreground/40 mt-1">
              {serviceTrees.length > 0
                ? `${serviceTrees.reduce((n, t) => n + t.sections.reduce((m, s) => m + s.chats.length, 0), 0)} conversations across ${serviceTrees.length} services`
                : 'No conversations synced yet'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
