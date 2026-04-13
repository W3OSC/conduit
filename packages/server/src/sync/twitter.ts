/**
 * TwitterSync — agent-twitter-client integration.
 *
 * Uses cookie/session-based auth — no Twitter developer account required.
 * Credentials (username + password + email) stored in settings under `credentials.twitter`.
 * Cookies are serialised and persisted so login is only needed once.
 *
 * DMs: synced to SQLite (twitter_dms table) via 2-minute polling.
 * Tweets/posts: NOT stored. Served live from API with 15-minute in-memory LRU cache.
 */

import { Scraper, SearchMode, type Tweet, type Profile } from 'agent-twitter-client';
import { getDb } from '../db/client.js';
import { twitterDms, settings, syncRuns } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { broadcast } from '../websocket/hub.js';

export interface TwitterCreds {
  username: string;
  password: string;
  email: string;
  cookies?: string;   // JSON array from scraper.getCookies()
  userId?: string;
  handle?: string;
  displayName?: string;
}

export interface TwitterAction {
  action: 'tweet' | 'reply' | 'quote' | 'retweet' | 'like' | 'follow' | 'dm';
  text?: string;
  replyToId?: string;
  quotedId?: string;
  tweetId?: string;
  handle?: string;
  conversationId?: string;
}

// ── LRU cache (15-min TTL) ────────────────────────────────────────────────────

interface CacheEntry { data: unknown; expiresAt: number }
const _cache = new Map<string, CacheEntry>();
const CACHE_TTL = 15 * 60 * 1000;

function fromCache<T>(key: string): T | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.data as T;
}

