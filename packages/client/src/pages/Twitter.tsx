/**
 * Twitter / X page — two-tab layout: DMs and Feed/Explore.
 *
 * DMs: stored in SQLite, synced every 2 minutes.
 * Feed/Explore: live from Twitter API with 15-min cache.
 * All actions go through the outbox for approval.
 */

import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Virtuoso } from 'react-virtuoso';
import {
  MessageSquare, Search, RefreshCw, Loader2, Heart, Repeat2,
  MessageCircle, Quote, User, TrendingUp, X, Send,
  ExternalLink, ChevronRight, ArrowLeft, AtSign, Home,
  Newspaper, Twitter, Hash, BarChart3, ChevronUp, ChevronDown as ChevronDownIcon,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend,
} from 'recharts';
import {
  api,
  type Tweet, type TwitterDm, type TwitterConversation, type TwitterProfile,
  type TweetAnalytic, type TwitterAnalytics, type TwitterAnalyticsByDay,
} from '@/lib/api';
import { Skeleton } from '@/components/shared/Skeleton';
import { cn, timeAgo, formatDate } from '@/lib/utils';
import { toast } from '@/store';
import { useConnectionStore } from '@/store';

// ─── Tweet Card ────────────────────────────────────────────────────────────────

function TweetAvatar({ tweet, size = 10 }: { tweet: Tweet; size?: number }) {
  const hue = tweet.username.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffff, 0) % 360;
  return (
    <div
      className={cn(`w-${size} h-${size} rounded-full flex-shrink-0 flex items-center justify-center text-sm font-bold text-white`)}
      style={{ background: `hsl(${hue}, 52%, 40%)` }}
    >
      {tweet.name.charAt(0).toUpperCase()}
    </div>
  );
}

