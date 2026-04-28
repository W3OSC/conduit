import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Plus, X, Bot, Send, ChevronDown, ChevronRight,
  Loader2, AlertTriangle, Zap, Terminal, Trash2, ArrowRight, Settings2,
  Search, Mail, Calendar, Users, FileText, BookOpen, Database,
  MessageSquare, Eye, Edit3, Trash, CheckCircle2, AtSign,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, type AiSession, type AiMessage, type AiToolCall, type AiConnection } from '@/lib/api';
import { useAiChatStore } from '@/store';
import { onWsReconnect } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { toast } from '@/store';
import { CopyButton } from '@/components/shared/CopyButton';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function parseToolCalls(raw: string | null): AiToolCall[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// ─── Tool call helpers ────────────────────────────────────────────────────────

function getToolCallIcon(name: string): LucideIcon {
  if (/search|find/i.test(name)) return Search;
  if (/gmail|email|mail/i.test(name)) return Mail;
  if (/calendar|event/i.test(name)) return Calendar;
  if (/contact/i.test(name)) return Users;
  if (/obsidian|vault|file/i.test(name)) return FileText;
  if (/notion.*page|getNotion|createNotion|updateNotion/i.test(name)) return BookOpen;
  if (/notion.*database|queryNotion/i.test(name)) return Database;
  if (/message|chat|outbox|send/i.test(name)) return MessageSquare;
  if (/twitter|tweet/i.test(name)) return AtSign;
  if (/get|list|read|fetch/i.test(name)) return Eye;
  if (/create|write|update|patch/i.test(name)) return Edit3;
  if (/delete|remove/i.test(name)) return Trash;
  return Terminal;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  return JSON.stringify(v);
}

function q(v: unknown): string {
  const s = str(v).trim();
  return s ? `'${s.length > 40 ? s.slice(0, 40) + '…' : s}'` : '';
}

function countLabel(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? singular + 's')}`;
}

function outputCount(output: unknown, noun: string, plural?: string): string {
  if (output === undefined || output === null) return '';
  // Array output — count items
  if (Array.isArray(output)) return ` · ${countLabel(output.length, noun, plural)}`;
  // Object with a known count/total field
  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    const msgs = obj.messages; const itms = obj.items;
    const n = obj.total ?? obj.count ?? obj.resultCount
      ?? (Array.isArray(msgs) ? msgs.length : undefined)
      ?? (Array.isArray(itms) ? itms.length : undefined);
    if (typeof n === 'number') return ` · ${countLabel(n, noun, plural)}`;
    // Check nested array properties
    for (const key of ['messages', 'items', 'events', 'contacts', 'emails', 'results', 'files', 'pages', 'tweets', 'dms', 'threads', 'labels']) {
      if (Array.isArray(obj[key])) return ` · ${countLabel((obj[key] as unknown[]).length, noun, plural)}`;
    }
  }
  return '';
}

function getToolCallSummary(name: string, input: unknown, output?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;

  // ── Messages / Chats ──────────────────────────────────────────────────────
  if (name === 'getMessages' || name === 'searchMessages') {
    const qStr = q(inp.query ?? inp.search ?? inp.q);
    const counts = outputCount(output, 'message');
    return qStr ? `Searched messages for ${qStr}${counts}` : `Retrieved messages${counts}`;
  }
  if (name === 'getChats') {
    const counts = outputCount(output, 'chat');
    return `Listed chats${counts}`;
  }
  if (name === 'markChatRead') return 'Marked chat as read';

  // ── Contacts ──────────────────────────────────────────────────────────────
  if (name === 'listContacts') {
    const counts = outputCount(output, 'contact');
    return `Listed contacts${counts}`;
  }
  if (name === 'getContact') return `Looked up contact${inp.contactId ? ` ${q(inp.contactId)}` : ''}`;
  if (name === 'getContactHistory') return `Retrieved contact message history`;
  if (name === 'messageContact') {
    const preview = q(inp.content ?? inp.text ?? inp.message);
    return preview ? `Sent message: ${preview}` : 'Sent a message to a contact';
  }
  if (name === 'getContactDmChannel') return 'Got DM channel for contact';

  // ── Outbox ────────────────────────────────────────────────────────────────
  if (name === 'listOutbox') {
    const counts = outputCount(output, 'item');
    return `Listed outbox${counts}`;
  }
  if (name === 'createOutboxItem') {
    const preview = q(inp.content ?? inp.text ?? inp.subject);
    return preview ? `Queued message: ${preview}` : 'Created outbox item';
  }
  if (name === 'getOutboxItem') return 'Retrieved outbox item';
  if (name === 'updateOutboxItem') return 'Updated outbox item';
  if (name === 'deleteOutboxItem') return 'Deleted outbox item';
  if (name === 'createOutboxBatch' || name === 'createOutboxBatchMulti') {
    const batchItems = Array.isArray(inp.messages) ? inp.messages.length : (Array.isArray(inp.items) ? inp.items.length : null);
    return batchItems !== null ? `Queued ${countLabel(batchItems, 'message')} in batch` : 'Created outbox batch';
  }

  // ── Gmail ─────────────────────────────────────────────────────────────────
  if (name === 'listGmailMessages') {
    const qStr = q(inp.query ?? inp.q);
    const counts = outputCount(output, 'email');
    return qStr ? `Searched Gmail for ${qStr}${counts}` : `Listed Gmail messages${counts}`;
  }
  if (name === 'getGmailMessage') return 'Retrieved Gmail message';
  if (name === 'getGmailBody') return 'Read Gmail message body';
  if (name === 'getGmailThread') {
    const counts = outputCount(output, 'message');
    return `Read Gmail thread${counts}`;
  }
  if (name === 'gmailAction') {
    const action = str(inp.action ?? inp.type).toLowerCase();
    if (action.includes('reply')) return 'Replied to Gmail message';
    if (action.includes('send')) return 'Sent Gmail message';
    if (action.includes('archive')) return 'Archived Gmail message';
    if (action.includes('delete') || action.includes('trash')) return 'Deleted Gmail message';
    if (action.includes('label')) return 'Labelled Gmail message';
    return action ? `Gmail: ${action}` : 'Performed Gmail action';
  }
  if (name === 'listGmailLabels') {
    const counts = outputCount(output, 'label');
    return `Listed Gmail labels${counts}`;
  }

  // ── Calendar ──────────────────────────────────────────────────────────────
  if (name === 'listCalendars') {
    const counts = outputCount(output, 'calendar');
    return `Listed calendars${counts}`;
  }
  if (name === 'listCalendarEvents') {
    const counts = outputCount(output, 'event');
    const from = q(inp.timeMin ?? inp.from ?? inp.start);
    return from ? `Listed calendar events from ${from}${counts}` : `Listed calendar events${counts}`;
  }
  if (name === 'getCalendarEvent') return 'Retrieved calendar event';
  if (name === 'calendarAction') {
    const action = str(inp.action ?? inp.type).toLowerCase();
    if (action.includes('create')) return 'Created calendar event';
    if (action.includes('update') || action.includes('patch')) return 'Updated calendar event';
    if (action.includes('delete')) return 'Deleted calendar event';
    if (action.includes('rsvp') || action.includes('respond')) return 'Responded to calendar invite';
    return action ? `Calendar: ${action}` : 'Performed calendar action';
  }

  // ── Twitter ───────────────────────────────────────────────────────────────
  if (name === 'getTwitterFeed') {
    const counts = outputCount(output, 'tweet');
    return `Retrieved Twitter feed${counts}`;
  }
  if (name === 'searchTwitter') {
    const qStr = q(inp.query ?? inp.q);
    const counts = outputCount(output, 'tweet');
    return qStr ? `Searched Twitter for ${qStr}${counts}` : `Searched Twitter${counts}`;
  }
  if (name === 'getTwitterMentions') {
    const counts = outputCount(output, 'mention');
    return `Retrieved Twitter mentions${counts}`;
  }
  if (name === 'listTwitterDMs') {
    const counts = outputCount(output, 'DM', 'DMs');
    return `Listed Twitter DMs${counts}`;
  }
  if (name === 'getTwitterDMConversation') {
    const counts = outputCount(output, 'message');
    return `Retrieved Twitter DM conversation${counts}`;
  }
  if (name === 'twitterAction') {
    const action = str(inp.action ?? inp.type).toLowerCase();
    if (action.includes('tweet') || action.includes('post')) return 'Posted a tweet';
    if (action.includes('reply')) return 'Replied to a tweet';
    if (action.includes('retweet')) return 'Retweeted';
    if (action.includes('like') || action.includes('favorite')) return 'Liked a tweet';
    if (action.includes('follow')) return 'Followed a user';
    if (action.includes('dm') || action.includes('message')) return 'Sent a Twitter DM';
    return action ? `Twitter: ${action}` : 'Performed Twitter action';
  }
  if (name === 'getTwitterTweet') return 'Retrieved tweet';
  if (name === 'getTwitterTweetThread') {
    const counts = outputCount(output, 'tweet');
    return `Retrieved tweet thread${counts}`;
  }
  if (name === 'getTwitterMe') return 'Retrieved Twitter profile';
  if (name === 'getTwitterUserProfile') return `Looked up Twitter user${q(inp.username) ? ` ${q(inp.username)}` : ''}`;
  if (name === 'getTwitterUserTweets') {
    const counts = outputCount(output, 'tweet');
    return `Retrieved user tweets${counts}`;
  }
  if (name === 'getTwitterUserFollowers') {
    const counts = outputCount(output, 'follower');
    return `Retrieved followers${counts}`;
  }
  if (name === 'getTwitterUserFollowing') {
    const counts = outputCount(output, 'following');
    return `Retrieved following list${counts}`;
  }
  if (name === 'getTwitterTrends') {
    const counts = outputCount(output, 'trend');
    return `Retrieved Twitter trends${counts}`;
  }

  // ── Notion ────────────────────────────────────────────────────────────────
  if (name === 'createNotionPage') {
    const title = q(inp.title ?? inp.name);
    return title ? `Created Notion page ${title}` : 'Created Notion page';
  }
  if (name === 'getNotionPage') return 'Retrieved Notion page';
  if (name === 'updateNotionPage') return 'Updated Notion page';
  if (name === 'listNotionDatabases') {
    const counts = outputCount(output, 'database');
    return `Listed Notion databases${counts}`;
  }
  if (name === 'queryNotionDatabase') {
    const counts = outputCount(output, 'result');
    return `Queried Notion database${counts}`;
  }
  if (name === 'searchNotion') {
    const qStr = q(inp.query ?? inp.q);
    const counts = outputCount(output, 'result');
    return qStr ? `Searched Notion for ${qStr}${counts}` : `Searched Notion${counts}`;
  }
  if (name === 'getNotionBlock') return 'Retrieved Notion block';
  if (name === 'getNotionBlockChildren') {
    const counts = outputCount(output, 'block');
    return `Retrieved Notion block children${counts}`;
  }

  // ── Obsidian / Vault ──────────────────────────────────────────────────────
  if (name === 'listObsidianFiles') {
    const counts = outputCount(output, 'file');
    return `Listed vault files${counts}`;
  }
  if (name === 'readObsidianFile') {
    const path = q(inp.path ?? inp.filePath ?? inp.file);
    return path ? `Read vault file ${path}` : 'Read vault file';
  }

  // ── System / Status ───────────────────────────────────────────────────────
  if (name === 'getActivity') {
    const counts = outputCount(output, 'event');
    return `Retrieved activity log${counts}`;
  }
  if (name === 'getStatus') return 'Checked Conduit status';
  if (name === 'getConnections') {
    const counts = outputCount(output, 'connection');
    return `Listed connections${counts}`;
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  // Convert camelCase to a readable phrase
  return name.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
}

// ─── Tool call activity row ───────────────────────────────────────────────────

interface ToolCallActivityRowProps {
  toolCall: AiToolCall;
  pending?: boolean;
}

function ToolCallActivityRow({ toolCall, pending = false }: ToolCallActivityRowProps) {
  const [open, setOpen] = useState(false);
  const Icon = getToolCallIcon(toolCall.name);
  const summary = getToolCallSummary(toolCall.name, toolCall.input, toolCall.output);
  const hasOutput = toolCall.output !== undefined;
  const outputStr = hasOutput
    ? (typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output, null, 2))
    : '';
  const inputStr = JSON.stringify(toolCall.input, null, 2);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="px-6 py-1"
    >
      <div className="rounded-xl border border-border/60 bg-secondary/30 overflow-hidden">
        {/* Header row */}
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-secondary/60 transition-colors group"
        >
          <div className="flex-shrink-0 w-5 h-5 rounded-md bg-primary/10 border border-primary/15 flex items-center justify-center">
            <Icon className="w-3 h-3 text-primary/70" />
          </div>
          <span className="font-mono text-[10px] text-muted-foreground/70 flex-shrink-0 bg-background/60 border border-border/50 rounded px-1.5 py-0.5">
            {toolCall.name}
          </span>
          <span className="text-xs text-muted-foreground flex-1 truncate">
            {summary}
          </span>
          <div className="flex-shrink-0 flex items-center gap-1.5">
            {pending ? (
              <Loader2 className="w-3 h-3 text-amber-500/80 animate-spin" />
            ) : (
              <CheckCircle2 className="w-3 h-3 text-emerald-500/80" />
            )}
            {open
              ? <ChevronDown className="w-3 h-3 text-muted-foreground/40" />
              : <ChevronRight className="w-3 h-3 text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors" />
            }
          </div>
        </button>

        {/* Expandable detail */}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <div className="border-t border-border/50 divide-y divide-border/40">
                {/* Input */}
                <div className="p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-medium">Input</p>
                    <CopyButton text={inputStr} />
                  </div>
                  <pre className="text-[11px] font-mono text-foreground/70 bg-background/60 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-36 overflow-y-auto">
                    {inputStr}
                  </pre>
                </div>
                {/* Output */}
                {hasOutput && (
                  <div className="p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-medium">Output</p>
                      <CopyButton text={outputStr} />
                    </div>
                    <pre className="text-[11px] font-mono text-foreground/70 bg-background/60 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                      {outputStr}
                    </pre>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ─── Thinking indicator ───────────────────────────────────────────────────────

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50"
          animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1, 0.8] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
        />
      ))}
    </div>
  );
}

// ─── Streaming cursor ─────────────────────────────────────────────────────────

function StreamingCursor() {
  return (
    <motion.span
      className="inline-block w-0.5 h-4 bg-primary/80 ml-0.5 rounded-full align-text-bottom"
      animate={{ opacity: [1, 0] }}
      transition={{ duration: 0.7, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: AiMessage;
  isStreaming?: boolean;
  streamContent?: string;
}

function MessageBubble({ message, isStreaming, streamContent }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const content = isStreaming ? (streamContent ?? '') : message.content;
  const ts = message.createdAt;

  const codeComponents = useMemo(() => ({
    code({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { inline?: boolean }) {
      const match = /language-(\w+)/.exec(className || '');
      const lang = match?.[1] ?? '';
      const code = String(children).replace(/\n$/, '');
      const isBlock = !!className;
      if (!isBlock) {
        return (
          <code className="font-mono text-[0.85em] bg-secondary px-1.5 py-0.5 rounded-md text-primary/80" {...props}>
            {children}
          </code>
        );
      }
      return (
        <div className="relative group rounded-xl overflow-hidden my-2 border border-border">
          {lang && (
            <div className="flex items-center justify-between px-3 py-1.5 bg-background border-b border-border">
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">{lang}</span>
              <CopyButton text={code} />
            </div>
          )}
          {!lang && (
            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <CopyButton text={code} />
            </div>
          )}
          <pre className="overflow-x-auto p-3 bg-background">
            <code className="font-mono text-sm text-foreground/90 whitespace-pre">{children}</code>
          </pre>
        </div>
      );
    },
    a({ children, href, ...props }: React.ComponentPropsWithoutRef<'a'>) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="text-primary hover:text-primary/80 underline underline-offset-2 transition-colors" {...props}>
          {children}
        </a>
      );
    },
  }), []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn('flex gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}
    >
      {!isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center mt-0.5">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
      )}
      <div className={cn('max-w-[78%] flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
        <div className={cn(
          'rounded-2xl px-4 py-3 text-sm leading-relaxed',
          isUser
            ? 'bg-primary/12 border border-primary/20 text-foreground rounded-tr-md'
            : 'bg-card border border-border text-foreground/90 rounded-tl-md',
        )}>
          {isUser ? (
            <p className="whitespace-pre-wrap">{content}</p>
          ) : (
            <div className="prose-ai">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={codeComponents as Record<string, unknown>}>
                {content}
              </ReactMarkdown>
              {isStreaming && <StreamingCursor />}
            </div>
          )}
        </div>
        {ts && (
          <span className="text-[10px] text-muted-foreground/50 px-1">{formatTime(ts)}</span>
        )}
      </div>
    </motion.div>
  );
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

interface TabBarProps {
  sessions: AiSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  creating: boolean;
}

function TabBar({ sessions, activeId, onSelect, onNew, onClose, onRename, creating }: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = (session: AiSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditValue(session.title);
    setTimeout(() => inputRef.current?.select(), 10);
  };

  const commitEdit = () => {
    if (editingId && editValue.trim()) onRename(editingId, editValue.trim());
    setEditingId(null);
  };

  return (
    <div className="flex items-center border-b border-border bg-sidebar/50 overflow-x-auto flex-shrink-0" style={{ scrollbarWidth: 'none' }}>
      <div className="flex items-stretch min-w-0 flex-1">
        <AnimatePresence initial={false}>
          {sessions.map((session) => {
            const isActive = session.id === activeId;
            return (
              <motion.div
                key={session.id}
                layout
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => onSelect(session.id)}
                className={cn(
                  'relative group flex items-center gap-2 px-4 py-3 cursor-pointer border-r border-border',
                  'text-sm whitespace-nowrap flex-shrink-0 max-w-[200px] overflow-hidden',
                  'transition-colors duration-150',
                  isActive ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-white/4',
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="tab-indicator"
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full"
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.35 }}
                  />
                )}
                <Bot className={cn('w-3.5 h-3.5 flex-shrink-0', isActive ? 'text-primary' : 'text-muted-foreground/50')} />
                {editingId === session.id ? (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit();
                      if (e.key === 'Escape') setEditingId(null);
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-transparent outline-none border-b border-primary text-sm"
                    autoFocus
                  />
                ) : (
                  <span
                    className="flex-1 min-w-0 truncate"
                    onDoubleClick={(e) => startEdit(session, e)}
                    title={session.title}
                  >
                    {session.title}
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(session.id); }}
                  className={cn(
                    'flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center',
                    'opacity-0 group-hover:opacity-100 transition-opacity',
                    'hover:bg-white/10 text-muted-foreground hover:text-foreground',
                  )}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      <button
        onClick={onNew}
        disabled={creating}
        className="flex-shrink-0 flex items-center gap-1.5 px-4 py-3 text-muted-foreground hover:text-foreground transition-colors border-l border-border disabled:opacity-50"
      >
        {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
      </button>
    </div>
  );
}

// ─── Not-connected banner ─────────────────────────────────────────────────────

function NotConnectedBanner() {
  const navigate = useNavigate();
  return (
    <div className="mx-4 mt-3 flex items-center gap-3 px-4 py-3 rounded-xl bg-primary/8 border border-primary/20">
      <AlertTriangle className="w-4 h-4 text-primary flex-shrink-0" />
      <p className="text-xs text-primary/80 flex-1">
        No AI agent connected.
      </p>
      <button
        onClick={() => navigate('/settings/ai')}
        className="btn-ghost text-primary hover:text-primary/80 text-xs px-2 py-1 flex items-center gap-1 flex-shrink-0"
      >
        Set up <ArrowRight className="w-3 h-3" />
      </button>
    </div>
  );
}

// ─── Error banner ─────────────────────────────────────────────────────────────

function ErrorBanner({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      className="mx-4 mt-3 flex items-center gap-3 px-4 py-3 rounded-xl bg-red-500/8 border border-red-500/20"
    >
      <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
      <p className="text-xs text-red-300/80 flex-1">{error}</p>
      <button onClick={onDismiss} className="btn-ghost text-muted-foreground p-1">
        <X className="w-3.5 h-3.5" />
      </button>
    </motion.div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onNew, creating, connected }: { onNew: () => void; creating: boolean; connected: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-xs space-y-4">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Bot className="w-7 h-7 text-primary" />
        </div>
        {connected ? (
          <>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold tracking-tight">Start a conversation</h2>
              <p className="text-sm text-muted-foreground">Each tab is a separate conversation thread with your AI.</p>
            </div>
            <button onClick={onNew} disabled={creating} className="btn-primary">
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              New Chat
            </button>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold tracking-tight">No AI connected</h2>
              <p className="text-sm text-muted-foreground">Connect an AI agent to start chatting.</p>
            </div>
            <button onClick={() => navigate('/settings/ai')} className="btn-primary">
              <Settings2 className="w-4 h-4" /> Connect AI
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Chat window ──────────────────────────────────────────────────────────────

interface ChatWindowProps {
  session: AiSession;
  connected: boolean;
}

function ChatWindow({ session, connected }: ChatWindowProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState('');
  const [atBottom, setAtBottom] = useState(true);

  const queryClient = useQueryClient();

  const {
    messages: allMessages,
    streaming,
    waiting,
    errors,
    setMessages,
    setError,
    setWaiting,
    addMessage,
    replaceOptimisticMessage,
    reconcileFromDb,
  } = useAiChatStore();

  const sessionMessages = allMessages[session.id] ?? [];
  const streamState = streaming[session.id] ?? null;
  const isWaiting = waiting[session.id] ?? false;
  const sessionError = errors[session.id] ?? null;

  const { isLoading } = useQuery({
    queryKey: ['ai-messages', session.id],
    queryFn: async () => {
      const res = await api.aiMessages(session.id);
      setMessages(session.id, res.messages);
      // After merging the DB snapshot, check whether any streamed messages
      // were missed (e.g. WS was disconnected) and recover them.
      reconcileFromDb(session.id, res.messages);
      return res;
    },
    // Always treat the cache as stale so that re-fetches (e.g. triggered by a
    // WS reconnect) actually hit the server and pick up any missed messages.
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  // When the WebSocket reconnects, force a re-fetch of this session's messages.
  // Any ai:token events that arrived while the connection was down are already
  // persisted in the DB by the server; this re-fetch surfaces them.
  useEffect(() => {
    const unsubscribe = onWsReconnect(() => {
      queryClient.invalidateQueries({ queryKey: ['ai-messages', session.id] });
    });
    return unsubscribe;
  }, [session.id, queryClient]);

  // Auto-scroll
  useEffect(() => {
    if (atBottom && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: 'LAST', behavior: 'smooth', align: 'end' });
    }
  }, [sessionMessages.length, streamState?.content, atBottom]);

  useEffect(() => {
    setTimeout(() => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto', align: 'end' });
    }, 50);
  }, [session.id, isLoading]);

  const sendMutation = useMutation({
    mutationFn: (content: string) => api.sendAiMessage(session.id, content),
    onSuccess: (message) => {
      replaceOptimisticMessage(session.id, message);
      setWaiting(session.id, true);
      setTimeout(() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth', align: 'end' }), 50);
    },
    onError: (err) => toast({ title: 'Failed to send message', description: String(err), variant: 'destructive' }),
  });

  const isStreaming = streamState !== null;
  const isBusy = sendMutation.isPending || isStreaming || isWaiting;

  const send = () => {
    const content = input.trim();
    if (!content || isBusy || !connected) return;
    setInput('');
    setError(session.id, null);
    const optimisticMsg: AiMessage = {
      id: `opt-${Date.now()}`,
      sessionId: session.id,
      role: 'user',
      content,
      toolCalls: null,
      streaming: false,
      createdAt: new Date().toISOString(),
    };
    addMessage(session.id, optimisticMsg);
    sendMutation.mutate(content);
    if (composerRef.current) composerRef.current.style.height = 'auto';
  };

  type ChatItem =
    | { type: 'message'; msg: AiMessage }
    | { type: 'toolcall'; toolCall: AiToolCall; pending: boolean; key: string }
    | { type: 'streaming'; state: typeof streamState }
    | { type: 'thinking' };

  const items: ChatItem[] = [];
  // Exclude in-flight assistant rows — the live { type: 'streaming' } bubble
  // below already renders them; including them here would cause a duplicate
  // blank bubble while the stream is active.
  for (const msg of sessionMessages.filter((m) => !m.streaming)) {
    // Inject tool call rows before each assistant message that has them
    if (msg.role === 'assistant') {
      const tcs = parseToolCalls(msg.toolCalls);
      for (let i = 0; i < tcs.length; i++) {
        items.push({ type: 'toolcall', toolCall: tcs[i], pending: false, key: `${msg.id}-tc-${i}` });
      }
    }
    items.push({ type: 'message', msg });
  }
  // During streaming: inject live tool call rows (pending state) before the streaming bubble
  if (isStreaming && streamState) {
    const liveTcs = streamState.toolCalls ?? [];
    for (let i = 0; i < liveTcs.length; i++) {
      items.push({ type: 'toolcall', toolCall: liveTcs[i], pending: liveTcs[i].output === undefined, key: `stream-tc-${i}` });
    }
    items.push({ type: 'streaming', state: streamState });
  }
  if (!isStreaming && isWaiting) items.push({ type: 'thinking' });

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Error banner */}
      <AnimatePresence>
        {sessionError && (
          <div className="px-0">
            <ErrorBanner error={sessionError} onDismiss={() => setError(session.id, null)} />
          </div>
        )}
      </AnimatePresence>

      {/* Messages */}
      <div className="flex-1 min-h-0 relative">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3 max-w-xs">
              <div className="w-10 h-10 mx-auto rounded-xl bg-primary/10 border border-primary/15 flex items-center justify-center">
                <Bot className="w-5 h-5 text-primary/60" />
              </div>
              <p className="text-sm text-muted-foreground">
                {connected
                  ? 'Send a message to start the conversation.'
                  : 'Connect an AI agent in Settings to begin.'}
              </p>
            </div>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={items}
            style={{ height: '100%' }}
            atBottomStateChange={setAtBottom}
            followOutput="smooth"
            initialTopMostItemIndex={items.length > 0 ? items.length - 1 : 0}
            alignToBottom
            itemContent={(_, item) => {
              if (item.type === 'thinking') {
                return (
                  <div className="px-6 py-2 flex gap-3 items-start">
                    <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center mt-0.5">
                      <Bot className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div className="bg-card border border-border rounded-2xl rounded-tl-md px-4 py-3">
                      <ThinkingDots />
                    </div>
                  </div>
                );
              }
              if (item.type === 'toolcall') {
                return (
                  <ToolCallActivityRow
                    key={item.key}
                    toolCall={item.toolCall}
                    pending={item.pending}
                  />
                );
              }
              if (item.type === 'streaming' && item.state) {
                const streamMsg: AiMessage = {
                  id: item.state.messageId,
                  sessionId: session.id,
                  role: 'assistant',
                  content: item.state.content,
                  toolCalls: null,
                  streaming: true,
                  createdAt: new Date().toISOString(),
                };
                return (
                  <div className="px-6 py-2">
                    <MessageBubble
                      message={streamMsg}
                      isStreaming
                      streamContent={item.state.content}
                    />
                  </div>
                );
              }
              if (item.type === 'message') {
                return (
                  <div className="px-6 py-2">
                    <MessageBubble message={item.msg} />
                  </div>
                );
              }
              return null;
            }}
            components={{
              Header: () => <div className="h-4" />,
              Footer: () => <div className="h-4" />,
            }}
          />
        )}

        {/* Scroll-to-bottom button */}
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              onClick={() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth', align: 'end' })}
              className="absolute bottom-4 right-6 w-8 h-8 rounded-full glass border border-border flex items-center justify-center hover:border-primary/30 transition-colors shadow-warm-md"
            >
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-border">
        <div
          className={cn(
            'flex items-center gap-3 rounded-2xl border bg-secondary px-4 py-3 transition-all duration-150',
            !connected || isBusy
              ? 'border-border opacity-75 cursor-not-allowed'
              : 'border-border focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 cursor-text',
          )}
          onClick={() => composerRef.current?.focus()}
        >
          <textarea
            ref={composerRef}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder={
              !connected ? 'Connect an AI agent in Settings to start chatting…'
              : isBusy    ? 'AI is responding…'
              :             'Message your AI…'
            }
            disabled={isBusy || !connected}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none min-h-[24px] max-h-[180px] leading-6 disabled:cursor-not-allowed"
            style={{ height: 'auto' }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || isBusy || !connected}
            className={cn(
              'flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-150',
              input.trim() && !isBusy && connected
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-amber'
                : 'bg-white/5 text-muted-foreground cursor-not-allowed',
            )}
          >
            {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          </button>
        </div>
        <p className="text-center text-[10px] text-muted-foreground/30 mt-2">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AiChat() {
  const queryClient = useQueryClient();
  const { sessions, setSessions, addSession, removeSession, updateSession, activeId, setActiveId } = useAiChatStore();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  // Auto-select the first tab when no tab is active but sessions are available
  useEffect(() => {
    if (!activeId && sessions.length > 0) {
      setActiveId(sessions[0]!.id);
    }
  }, [activeId, sessions]);

  // Load global connection status
  const { data: conn } = useQuery<AiConnection>({
    queryKey: ['ai-connection'],
    queryFn: api.aiConnection,
    staleTime: 30000,
  });
  const connected = conn?.configured ?? false;

  // Load sessions — always fetches in the background to stay in sync with the
  // server, but the UI hydrates immediately from the persisted store so there
  // is no loading gate on return visits or after a reload.
  useQuery({
    queryKey: ['ai-sessions'],
    queryFn: async () => {
      const list = await api.aiSessions();
      setSessions(list);
      if (!activeId && list.length > 0) setActiveId(list[0]!.id);
      return list;
    },
    staleTime: 30000,
  });

  // Create session
  const createMutation = useMutation({
    mutationFn: () => api.createAiSession(),
    onSuccess: (session) => {
      addSession(session);
      setActiveId(session.id);
      queryClient.invalidateQueries({ queryKey: ['ai-sessions'] });
    },
    onError: (err) => toast({ title: 'Failed to create session', description: String(err), variant: 'destructive' }),
  });

  // Delete session
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteAiSession(id),
    onSuccess: (_, id) => {
      removeSession(id);
      queryClient.invalidateQueries({ queryKey: ['ai-sessions'] });
      setConfirmDeleteId(null);
    },
    onError: (err) => {
      toast({ title: 'Failed to delete session', description: String(err), variant: 'destructive' });
      setConfirmDeleteId(null);
    },
  });

  // Rename session
  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.updateAiSession(id, { title }),
    onSuccess: (updated) => {
      updateSession(updated.id, { title: updated.title });
      queryClient.invalidateQueries({ queryKey: ['ai-sessions'] });
    },
  });

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background relative">
      {/* Tab bar */}
      {sessions.length > 0 && (
        <TabBar
          sessions={sessions}
          activeId={activeId}
          onSelect={setActiveId}
          onNew={() => createMutation.mutate()}
          onClose={(id) => setConfirmDeleteId(id)}
          onRename={(id, title) => renameMutation.mutate({ id, title })}
          creating={createMutation.isPending}
        />
      )}

      {/* Not-connected banner (below tab bar, above content) */}
      {!connected && sessions.length > 0 && <NotConnectedBanner />}

      {/* Main content */}
      {sessions.length === 0 ? (
        <EmptyState
          onNew={() => createMutation.mutate()}
          creating={createMutation.isPending}
          connected={connected}
        />
      ) : activeSession ? (
        <ChatWindow
          key={activeSession.id}
          session={activeSession}
          connected={connected}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Select a session or create a new one.
        </div>
      )}

      {/* Confirm delete modal */}
      <AnimatePresence>
        {confirmDeleteId && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-background/80 backdrop-blur-sm"
              onClick={() => setConfirmDeleteId(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative card-warm p-6 w-full max-w-sm space-y-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                  <Trash2 className="w-4 h-4 text-red-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Delete this chat?</h3>
                  <p className="text-xs text-muted-foreground">
                    {sessions.find((s) => s.id === confirmDeleteId)?.title}
                  </p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                This will permanently delete the chat and all its messages.
              </p>
              <div className="flex gap-2">
                <button onClick={() => setConfirmDeleteId(null)} className="btn-secondary flex-1">Cancel</button>
                <button
                  onClick={() => deleteMutation.mutate(confirmDeleteId)}
                  disabled={deleteMutation.isPending}
                  className="btn-danger flex-1"
                >
                  {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Delete
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