function toCache(key: string, data: unknown): void {
  // Evict oldest entries if cache grows too large
  if (_cache.size > 500) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

export function clearTwitterCache(pattern?: string): void {
  if (!pattern) { _cache.clear(); return; }
  for (const key of _cache.keys()) { if (key.includes(pattern)) _cache.delete(key); }
}

// ── TwitterSync class ─────────────────────────────────────────────────────────

const CREDS_KEY = 'credentials.twitter';

function saveCreds(creds: TwitterCreds): void {
  const db = getDb();
  const value = JSON.stringify(creds);
  db.insert(settings)
    .values({ key: CREDS_KEY, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

export class TwitterSync {
  private scraper: Scraper | null = null;
  private creds: TwitterCreds | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private seenFeedIds = new Set<string>(); // for fetchHomeTimeline
  private _cancelRequested = false;
  public connected = false;
  public accountInfo: { userId: string; displayName: string; handle: string } | null = null;

  cancelSync(): void {
    this._cancelRequested = true;
    const db = getDb();
    try {
      db.update(syncRuns)
        .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
        .where(and(eq(syncRuns.source, 'twitter'), eq(syncRuns.status, 'running')))
        .run();
      broadcast({ type: 'sync:progress', data: { service: 'twitter', status: 'idle' } });
    } catch { /* ignore */ }
  }

  async connect(creds: TwitterCreds): Promise<boolean> {
    this.creds = creds;
    this._cancelRequested = false;
    const scraper = new Scraper();

    // Restore session from stored cookies if available
    if (creds.cookies) {
      try {
        const cookies = JSON.parse(creds.cookies) as object[];
        await scraper.setCookies(cookies as Parameters<typeof scraper.setCookies>[0]);
        const loggedIn = await scraper.isLoggedIn();
        if (!loggedIn) throw new Error('Cookies stale');
      } catch {
        // Cookies invalid — fall through to password login
        await this._login(scraper, creds);
      }
    } else {
      await this._login(scraper, creds);
    }

    // Verify we're logged in
    if (!(await scraper.isLoggedIn())) {
      throw new Error('Login failed — check credentials');
    }

    // Persist updated cookies
    const cookies = await scraper.getCookies();
    this.creds.cookies = JSON.stringify(cookies);

    // Get our own profile
    const meRaw = await scraper.me() as unknown as Record<string, unknown> | null;
    const userId = String(meRaw?.id || meRaw?.userId || meRaw?.rest_id || '');
    const handle = String(meRaw?.username || meRaw?.screen_name || creds.username);
    const displayName = String(meRaw?.name || handle);

    this.creds.userId = userId;
    this.creds.handle = handle;
    this.creds.displayName = displayName;
    saveCreds(this.creds);

    this.scraper = scraper;
    this.accountInfo = { userId, displayName, handle };
    this.connected = true;

    // Start DM polling (syncDMs also runs immediately on first connect)
    this.syncDMs().catch(console.error);
    this.pollInterval = setInterval(() => this.syncDMs().catch(console.error), 2 * 60 * 1000);

    broadcast({ type: 'connection:status', data: { service: 'twitter', status: 'connected', displayName, accountId: userId, mode: 'cookie' } });
    console.log(`[twitter] Connected as @${handle}`);
    return true;
  }

  private async _login(scraper: Scraper, creds: TwitterCreds): Promise<void> {
    await scraper.login(creds.username, creds.password, creds.email);
  }

  disconnect(): void {
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    this.scraper?.logout().catch(() => {});
    this.scraper = null;
    this.connected = false;
    this.accountInfo = null;
    clearTwitterCache();
    broadcast({ type: 'connection:status', data: { service: 'twitter', status: 'disconnected' } });
  }

  // ── DM sync ─────────────────────────────────────────────────────────────────

  /** Returns true if this is the first successful DM sync (no prior syncRuns). */
  hasBeenSynced(): boolean {
    const db = getDb();
    return !!db.select().from(syncRuns)
      .where(and(eq(syncRuns.source, 'twitter'), eq(syncRuns.status, 'success')))
      .get();
  }

  async syncDMs(): Promise<number> {
    if (!this.scraper || !this.accountInfo) return 0;
    const db = getDb();
    this._cancelRequested = false;
    let saved = 0;

    const runId = db.insert(syncRuns).values({
      source: 'twitter',
      syncType: this.hasBeenSynced() ? 'incremental' : 'full',
      status: 'running',
      startedAt: new Date().toISOString(),
    }).run().lastInsertRowid as number;

    broadcast({ type: 'sync:progress', data: { service: 'twitter', status: 'running', type: 'full', messagesSaved: 0 } });

    try {
      const result = await this.scraper.getDirectMessageConversations(this.accountInfo.userId);

      for (const conv of result.conversations || []) {
        if (this._cancelRequested) break;
        for (const msg of conv.messages || []) {
          if (this._cancelRequested) break;
          if (!msg.id) continue;

          const participant = result.users?.find((u) => (u as unknown as Record<string,unknown>).id === msg.senderId) as Record<string,unknown> | undefined;

          const insertResult = db.insert(twitterDms).values({
            conversationId: conv.conversationId,
            messageId: msg.id,
            senderId: msg.senderId,
            senderHandle: String(participant?.username || participant?.screen_name || ''),
            senderName: String(participant?.name || ''),
            recipientId: msg.recipientId || null,
            text: msg.text || null,
            createdAt: msg.createdAt || new Date().toISOString(),
            accountId: this.accountInfo?.userId,
            rawJson: JSON.stringify(msg),
          }).onConflictDoNothing().run();

          if (insertResult.changes > 0) {
            saved++;
            broadcast({
              type: 'message:new',
              data: {
                source: 'twitter',
                conversationId: conv.conversationId,
                messageId: msg.id,
                senderId: msg.senderId,
                senderHandle: participant?.username,
                text: msg.text,
                createdAt: msg.createdAt,
              },
            });
          }
        }
      }

      if (this._cancelRequested) {
        db.update(syncRuns).set({ status: 'cancelled', finishedAt: new Date().toISOString(), messagesSaved: saved }).where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'twitter', status: 'idle' } });
      } else {
        db.update(syncRuns).set({ status: 'success', finishedAt: new Date().toISOString(), messagesSaved: saved }).where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'twitter', status: 'success', messagesSaved: saved } });
      }
    } catch (e) {
      console.error('[twitter] DM sync error:', e);
      db.update(syncRuns).set({ status: 'error', errorMessage: String(e), finishedAt: new Date().toISOString() }).where(eq(syncRuns.id, runId)).run();
      broadcast({ type: 'sync:progress', data: { service: 'twitter', status: 'error' } });
    }

    return saved;
  }

  // ── Read/explore endpoints (cached) ─────────────────────────────────────────

  async getHomeFeed(count = 20, reset = false): Promise<Tweet[]> {
    if (!this.scraper) throw new Error('Not connected');
    if (reset) this.seenFeedIds.clear();

    const cacheKey = `feed:${count}:${this.seenFeedIds.size}`;
    const cached = fromCache<Tweet[]>(cacheKey);
    if (cached) return cached;

    const rawFeed = await this.scraper.fetchHomeTimeline(count, [...this.seenFeedIds]);
    const tweets: Tweet[] = [];

    for (const raw of rawFeed) {
      // agent-twitter-client fetchHomeTimeline returns raw objects — normalize
      if (!raw?.rest_id) continue;
      const core = raw.core?.user_results?.result?.legacy;
      const legacy = raw.legacy;
      const tweet: Tweet = {
        id: raw.rest_id,
        text: legacy?.full_text || legacy?.text || '',
        username: core?.screen_name || '',
        name: core?.name || '',
        userId: core?.id_str || '',
        likes: legacy?.favorite_count || 0,
        retweets: legacy?.retweet_count || 0,
        replies: legacy?.reply_count || 0,
        timestamp: legacy?.created_at ? new Date(legacy.created_at).getTime() / 1000 : 0,
        permanentUrl: raw.rest_id ? `https://twitter.com/i/web/status/${raw.rest_id}` : '',
        photos: [],
        videos: [],
        hashtags: (legacy?.entities?.hashtags || []).map((h: { text: string }) => h.text),
        mentions: (legacy?.entities?.user_mentions || []).map((m: { screen_name: string }) => m.screen_name),
        urls: (legacy?.entities?.urls || []).map((u: { expanded_url: string }) => u.expanded_url),
        isReply: !!legacy?.in_reply_to_status_id_str,
        isRetweet: !!legacy?.retweeted_status_id_str,
      } as unknown as Tweet;
      tweets.push(tweet);
      this.seenFeedIds.add(raw.rest_id);
    }

    toCache(cacheKey, tweets);
    return tweets;
  }

  async searchTweets(query: string, count = 20, mode: 'Latest' | 'Top' | 'People' = 'Latest'): Promise<Tweet[]> {
    if (!this.scraper) throw new Error('Not connected');
    const cacheKey = `search:${query}:${count}:${mode}`;
    const cached = fromCache<Tweet[]>(cacheKey);
    if (cached) return cached;

    const modeEnum = mode === 'Latest' ? SearchMode.Latest : mode === 'Top' ? SearchMode.Top : SearchMode.Users;
    const results: Tweet[] = [];
    for await (const tweet of this.scraper.searchTweets(query, count, modeEnum)) {
      results.push(tweet as Tweet);
    }
    toCache(cacheKey, results);
    return results;
  }

  async searchPeople(query: string, count = 10): Promise<Profile[]> {
    if (!this.scraper) throw new Error('Not connected');
    const cacheKey = `people:${query}:${count}`;
    const cached = fromCache<Profile[]>(cacheKey);
    if (cached) return cached;

    const results: Profile[] = [];
    for await (const profile of this.scraper.searchProfiles(query, count)) {
      results.push(profile as Profile);
    }
    toCache(cacheKey, results);
    return results;
  }

  async getTweet(id: string): Promise<Tweet | null> {
    if (!this.scraper) throw new Error('Not connected');
    const cacheKey = `tweet:${id}`;
    const cached = fromCache<Tweet>(cacheKey);
    if (cached) return cached;

    const tweet = await this.scraper.getTweet(id);
    if (tweet) toCache(cacheKey, tweet);
    return tweet as Tweet | null;
  }

  async getTweetThread(id: string): Promise<Tweet[]> {
    if (!this.scraper) throw new Error('Not connected');
    const cacheKey = `thread:${id}`;
    const cached = fromCache<Tweet[]>(cacheKey);
    if (cached) return cached;

    // Get the root tweet + replies by searching for conversation_id
    const root = await this.scraper.getTweet(id);
    if (!root) return [];

    const replies: Tweet[] = [];
    try {
      for await (const t of this.scraper.searchTweets(`conversation_id:${id}`, 50, SearchMode.Latest)) {
        replies.push(t as Tweet);
      }
    } catch { /* ignore search errors */ }

    const thread = [root as Tweet, ...replies].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    toCache(cacheKey, thread);
    return thread;
  }

  async getUserProfile(handle: string): Promise<Profile | null> {
    if (!this.scraper) throw new Error('Not connected');
    const cacheKey = `profile:${handle.toLowerCase()}`;
    const cached = fromCache<Profile>(cacheKey);
    if (cached) return cached;

    const profile = await this.scraper.getProfile(handle);
    if (profile) toCache(cacheKey, profile);
    return profile as Profile | null;
  }

  async getUserTweets(handle: string, count = 20): Promise<Tweet[]> {
    if (!this.scraper) throw new Error('Not connected');
    const cacheKey = `usertweets:${handle.toLowerCase()}:${count}`;
    const cached = fromCache<Tweet[]>(cacheKey);
    if (cached) return cached;

    const results: Tweet[] = [];
    for await (const t of this.scraper.getTweets(handle, count)) {
      results.push(t as Tweet);
    }
    toCache(cacheKey, results);
    return results;
  }

  /**
   * Fetch the authenticated user's own tweets for analytics.
   * Uses a dedicated 15-minute cache key separate from the profile tweet cache.
   */
  async getOwnTweets(count = 200): Promise<Tweet[]> {
    if (!this.scraper) throw new Error('Not connected');
    const handle = this.accountInfo?.handle;
    if (!handle) throw new Error('Twitter handle not available — reconnect');
    const cacheKey = `own-tweets:${handle.toLowerCase()}:${count}`;
    const cached = fromCache<Tweet[]>(cacheKey);
    if (cached) return cached;
    const results: Tweet[] = [];
    for await (const t of this.scraper.getTweets(handle, count)) {
      results.push(t as Tweet);
    }
    toCache(cacheKey, results);
    return results;
  }

  async getUserFollowers(handle: string, count = 50): Promise<Profile[]> {
    if (!this.scraper) throw new Error('Not connected');
    const userId = await this.scraper.getUserIdByScreenName(handle);
    if (!userId) return [];
    const cacheKey = `followers:${handle.toLowerCase()}:${count}`;
    const cached = fromCache<Profile[]>(cacheKey);
    if (cached) return cached;

    const results: Profile[] = [];
    for await (const p of this.scraper.getFollowers(userId, count)) {
      results.push(p as Profile);
    }
    toCache(cacheKey, results);
    return results;
  }

  async getUserFollowing(handle: string, count = 50): Promise<Profile[]> {
    if (!this.scraper) throw new Error('Not connected');
    const userId = await this.scraper.getUserIdByScreenName(handle);
    if (!userId) return [];
    const cacheKey = `following:${handle.toLowerCase()}:${count}`;
    const cached = fromCache<Profile[]>(cacheKey);
    if (cached) return cached;

    const results: Profile[] = [];
    for await (const p of this.scraper.getFollowing(userId, count)) {
      results.push(p as Profile);
    }
    toCache(cacheKey, results);
    return results;
  }

  async getTrends(): Promise<string[]> {
    if (!this.scraper) throw new Error('Not connected');
    const cacheKey = 'trends';
    const cached = fromCache<string[]>(cacheKey);
    if (cached) return cached;

    const trends = await this.scraper.getTrends();
    toCache(cacheKey, trends);
    return trends;
  }

  async getMentions(count = 20): Promise<Tweet[]> {
    if (!this.scraper || !this.accountInfo) throw new Error('Not connected');
    const handle = this.accountInfo.handle;
    return this.searchTweets(`@${handle}`, count, 'Latest');
  }

  // ── Actions (called on outbox approval) ─────────────────────────────────────

  async sendTweet(text: string, replyToId?: string): Promise<string> {
    if (!this.scraper) throw new Error('Not connected');
    const res = await this.scraper.sendTweet(text, replyToId);
    const body = await res.json() as { data?: { create_tweet?: { tweet_results?: { result?: { rest_id?: string } } } } };
    const id = body?.data?.create_tweet?.tweet_results?.result?.rest_id || '';
    clearTwitterCache('feed:');
    return id;
  }

  async sendQuoteTweet(text: string, quotedId: string): Promise<string> {
    if (!this.scraper) throw new Error('Not connected');
    const res = await this.scraper.sendQuoteTweet(text, quotedId);
    const body = await res.json() as { data?: { create_tweet?: { tweet_results?: { result?: { rest_id?: string } } } } };
    clearTwitterCache('feed:');
    return body?.data?.create_tweet?.tweet_results?.result?.rest_id || '';
  }

  async retweet(tweetId: string): Promise<void> {
    if (!this.scraper) throw new Error('Not connected');
    await this.scraper.retweet(tweetId);
    clearTwitterCache(`tweet:${tweetId}`);
  }

  async likeTweet(tweetId: string): Promise<void> {
    if (!this.scraper) throw new Error('Not connected');
    await this.scraper.likeTweet(tweetId);
    clearTwitterCache(`tweet:${tweetId}`);
  }

  async followUser(handle: string): Promise<void> {
    if (!this.scraper) throw new Error('Not connected');
    await this.scraper.followUser(handle);
    clearTwitterCache(`profile:${handle.toLowerCase()}`);
  }

  async sendDM(conversationId: string, text: string): Promise<string> {
    if (!this.scraper) throw new Error('Not connected');
    const res = await this.scraper.sendDirectMessage(conversationId, text);
    return (res as unknown as Record<string, unknown>)?.id as string || '';
  }

  async executeAction(action: TwitterAction): Promise<string> {
    switch (action.action) {
      case 'tweet':   return await this.sendTweet(action.text || '', action.replyToId);
      case 'reply':   return await this.sendTweet(action.text || '', action.replyToId);
      case 'quote':   return await this.sendQuoteTweet(action.text || '', action.quotedId!);
      case 'retweet': await this.retweet(action.tweetId!); return '';
      case 'like':    await this.likeTweet(action.tweetId!); return '';
      case 'follow':  await this.followUser(action.handle!); return '';
      case 'dm':      return await this.sendDM(action.conversationId!, action.text || '');
      default:        throw new Error(`Unknown Twitter action: ${action.action}`);
    }
  }
}