function TweetText({ text }: { text: string }) {
  // Highlight @mentions, #hashtags, and URLs
  const parts = text.split(/(@\w+|#\w+|https?:\/\/\S+)/g);
  return (
    <p className="text-sm leading-relaxed text-foreground/90 break-words">
      {parts.map((part, i) => {
        if (part.startsWith('@')) return <span key={i} className="text-sky-400 hover:underline cursor-pointer">{part}</span>;
        if (part.startsWith('#')) return <span key={i} className="text-sky-400 hover:underline cursor-pointer">{part}</span>;
        if (part.startsWith('http')) return <a key={i} href={part} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">{part}</a>;
        return part;
      })}
    </p>
  );
}

interface TweetCardProps {
  tweet: Tweet;
  onThread?: (id: string) => void;
  compact?: boolean;
}

function TweetCard({ tweet, onThread, compact }: TweetCardProps) {
  const qc = useQueryClient();

  const action = useMutation({
    mutationFn: (params: Parameters<typeof api.twitterAction>[0]) => api.twitterAction(params),
    onSuccess: (_, params) => {
      toast({ title: `${params.action} queued for approval`, variant: 'success' });
      qc.invalidateQueries({ queryKey: ['outbox'] });
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className={cn('border-b border-border px-4 py-3.5 hover:bg-white/[0.02] transition-colors', compact && 'px-3 py-2.5')}>
      <div className="flex gap-3">
        <TweetAvatar tweet={tweet} size={compact ? 8 : 10} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-sm font-semibold truncate">{tweet.name}</span>
            <span className="text-xs text-muted-foreground">@{tweet.username}</span>
            {tweet.timestamp > 0 && (
              <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">{timeAgo(new Date(tweet.timestamp * 1000).toISOString())}</span>
            )}
          </div>

          {tweet.isRetweet && tweet.retweetedStatus && (
            <p className="text-[11px] text-muted-foreground mb-1 flex items-center gap-1">
              <Repeat2 className="w-3 h-3" /> Retweeted
            </p>
          )}

          <TweetText text={tweet.text} />

          {/* Media */}
          {tweet.photos.length > 0 && (
            <div className={cn('mt-2 grid gap-1.5 rounded-xl overflow-hidden', tweet.photos.length === 1 ? '' : 'grid-cols-2')}>
              {tweet.photos.map((p, i) => (
                <img key={i} src={p.url} alt={p.alt || ''} className="w-full object-cover rounded-lg max-h-72" loading="lazy" />
              ))}
            </div>
          )}

          {/* Quote tweet */}
          {tweet.quotedStatus && (
            <div className="mt-2 rounded-xl border border-border/60 bg-secondary/30 px-3 py-2.5">
              <div className="flex items-baseline gap-1.5 mb-1">
                <span className="text-xs font-semibold">{tweet.quotedStatus.name}</span>
                <span className="text-[11px] text-muted-foreground">@{tweet.quotedStatus.username}</span>
              </div>
              <p className="text-xs text-foreground/80 line-clamp-3">{tweet.quotedStatus.text}</p>
            </div>
          )}

          {/* Actions */}
          {!compact && (
            <div className="flex items-center gap-4 mt-3 -ml-1">
              <button
                onClick={() => onThread?.(tweet.id)}
                className="flex items-center gap-1.5 text-muted-foreground hover:text-sky-400 transition-colors text-xs"
              >
                <MessageCircle className="w-4 h-4" />
                <span>{tweet.replies || ''}</span>
              </button>
              <button
                onClick={() => action.mutate({ action: 'retweet', tweetId: tweet.id })}
                className="flex items-center gap-1.5 text-muted-foreground hover:text-emerald-400 transition-colors text-xs"
              >
                <Repeat2 className="w-4 h-4" />
                <span>{tweet.retweets || ''}</span>
              </button>
              <button
                onClick={() => action.mutate({ action: 'like', tweetId: tweet.id })}
                className="flex items-center gap-1.5 text-muted-foreground hover:text-red-400 transition-colors text-xs"
              >
                <Heart className="w-4 h-4" />
                <span>{tweet.likes || ''}</span>
              </button>
              <button
                onClick={() => action.mutate({ action: 'quote', quotedId: tweet.id, text: '' })}
                className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors text-xs"
              >
                <Quote className="w-4 h-4" />
              </button>
              <a href={tweet.permanentUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary transition-colors ml-auto">
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Profile Card ──────────────────────────────────────────────────────────────

function ProfileCard({ profile, onTweets }: { profile: TwitterProfile; onTweets?: () => void }) {
  const qc = useQueryClient();
  const follow = useMutation({
    mutationFn: () => api.twitterAction({ action: 'follow', handle: profile.username }),
    onSuccess: () => toast({ title: 'Follow queued for approval', variant: 'success' }),
  });

  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-3.5 hover:bg-white/[0.02] transition-colors">
      <div className="w-10 h-10 rounded-full bg-secondary flex-shrink-0 flex items-center justify-center font-bold text-sm"
        style={{ background: `hsl(${profile.username.charCodeAt(0) % 360}, 52%, 40%)` }}>
        {profile.name.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">{profile.name}</p>
            <p className="text-xs text-muted-foreground">@{profile.username}</p>
          </div>
          <button onClick={() => follow.mutate()} disabled={follow.isPending} className="btn-secondary text-xs py-1 px-3 flex-shrink-0">
            {follow.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Follow
          </button>
        </div>
        {profile.biography && <p className="text-xs text-foreground/80 mt-1 line-clamp-2">{profile.biography}</p>}
        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
          {profile.followersCount !== undefined && <span><span className="font-semibold text-foreground">{profile.followersCount.toLocaleString()}</span> followers</span>}
          {profile.followingCount !== undefined && <span><span className="font-semibold text-foreground">{profile.followingCount.toLocaleString()}</span> following</span>}
        </div>
        {onTweets && (
          <button onClick={onTweets} className="btn-ghost text-xs mt-1 -ml-1 gap-1 text-muted-foreground">
            <Newspaper className="w-3.5 h-3.5" /> View tweets <ChevronRight className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── DM Tab ────────────────────────────────────────────────────────────────────

function DmTab() {
  const qc = useQueryClient();
  const [selectedConv, setSelectedConv] = useState<TwitterConversation | null>(null);
  const [composer, setComposer] = useState('');
  const statuses = useConnectionStore((s) => s.statuses);
  const myUserId = statuses['twitter']?.accountId;

  const { data, isLoading } = useQuery({
    queryKey: ['twitter-dms'],
    queryFn: () => api.twitterDms({ limit: 50 }),
    refetchInterval: 60000,
  });

  const { data: messagesData } = useQuery({
    queryKey: ['twitter-dm-conv', selectedConv?.conversationId],
    queryFn: () => api.twitterDmConversation(selectedConv!.conversationId),
    enabled: !!selectedConv,
    refetchInterval: 30000,
  });

  const syncMutation = useMutation({
    mutationFn: api.twitterSyncDms,
    onSuccess: (d) => { toast({ title: `Synced ${d.newMessages} new messages` }); qc.invalidateQueries({ queryKey: ['twitter-dms'] }); },
  });

  const sendMutation = useMutation({
    mutationFn: () => api.twitterAction({ action: 'dm', conversationId: selectedConv!.conversationId, text: composer.trim() }),
    onSuccess: () => { toast({ title: 'DM queued for approval', variant: 'success' }); setComposer(''); qc.invalidateQueries({ queryKey: ['outbox'] }); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const conversations = data?.conversations || [];
  const messages = messagesData?.messages || [];

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Conversation list */}
      <div className="w-72 flex-shrink-0 border-r border-border flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <h3 className="text-sm font-semibold flex-1">Direct Messages</h3>
          <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} className="btn-ghost p-1.5">
            <RefreshCw className={cn('w-3.5 h-3.5', syncMutation.isPending && 'animate-spin')} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex gap-3 p-2">
                  <Skeleton className="w-10 h-10 rounded-full flex-shrink-0" />
                  <div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-3/4" /><Skeleton className="h-2.5 w-1/2" /></div>
                </div>
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
              <MessageSquare className="w-8 h-8 opacity-20" />
              <p className="text-sm">No conversations</p>
            </div>
          ) : (
            conversations.map((conv) => {
              const last = conv.lastMessage;
              const isSelected = selectedConv?.conversationId === conv.conversationId;
              return (
                <button
                  key={conv.conversationId}
                  onClick={() => setSelectedConv(conv)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 border-b border-border/50 text-left transition-colors',
                    isSelected ? 'bg-primary/8 border-l-2 border-l-primary' : 'hover:bg-white/[0.025] border-l-2 border-l-transparent',
                  )}
                >
                  <div className="w-10 h-10 rounded-full bg-secondary/70 flex items-center justify-center font-bold text-sm flex-shrink-0 text-sky-400">
                    {(last?.senderHandle || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">@{last?.senderHandle || conv.conversationId}</p>
                    <p className="text-xs text-muted-foreground truncate">{last?.text || '(no messages)'}</p>
                  </div>
                  <p className="text-[10px] text-muted-foreground flex-shrink-0">{last?.createdAt ? timeAgo(last.createdAt) : ''}</p>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Message thread */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedConv ? (
          <>
            <div className="px-4 py-3 border-b border-border flex items-center gap-3 flex-shrink-0">
              <AtSign className="w-4 h-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">
                @{messages[0]?.senderHandle || selectedConv.conversationId}
              </h4>
            </div>
            <div className="flex-1 overflow-y-auto flex flex-col-reverse px-5 py-4 gap-3">
              {[...messages].reverse().map((msg) => {
                const isMine = msg.senderId === myUserId;
                return (
                  <div key={msg.messageId} className={cn('flex gap-2.5 max-w-lg', isMine && 'ml-auto flex-row-reverse')}>
                    {!isMine && (
                      <div className="w-7 h-7 rounded-full bg-secondary/70 flex items-center justify-center text-[11px] font-bold flex-shrink-0 text-sky-400">
                        {(msg.senderHandle || '?').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className={cn(
                      'rounded-2xl px-3.5 py-2.5 text-sm',
                      isMine ? 'bg-primary/15 text-foreground rounded-tr-sm' : 'bg-secondary/60 rounded-tl-sm',
                    )}>
                      <p className="leading-relaxed">{msg.text || '(media)'}</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5 text-right">{timeAgo(msg.createdAt)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-4 pb-4 pt-2 border-t border-border flex-shrink-0">
              <div className="flex gap-2">
                <textarea
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (composer.trim()) sendMutation.mutate(); } }}
                  placeholder="Type a message… (Enter to queue)"
                  rows={1}
                  className="input-warm flex-1 resize-none text-sm py-2.5"
                />
                <button onClick={() => sendMutation.mutate()} disabled={!composer.trim() || sendMutation.isPending} className="btn-primary px-3">
                  {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <MessageSquare className="w-10 h-10 opacity-20" />
            <p className="text-sm">Select a conversation</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Feed/Explore Tab ──────────────────────────────────────────────────────────

type ExploreView = 'feed' | 'search' | 'trending' | 'profile' | 'thread';

function FeedTab() {
  const qc = useQueryClient();
  const [view, setView] = useState<ExploreView>('feed');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'Latest' | 'Top' | 'People'>('Latest');
  const [profileHandle, setProfileHandle] = useState('');
  const [threadId, setThreadId] = useState('');
  const [replyTarget, setReplyTarget] = useState<Tweet | null>(null);
  const [tweetComposer, setTweetComposer] = useState('');

  const feedQuery = useQuery({ queryKey: ['twitter-feed'], queryFn: () => api.twitterFeed(20), enabled: view === 'feed', staleTime: 15 * 60 * 1000 });
  const searchQuery2 = useQuery({ queryKey: ['twitter-search', searchQuery, searchMode], queryFn: () => api.twitterSearch(searchQuery, 20, searchMode), enabled: view === 'search' && !!searchQuery, staleTime: 15 * 60 * 1000 });
  const trendsQuery = useQuery({ queryKey: ['twitter-trends'], queryFn: api.twitterTrends, enabled: view === 'trending', staleTime: 15 * 60 * 1000 });
  const profileQuery = useQuery({ queryKey: ['twitter-profile', profileHandle], queryFn: () => api.twitterUserProfile(profileHandle), enabled: view === 'profile' && !!profileHandle, staleTime: 15 * 60 * 1000 });
  const profileTweets = useQuery({ queryKey: ['twitter-user-tweets', profileHandle], queryFn: () => api.twitterUserTweets(profileHandle, 20), enabled: view === 'profile' && !!profileHandle, staleTime: 15 * 60 * 1000 });
  const threadQuery = useQuery({ queryKey: ['twitter-thread', threadId], queryFn: () => api.twitterThread(threadId), enabled: view === 'thread' && !!threadId, staleTime: 15 * 60 * 1000 });

  const postMutation = useMutation({
    mutationFn: () => api.twitterAction({
      action: replyTarget ? 'reply' : 'tweet',
      text: tweetComposer.trim(),
      replyToId: replyTarget?.id,
    }),
    onSuccess: () => {
      toast({ title: 'Tweet queued for approval', variant: 'success' });
      setTweetComposer(''); setReplyTarget(null);
      qc.invalidateQueries({ queryKey: ['outbox'] });
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const openThread = (id: string) => { setThreadId(id); setView('thread'); };
  const openProfile = (handle: string) => { setProfileHandle(handle); setView('profile'); };

  const NAV_ITEMS: Array<{ id: ExploreView; icon: React.ComponentType<{ className?: string }>; label: string }> = [
    { id: 'feed', icon: Home, label: 'Feed' },
    { id: 'search', icon: Search, label: 'Search' },
    { id: 'trending', icon: TrendingUp, label: 'Trending' },
    { id: 'profile', icon: User, label: 'Profile' },
  ];

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left nav */}
      <div className="w-52 flex-shrink-0 border-r border-border flex flex-col py-3 space-y-0.5 px-2.5">
        {NAV_ITEMS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors text-left',
              view === id ? 'bg-primary/12 text-amber-400' : 'text-muted-foreground hover:text-foreground hover:bg-white/5',
            )}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {label}
          </button>
        ))}

        <div className="pt-4 px-1">
          <p className="text-2xs text-muted-foreground/50 uppercase tracking-wider mb-2 px-2">Compose</p>
          <textarea
            value={tweetComposer}
            onChange={(e) => setTweetComposer(e.target.value)}
            placeholder={replyTarget ? `Reply to @${replyTarget.username}…` : 'What\'s on your mind?'}
            rows={3}
            className="input-warm text-xs resize-none w-full"
          />
          {replyTarget && (
            <div className="flex items-center gap-2 mt-1.5">
              <p className="text-[11px] text-muted-foreground flex-1">Replying to @{replyTarget.username}</p>
              <button onClick={() => setReplyTarget(null)} className="btn-ghost p-0.5"><X className="w-3 h-3" /></button>
            </div>
          )}
          <button
            onClick={() => postMutation.mutate()}
            disabled={!tweetComposer.trim() || postMutation.isPending}
            className="btn-primary text-xs w-full mt-2"
          >
            {postMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Twitter className="w-3.5 h-3.5" />}
            {replyTarget ? 'Reply' : 'Tweet'}
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {/* Search bar */}
        {view === 'search' && (
          <div className="sticky top-0 z-10 px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search Twitter…"
                  className="w-full bg-secondary border border-border rounded-xl pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                  onKeyDown={(e) => e.key === 'Enter' && qc.invalidateQueries({ queryKey: ['twitter-search'] })}
                />
              </div>
              <div className="flex items-center gap-0.5 bg-secondary border border-border rounded-xl p-0.5">
                {(['Latest', 'Top', 'People'] as const).map((m) => (
                  <button key={m} onClick={() => setSearchMode(m)}
                    className={cn('px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all', searchMode === m ? 'bg-background text-foreground shadow-warm-sm' : 'text-muted-foreground hover:text-foreground')}
                  >{m}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Profile search */}
        {view === 'profile' && (
          <div className="sticky top-0 z-10 px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm">
            <div className="relative">
              <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                autoFocus
                value={profileHandle}
                onChange={(e) => setProfileHandle(e.target.value.replace('@', ''))}
                placeholder="Enter Twitter handle…"
                className="w-full bg-secondary border border-border rounded-xl pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
          </div>
        )}

        {/* Thread back button */}
        {view === 'thread' && (
          <div className="sticky top-0 z-10 px-4 py-3 border-b border-border bg-background/95 backdrop-blur-sm">
            <button onClick={() => setView('feed')} className="btn-ghost text-xs gap-1.5">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to feed
            </button>
          </div>
        )}

        {/* Content */}
        {view === 'feed' && (
          <>
            {feedQuery.isLoading ? (
              <div className="divide-y divide-border">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex gap-3 p-4">
                    <Skeleton className="w-10 h-10 rounded-full flex-shrink-0" />
                    <div className="flex-1 space-y-2"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-5/6" /></div>
                  </div>
                ))}
              </div>
            ) : feedQuery.error ? (
              <div className="flex flex-col items-center py-12 gap-3 text-muted-foreground">
                <Twitter className="w-10 h-10 opacity-20" />
                <p className="text-sm">Could not load feed</p>
                <button onClick={() => feedQuery.refetch()} className="btn-secondary text-xs">Try again</button>
              </div>
            ) : (
              <>
                {(feedQuery.data?.tweets || []).map((t) => (
                  <TweetCard key={t.id} tweet={t} onThread={openThread} />
                ))}
                <div className="flex justify-center py-6">
                  <button onClick={() => feedQuery.refetch()} className="btn-secondary text-xs">
                    <RefreshCw className="w-3.5 h-3.5" /> Load more
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {view === 'search' && searchQuery && (
          searchQuery2.isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : searchMode === 'People' ? (
            <div className="divide-y divide-border">
              {(searchQuery2.data?.profiles || []).map((p) => (
                <ProfileCard key={p.username} profile={p} onTweets={() => openProfile(p.username)} />
              ))}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {(searchQuery2.data?.tweets || []).map((t) => (
                <TweetCard key={t.id} tweet={t} onThread={openThread} />
              ))}
            </div>
          )
        )}

        {view === 'trending' && (
          trendsQuery.isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="p-4 space-y-2">
              <p className="section-label">Trending Now</p>
              <div className="flex flex-wrap gap-2 mt-3">
                {(trendsQuery.data?.trends || []).map((trend, i) => (
                  <button
                    key={i}
                    onClick={() => { setSearchQuery(trend); setSearchMode('Top'); setView('search'); }}
                    className="chip chip-zinc hover:chip-amber transition-colors"
                  >
                    <Hash className="w-3 h-3" />
                    {trend.replace('#', '')}
                  </button>
                ))}
              </div>
            </div>
          )
        )}

        {view === 'profile' && profileHandle && (
          profileQuery.isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : profileQuery.data ? (
            <div>
              <div className="p-4 border-b border-border">
                <ProfileCard profile={profileQuery.data} />
              </div>
              <div className="divide-y divide-border">
                {(profileTweets.data?.tweets || []).map((t) => (
                  <TweetCard key={t.id} tweet={t} onThread={openThread} />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center py-12 gap-3 text-muted-foreground">
              <User className="w-10 h-10 opacity-20" />
              <p className="text-sm">Enter a handle to look up a profile</p>
            </div>
          )
        )}

        {view === 'thread' && threadId && (
          threadQuery.isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="divide-y divide-border">
              {(threadQuery.data?.tweets || []).map((t, i) => (
                <TweetCard key={t.id} tweet={t} onThread={openThread} compact={i > 0} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ─── Analytics Tab ────────────────────────────────────────────────────────────

const CHART_COLORS = { likes: '#F59E0B', retweets: '#38BDF8', replies: '#8B5CF6' };

const ChartTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !payload) return null;
  return (
    <div className="card-warm border-border/80 p-3 text-xs shadow-warm-lg min-w-[130px]">
      <p className="text-muted-foreground mb-2 font-medium">{String(label)}</p>
      {(payload as Array<{ name: string; value: number; color: string }>).map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span style={{ color: p.color }} className="capitalize">{p.name}</span>
          <span className="font-semibold text-foreground">{(p.value ?? 0).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

type SortCol = 'date' | 'likes' | 'retweets' | 'replies' | 'totalEngagement';
type SortDir = 'asc' | 'desc';

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="card-warm p-4 space-y-1">
      <p className="text-2xs text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={cn('text-2xl font-bold', color || 'text-foreground')}>{typeof value === 'number' ? value.toLocaleString() : value}</p>
      {sub && <p className="text-[11px] text-muted-foreground truncate">{sub}</p>}
    </div>
  );
}

function AnalyticsTab({ handle }: { handle: string }) {
  const [granularity, setGranularity] = useState<'day' | 'week'>('day');
  const [sortCol, setSortCol] = useState<SortCol>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['twitter-analytics'],
    queryFn: api.twitterAnalytics,
    staleTime: 15 * 60 * 1000,  // respects 15-min server cache
    retry: 1,
  });

  const { data: profile } = useQuery({
    queryKey: ['twitter-me'],
    queryFn: api.twitterMe,
    staleTime: 30 * 60 * 1000,
  });

  // Aggregate byDay into byWeek client-side
  const chartData = useMemo((): TwitterAnalyticsByDay[] => {
    if (!data?.byDay) return [];
    if (granularity === 'day') return data.byDay;

    // Group into ISO weeks (Monday-based)
    const weekMap = new Map<string, TwitterAnalyticsByDay>();
    for (const d of data.byDay) {
      const dt = new Date(d.date);
      // Get Monday of the week
      const day = dt.getDay();
      const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(dt);
      monday.setDate(diff);
      const weekKey = monday.toISOString().split('T')[0];
      const bucket = weekMap.get(weekKey) ?? { date: weekKey, likes: 0, retweets: 0, replies: 0, tweets: 0 };
      bucket.likes    += d.likes;
      bucket.retweets += d.retweets;
      bucket.replies  += d.replies;
      bucket.tweets   += d.tweets;
      weekMap.set(weekKey, bucket);
    }
    return Array.from(weekMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [data?.byDay, granularity]);

  // Top 15 tweets for bar chart
  const topTweets = useMemo(() =>
    [...(data?.tweets ?? [])].sort((a, b) => b.totalEngagement - a.totalEngagement).slice(0, 15),
    [data?.tweets],
  );

  // Sorted tweet table
  const sortedTweets = useMemo(() => {
    const tweets = [...(data?.tweets ?? [])];
    tweets.sort((a, b) => {
      const av = a[sortCol] ?? 0;
      const bv = b[sortCol] ?? 0;
      return sortDir === 'desc'
        ? (bv > av ? 1 : bv < av ? -1 : 0)
        : (av > bv ? 1 : av < bv ? -1 : 0);
    });
    return tweets;
  }, [data?.tweets, sortCol, sortDir]);

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir((d) => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const SortIcon = ({ col }: { col: SortCol }) => {
    if (sortCol !== col) return <span className="text-muted-foreground/30 ml-0.5">↕</span>;
    return sortDir === 'desc'
      ? <ChevronDownIcon className="w-3 h-3 inline ml-0.5 text-primary" />
      : <ChevronUp className="w-3 h-3 inline ml-0.5 text-primary" />;
  };

  const axisStyle = { fontSize: 10, fill: 'hsl(25 8% 42%)' };
  const gridColor = 'hsl(20 8% 14%)';

  if (isLoading) return (
    <div className="p-6 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1,2,3,4].map(i => <div key={i} className="card-warm p-4 space-y-2"><Skeleton className="h-3 w-1/2" /><Skeleton className="h-7 w-2/3" /></div>)}
      </div>
      <Skeleton className="h-48 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );

  if (error) return (
    <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
      <p className="text-sm">Failed to load analytics</p>
      <button onClick={() => refetch()} className="btn-secondary text-xs">Try again</button>
    </div>
  );

  if (!data) return null;

  const { summary } = data;

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">@{handle} — Tweet Analytics</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Last {summary.totalTweets} tweets</p>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="btn-ghost text-xs gap-1.5">
          <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Followers" value={profile?.followersCount ?? '—'} sub={`${profile?.followingCount ?? 0} following`} color="text-sky-400" />
        <StatCard label="Total Likes" value={summary.totalLikes} sub={`${summary.avgLikes} avg / tweet`} color="text-amber-400" />
        <StatCard label="Total Retweets" value={summary.totalRetweets} sub={`${summary.avgRetweets} avg / tweet`} color="text-sky-400" />
        <StatCard label="Avg Engagement" value={summary.avgEngagement} sub={`${summary.totalReplies} total replies`} color="text-violet-400" />
      </div>

      {/* Best tweet highlight */}
      {summary.bestTweet && (
        <div className="card-warm p-4 border-primary/15 amber-surface">
          <p className="text-2xs text-muted-foreground uppercase tracking-wider mb-2">Best performing tweet</p>
          <p className="text-sm leading-relaxed line-clamp-3 text-foreground/90 mb-2">{summary.bestTweet.text}</p>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span><Heart className="w-3 h-3 inline mr-0.5 text-amber-400" />{summary.bestTweet.likes}</span>
            <span><Repeat2 className="w-3 h-3 inline mr-0.5 text-sky-400" />{summary.bestTweet.retweets}</span>
            <span><MessageCircle className="w-3 h-3 inline mr-0.5 text-violet-400" />{summary.bestTweet.replies}</span>
            <span className="ml-auto chip chip-amber">{summary.bestTweet.totalEngagement} total</span>
            {summary.bestTweet.url && (
              <a href={summary.bestTweet.url} target="_blank" rel="noreferrer" className="btn-ghost p-1 text-muted-foreground hover:text-primary">
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>
      )}

      {/* Engagement over time */}
      <div className="card-warm p-5">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h4 className="text-sm font-semibold">Engagement Over Time</h4>
            <p className="text-xs text-muted-foreground mt-0.5">Likes, retweets, and replies per {granularity}</p>
          </div>
          <div className="flex items-center gap-0.5 bg-secondary border border-border rounded-xl p-1">
            {(['day', 'week'] as const).map((g) => (
              <button key={g} onClick={() => setGranularity(g)}
                className={cn('px-2.5 py-1 rounded-lg text-xs font-medium transition-all capitalize', granularity === g ? 'bg-background text-foreground shadow-warm-sm' : 'text-muted-foreground hover:text-foreground')}
              >{g}</button>
            ))}
          </div>
        </div>
        {chartData.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">No data for this period</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <defs>
                {Object.entries(CHART_COLORS).map(([k, c]) => (
                  <linearGradient key={k} id={`g-${k}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={c} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={c} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="date" tick={axisStyle} tickLine={false} axisLine={false} />
              <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={32} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'hsl(20 8% 28%)', strokeWidth: 1 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="likes"    stroke={CHART_COLORS.likes}    fill={`url(#g-likes)`}    strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="retweets" stroke={CHART_COLORS.retweets} fill={`url(#g-retweets)`} strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="replies"  stroke={CHART_COLORS.replies}  fill={`url(#g-replies)`}  strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Top tweets bar chart */}
      {topTweets.length > 0 && (
        <div className="card-warm p-5">
          <h4 className="text-sm font-semibold mb-1">Top 15 Tweets by Engagement</h4>
          <p className="text-xs text-muted-foreground mb-5">Stacked: likes · retweets · replies</p>
          <ResponsiveContainer width="100%" height={topTweets.length * 32 + 40}>
            <BarChart data={topTweets.map(t => ({
              name: t.text.length > 45 ? t.text.slice(0, 45) + '…' : t.text,
              likes: t.likes, retweets: t.retweets, replies: t.replies,
              url: t.url,
            }))} layout="vertical" margin={{ left: 0, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
              <XAxis type="number" tick={axisStyle} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="name" tick={{ ...axisStyle, textAnchor: 'end' }} width={180} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(20 8% 18% / 0.5)' }} />
              <Bar dataKey="likes"    stackId="a" fill={CHART_COLORS.likes}    name="Likes"    radius={[0,0,0,0]} />
              <Bar dataKey="retweets" stackId="a" fill={CHART_COLORS.retweets} name="Retweets" radius={[0,0,0,0]} />
              <Bar dataKey="replies"  stackId="a" fill={CHART_COLORS.replies}  name="Replies"  radius={[0,3,3,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* All tweets table */}
      <div className="card-warm overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-secondary/20 flex items-center justify-between">
          <h4 className="text-sm font-semibold">All Tweets</h4>
          <span className="text-xs text-muted-foreground">{sortedTweets.length} tweets</span>
        </div>
        <div>
          {/* Table header */}
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-2 px-4 py-2 border-b border-border bg-secondary/30 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Tweet</span>
            <button onClick={() => toggleSort('date')} className="hover:text-foreground transition-colors text-right">Date<SortIcon col="date" /></button>
            <button onClick={() => toggleSort('likes')} className="hover:text-foreground transition-colors text-right"><Heart className="w-3 h-3 inline mr-0.5" /><SortIcon col="likes" /></button>
            <button onClick={() => toggleSort('retweets')} className="hover:text-foreground transition-colors text-right"><Repeat2 className="w-3 h-3 inline mr-0.5" /><SortIcon col="retweets" /></button>
            <button onClick={() => toggleSort('replies')} className="hover:text-foreground transition-colors text-right"><MessageCircle className="w-3 h-3 inline mr-0.5" /><SortIcon col="replies" /></button>
            <button onClick={() => toggleSort('totalEngagement')} className="hover:text-foreground transition-colors text-right">Total<SortIcon col="totalEngagement" /></button>
          </div>

          {/* Virtualized rows */}
          <Virtuoso
            style={{ height: Math.min(sortedTweets.length * 56, 400) }}
            data={sortedTweets}
            itemContent={(_, tweet: TweetAnalytic) => (
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-2 px-4 py-3 border-b border-border/50 hover:bg-white/[0.02] transition-colors items-center text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="truncate text-foreground/85 flex-1">{tweet.text}</p>
                  {tweet.url && (
                    <a href={tweet.url} target="_blank" rel="noreferrer" className="flex-shrink-0 text-muted-foreground/40 hover:text-primary transition-colors">
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
                <span className="text-muted-foreground text-right whitespace-nowrap">{tweet.date ? formatDate(tweet.date, 'MMM d') : '—'}</span>
                <span className="text-amber-400 font-medium text-right">{tweet.likes}</span>
                <span className="text-sky-400 font-medium text-right">{tweet.retweets}</span>
                <span className="text-violet-400 font-medium text-right">{tweet.replies}</span>
                <span className="font-semibold text-foreground text-right">{tweet.totalEngagement}</span>
              </div>
            )}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function TwitterPage() {
  const [tab, setTab] = useState<'dms' | 'feed' | 'analytics'>('dms');
  const { data: status } = useQuery({ queryKey: ['twitter-status'], queryFn: api.twitterStatus, refetchInterval: 30000 });

  if (!status?.connected) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-3.5rem)] gap-4 text-muted-foreground">
        <div className="w-20 h-20 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center">
          <Twitter className="w-10 h-10 opacity-20" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">Twitter / X not connected</p>
          <p className="text-xs opacity-60 mt-1">Add your credentials in Services → Messaging → Twitter</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border flex-shrink-0 px-6 gap-6">
        {([
          { id: 'dms',       label: 'Direct Messages', icon: MessageSquare },
          { id: 'feed',      label: 'Feed & Explore',  icon: Newspaper    },
          { id: 'analytics', label: 'Analytics',       icon: BarChart3    },
        ] as const).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'flex items-center gap-2 py-3 text-sm font-medium border-b-2 transition-all',
              tab === id ? 'border-primary text-amber-400' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {status.handle && (
            <span className="chip chip-sky text-xs">@{status.handle}</span>
          )}
          <span className="text-xs text-muted-foreground">{status.dmCount} DMs synced</span>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex">
        {tab === 'dms'       && <DmTab />}
        {tab === 'feed'      && <FeedTab />}
        {tab === 'analytics' && <AnalyticsTab handle={status.handle || ''} />}
      </div>
    </div>
  );
}
