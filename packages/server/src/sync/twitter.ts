/**
 * TwitterSync — agent-twitter-client integration.
 *
 * Uses cookie/session-based auth — no Twitter developer account required.
 * The user pastes the raw "Cookie:" header string from their browser's DevTools
 * (Network tab → any twitter.com/x.com request → Request Headers → Cookie).
 * This bypasses 2FA completely since the browser session is already authenticated.
 *
 * Credentials stored in settings under `credentials.twitter`.
 *
 * DMs: synced to SQLite (twitter_dms table) via 2-minute polling.
 * Tweets/posts: NOT stored. Served live from API with 15-minute in-memory LRU cache.
 */

import { Scraper, SearchMode, type Tweet, type Profile } from 'agent-twitter-client';
import { getDb } from '../db/client.js';
import { twitterDms, settings, syncRuns } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { broadcast } from '../websocket/hub.js';
import { upsertContact } from './contacts.js';

export interface TwitterCreds {
  /** Raw "Cookie:" header string copied from browser DevTools */
  cookieString: string;
  /** Serialised cookie jar (JSON array) — persisted after first successful connect */
  cookies?: string;
  userId?: string;
  handle?: string;
  displayName?: string;
}

/**
 * Parse a raw browser "Cookie:" header string into an array of Set-Cookie
 * formatted strings that tough-cookie's CookieJar.setCookie() accepts.
 *
 * We emit each cookie twice — once for .twitter.com and once for .x.com —
 * because Twitter has been migrating domains and the scraper may hit either.
 */
export function parseCookieString(raw: string): string[] {
  const pairs = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return null;
      const name  = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      if (!name) return null;
      return { name, value };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // Emit each cookie scoped to .twitter.com — the scraper calls setCookie against
  // https://twitter.com so tough-cookie's domain validation requires this exact domain.
  return pairs.map(({ name, value }) => `${name}=${value}; Domain=.twitter.com; Path=/; Secure`);
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

    // Warn early if critical auth cookies are missing
    if (!creds.cookieString.includes('auth_token=')) throw new Error('Missing auth_token cookie — make sure you copied the full Cookie header value');
    if (!creds.cookieString.includes('ct0='))        throw new Error('Missing ct0 cookie — make sure you copied the full Cookie header value');

    // Extract ct0 for the CSRF header
    const ct0Match = creds.cookieString.match(/(?:^|;\s*)ct0=([^;]+)/);
    const ct0 = ct0Match?.[1]?.trim() ?? '';

    // Verify the session by calling verify_credentials directly with the raw cookie string.
    // We try both x.com and twitter.com since browsers may have sessions on either domain.
    const BEARER = 'AAAAAAAAAAAAAAAAAAAAAFQODgEAAAAAVHTp76lzh3rFzcHbmHVvQxYYpTw%3DckAlMINMjmCwxUcaXbAN4XqJVdgMJaHqNOFgPMK0zN1qLqLQCF';
    const verifyHeaders = {
      authorization: `Bearer ${BEARER}`,
      cookie: creds.cookieString,
      'x-csrf-token': ct0,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    let verifyData: Record<string, unknown> | null = null;
    for (const host of ['https://x.com', 'https://twitter.com']) {
      try {
        const res = await fetch(`${host}/i/api/1.1/account/verify_credentials.json`, { headers: verifyHeaders });
        if (res.ok) {
          verifyData = await res.json() as Record<string, unknown>;
          console.log(`[twitter] verify_credentials OK via ${host}`);
          break;
        }
        const body = await res.text();
        console.warn(`[twitter] verify_credentials ${res.status} via ${host}:`, body.slice(0, 200));
      } catch (e) {
        console.warn(`[twitter] verify_credentials fetch error via ${host}:`, e instanceof Error ? e.message : e);
      }
    }

    if (!verifyData) {
      throw new Error('Cookie session rejected by Twitter — please copy a fresh Cookie header from x.com in your browser (DevTools → Network → any x.com request → Request Headers → cookie)');
    }

    // Resolve account identity from verify_credentials response
    const userId      = String(verifyData.id_str || verifyData.id || '');
    const handle      = String(verifyData.screen_name || '');
    const displayName = String(verifyData.name || handle);

    // Now inject the cookies into the scraper's jar for all subsequent API calls.
    // We inject against both twitter.com and x.com since the library hits both.
    const scraper = new Scraper();
    const jar = (scraper as unknown as { auth: { cookieJar(): import('tough-cookie').CookieJar } }).auth.cookieJar();
    const cookieStrings = parseCookieString(creds.cookieString);
    for (const cookieStr of cookieStrings) {
      try { await jar.setCookie(cookieStr, 'https://twitter.com'); } catch { /* ignore domain errors */ }
      try { await jar.setCookie(cookieStr, 'https://x.com'); } catch { /* ignore domain errors */ }
    }
    // Switch to TwitterUserAuth so the scraper sends the cookie header on all requests
    await scraper.setCookies(cookieStrings as unknown as Parameters<typeof scraper.setCookies>[0]);

    this.creds.userId = userId;
    this.creds.handle = handle;
    this.creds.displayName = displayName;
    saveCreds(this.creds);

    this.scraper = scraper;
    this.accountInfo = { userId, displayName, handle };
    this.connected = true;

    // Upsert own user into contacts so the self-avatar shows in chat message bubbles
    {
      const selfAvatarRaw = String(
        (verifyData as Record<string, unknown>).profile_image_url_https ||
        (verifyData as Record<string, unknown>).profile_image_url || ''
      );
      const selfAvatarUrl = selfAvatarRaw
        ? selfAvatarRaw.replace(/_normal(\.\w+)$/, '_400x400$1')
        : undefined;
      upsertContact({
        source: 'twitter',
        platformId: userId,
        accountId: userId,
        displayName,
        username: handle,
        avatarUrl: selfAvatarUrl,
      });
    }

    // Start DM polling (syncDMs also runs immediately on first connect)
    this.syncDMs().catch(console.error);
    this.pollInterval = setInterval(() => this.syncDMs().catch(console.error), 2 * 60 * 1000);

    broadcast({ type: 'connection:status', data: { service: 'twitter', status: 'connected', displayName, accountId: userId, mode: 'cookie' } });
    console.log(`[twitter] Connected as @${handle}`);
    return true;
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

  /** Clear all in-memory dedup/cache state without disconnecting. Called before a data reset + resync. */
  resetInMemoryState(): void {
    this.seenFeedIds.clear();
    clearTwitterCache();
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

      // Build a lookup map of userId → TwitterUser for fast access
      type TwitterUserRecord = {
        id?: string;
        screenName?: string;
        username?: string;
        screen_name?: string;
        name?: string;
        profileImageUrl?: string;
        profile_image_url?: string;
        description?: string;
      };
      const userMap = new Map<string, TwitterUserRecord>();
      for (const u of result.users || []) {
        const ur = u as unknown as TwitterUserRecord;
        const uid = String(ur.id || '');
        if (uid) userMap.set(uid, ur);
      }

      // Upsert all DM participants as contacts with hasDm: true and their profile picture
      const myUserId = String(this.accountInfo.userId);
      for (const [uid, u] of userMap) {
        if (uid === myUserId) continue; // skip self
        const handle = String(u.screenName || u.username || u.screen_name || '');
        const name = String(u.name || handle || uid);
        const avatarUrl = String(u.profileImageUrl || u.profile_image_url || '').replace(/_normal(\.\w+)$/, '_400x400$1') || undefined;
        upsertContact({
          source: 'twitter',
          platformId: uid,
          accountId: myUserId,
          displayName: name || undefined,
          username: handle || undefined,
          avatarUrl: avatarUrl || undefined,
          hasDm: true,
        });
      }

      for (const conv of result.conversations || []) {
        if (this._cancelRequested) break;
        for (const msg of conv.messages || []) {
          if (this._cancelRequested) break;
          if (!msg.id) continue;

          const participant = userMap.get(String(msg.senderId)) as Record<string,unknown> | undefined;

          const insertResult = db.insert(twitterDms).values({
            conversationId: conv.conversationId,
            messageId: msg.id,
            senderId: msg.senderId,
            senderHandle: String((participant?.screenName || participant?.username || participant?.screen_name) ?? ''),
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
                senderHandle: participant?.screenName || participant?.username,
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

        // Also sync following list as contacts (fire-and-forget, non-blocking)
        this.syncFollowingContacts().catch((e) => console.error('[twitter] syncFollowingContacts failed:', e));
      }
    } catch (e) {
      console.error('[twitter] DM sync error:', e);
      db.update(syncRuns).set({ status: 'error', errorMessage: String(e), finishedAt: new Date().toISOString() }).where(eq(syncRuns.id, runId)).run();
      broadcast({ type: 'sync:progress', data: { service: 'twitter', status: 'error' } });
    }

    return saved;
  }

  /**
   * Fetch the authenticated user's following list and upsert each followed account
   * as a Twitter contact. This is called after DM sync and also when contacts are rebuilt.
   * Profiles already have `avatar` from the scraper's Profile type.
   *
   * Uses the v1.1 REST API (friends/ids + users/lookup) instead of the GraphQL
   * Following endpoint, which uses a hardcoded query ID in agent-twitter-client that
   * Twitter periodically rotates — causing 404 errors.
   */
  async syncFollowingContacts(count = 200): Promise<number> {
    if (!this.scraper || !this.accountInfo) return 0;
    const myUserId = this.accountInfo.userId;
    let upserted = 0;

    try {
      const profiles = await this.fetchFollowingProfiles(myUserId, count);
      for (const p of profiles) {
        if (!p.userId && !p.username) continue;
        const platformId = p.userId || p.username || '';
        if (!platformId || platformId === myUserId) continue;

        // Upgrade _normal avatar to a larger version (_400x400)
        const avatarUrl = p.avatar
          ? p.avatar.replace(/_normal(\.\w+)$/, '_400x400$1')
          : undefined;

        upsertContact({
          source: 'twitter',
          platformId,
          accountId: myUserId,
          displayName: p.name || p.username || undefined,
          username: p.username || undefined,
          avatarUrl,
          bio: p.biography || undefined,
          // Following someone is not quite a DM, so hasDm stays false here;
          // the isNativeContact flag marks them as explicitly followed.
          isNativeContact: true,
        });
        upserted++;
      }
    } catch (e) {
      console.error('[twitter] syncFollowingContacts error:', e);
    }

    return upserted;
  }

  /**
   * Fetch profiles for accounts the given userId follows using the GraphQL
   * Following endpoint directly via xFetch.
   *
   * agent-twitter-client hardcodes the GraphQL query ID for this endpoint and it
   * breaks whenever Twitter rotates it. We call the endpoint ourselves so we can
   * keep the query ID up-to-date independently of the library version.
   *
   * Query ID last verified: 2026-04-19 (j4s0ZOO_DvhECpS-2U-SUA)
   * To refresh: search for `queryId:"<id>",operationName:"Following"` in
   * https://abs.twimg.com/responsive-web/client-web/main.*.js
   */
  private async fetchFollowingProfiles(userId: string, count: number): Promise<Profile[]> {
    // GraphQL query ID for the Following operation (from Twitter's web client JS).
    const FOLLOWING_QUERY_ID = 'j4s0ZOO_DvhECpS-2U-SUA';

    const features = {
      android_graphql_skip_api_media_color_palette: false,
      blue_business_profile_image_shape_enabled: false,
      creator_subscriptions_subscription_count_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      freedom_of_speech_not_reach_fetch_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      longform_notetweets_consumption_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      responsive_web_enhance_cards_enabled: false,
      responsive_web_graphql_exclude_directive_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_media_download_video_enabled: false,
      responsive_web_twitter_article_tweet_consumption_enabled: false,
      rweb_lists_timeline_redesign_enabled: true,
      standardized_nudges_misinfo: true,
      subscriptions_verification_info_enabled: true,
      subscriptions_verification_info_reason_enabled: true,
      subscriptions_verification_info_verified_since_enabled: true,
      super_follow_badge_privacy_enabled: false,
      super_follow_exclusive_tweet_notifications_enabled: false,
      super_follow_tweet_api_enabled: false,
      super_follow_user_api_enabled: false,
      tweet_awards_web_tipping_enabled: false,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      tweetypie_unmention_optimization_enabled: true,
      unified_cards_ad_metadata_container_dynamic_card_content_query_enabled: false,
      verified_phone_label_enabled: false,
      view_counts_everywhere_api_enabled: true,
    };

    const profiles: Profile[] = [];
    let cursor: string | undefined;

    while (profiles.length < count) {
      const pageSize = Math.min(count - profiles.length, 50); // API max per page is 50
      const variables: Record<string, unknown> = {
        userId,
        count: pageSize,
        includePromotedContent: false,
      };
      if (cursor) variables['cursor'] = cursor;

      const params = new URLSearchParams({
        features: JSON.stringify(features),
        variables: JSON.stringify(variables),
      });
      const url = `https://twitter.com/i/api/graphql/${FOLLOWING_QUERY_ID}/Following?${params.toString()}`;
      const res = await this.xFetch(url);

      if (!res.ok) {
        const body = await res.text();
        console.warn(`[twitter] Following graphql error ${res.status}:`, body.slice(0, 200));
        break;
      }

      // Response shape mirrors agent-twitter-client's RelationshipTimeline
      type UserLegacy = {
        id_str?: string;
        screen_name?: string;
        name?: string;
        description?: string;
        profile_image_url_https?: string;
      };
      type EntryContent = {
        cursorType?: string;
        entryType?: string;
        value?: string;
        itemContent?: {
          userDisplayType?: string;
          user_results?: {
            result?: { rest_id?: string; legacy?: UserLegacy };
          };
        };
      };
      type Entry = { entryId: string; content?: EntryContent };
      type Instruction = {
        type?: string;
        entries?: Entry[];
        entry?: Entry;
      };
      const data = await res.json() as {
        data?: {
          user?: {
            result?: {
              timeline?: { timeline?: { instructions?: Instruction[] } };
            };
          };
        };
      };

      const instructions =
        data?.data?.user?.result?.timeline?.timeline?.instructions ?? [];

      let nextCursor: string | undefined;
      let pageProfiles = 0;

      for (const instruction of instructions) {
        if (
          instruction.type !== 'TimelineAddEntries' &&
          instruction.type !== 'TimelineReplaceEntry'
        ) continue;

        // Handle single-entry cursor replacements
        if (instruction.entry?.content?.cursorType === 'Bottom') {
          nextCursor = instruction.entry.content.value;
          continue;
        }

        for (const entry of instruction.entries ?? []) {
          const c = entry.content;
          if (c?.cursorType === 'Bottom') {
            nextCursor = c.value;
            continue;
          }
          if (c?.itemContent?.userDisplayType !== 'User') continue;

          const result = c.itemContent.user_results?.result;
          if (!result?.legacy) continue;

          const leg = result.legacy;
          profiles.push({
            userId: result.rest_id ?? leg.id_str,
            username: leg.screen_name,
            name: leg.name,
            biography: leg.description,
            avatar: leg.profile_image_url_https,
          } as Profile);
          pageProfiles++;
        }
      }

      // Stop paginating if no new profiles or no cursor to continue with
      if (pageProfiles === 0 || !nextCursor) break;
      cursor = nextCursor;
    }

    return profiles;
  }

  /**
   * Fetch profiles for accounts that follow the given userId using the GraphQL
   * Followers endpoint directly via xFetch.
   *
   * Same rationale as fetchFollowingProfiles — bypasses the stale hardcoded
   * query ID in agent-twitter-client.
   *
   * Query ID last verified: 2026-04-19 (_wt2xR9Ozi8ZI7agzWf_bw)
   * To refresh: search for `queryId:"<id>",operationName:"Followers"` in
   * https://abs.twimg.com/responsive-web/client-web/main.*.js
   */
  private async fetchFollowerProfiles(userId: string, count: number): Promise<Profile[]> {
    const FOLLOWERS_QUERY_ID = '_wt2xR9Ozi8ZI7agzWf_bw';

    const features = {
      android_graphql_skip_api_media_color_palette: false,
      blue_business_profile_image_shape_enabled: false,
      creator_subscriptions_subscription_count_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      freedom_of_speech_not_reach_fetch_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      longform_notetweets_consumption_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      responsive_web_enhance_cards_enabled: false,
      responsive_web_graphql_exclude_directive_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_media_download_video_enabled: false,
      responsive_web_twitter_article_tweet_consumption_enabled: false,
      rweb_lists_timeline_redesign_enabled: true,
      standardized_nudges_misinfo: true,
      subscriptions_verification_info_enabled: true,
      subscriptions_verification_info_reason_enabled: true,
      subscriptions_verification_info_verified_since_enabled: true,
      super_follow_badge_privacy_enabled: false,
      super_follow_exclusive_tweet_notifications_enabled: false,
      super_follow_tweet_api_enabled: false,
      super_follow_user_api_enabled: false,
      tweet_awards_web_tipping_enabled: false,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      tweetypie_unmention_optimization_enabled: true,
      unified_cards_ad_metadata_container_dynamic_card_content_query_enabled: false,
      verified_phone_label_enabled: false,
      view_counts_everywhere_api_enabled: true,
    };

    const profiles: Profile[] = [];
    let cursor: string | undefined;

    while (profiles.length < count) {
      const pageSize = Math.min(count - profiles.length, 50);
      const variables: Record<string, unknown> = {
        userId,
        count: pageSize,
        includePromotedContent: false,
      };
      if (cursor) variables['cursor'] = cursor;

      const params = new URLSearchParams({
        features: JSON.stringify(features),
        variables: JSON.stringify(variables),
      });
      const url = `https://twitter.com/i/api/graphql/${FOLLOWERS_QUERY_ID}/Followers?${params.toString()}`;
      const res = await this.xFetch(url);

      if (!res.ok) {
        const body = await res.text();
        console.warn(`[twitter] Followers graphql error ${res.status}:`, body.slice(0, 200));
        break;
      }

      type UserLegacy = {
        id_str?: string;
        screen_name?: string;
        name?: string;
        description?: string;
        profile_image_url_https?: string;
      };
      type EntryContent = {
        cursorType?: string;
        value?: string;
        itemContent?: {
          userDisplayType?: string;
          user_results?: { result?: { rest_id?: string; legacy?: UserLegacy } };
        };
      };
      type Entry = { entryId: string; content?: EntryContent };
      type Instruction = { type?: string; entries?: Entry[]; entry?: Entry };
      const data = await res.json() as {
        data?: { user?: { result?: { timeline?: { timeline?: { instructions?: Instruction[] } } } } };
      };

      const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions ?? [];
      let nextCursor: string | undefined;
      let pageProfiles = 0;

      for (const instruction of instructions) {
        if (
          instruction.type !== 'TimelineAddEntries' &&
          instruction.type !== 'TimelineReplaceEntry'
        ) continue;

        if (instruction.entry?.content?.cursorType === 'Bottom') {
          nextCursor = instruction.entry.content.value;
          continue;
        }

        for (const entry of instruction.entries ?? []) {
          const c = entry.content;
          if (c?.cursorType === 'Bottom') { nextCursor = c.value; continue; }
          if (c?.itemContent?.userDisplayType !== 'User') continue;
          const result = c.itemContent.user_results?.result;
          if (!result?.legacy) continue;
          const leg = result.legacy;
          profiles.push({
            userId: result.rest_id ?? leg.id_str,
            username: leg.screen_name,
            name: leg.name,
            biography: leg.description,
            avatar: leg.profile_image_url_https,
          } as Profile);
          pageProfiles++;
        }
      }

      if (pageProfiles === 0 || !nextCursor) break;
      cursor = nextCursor;
    }

    return profiles;
  }

  // ── Read/explore endpoints (cached) ─────────────────────────────────────────

  /** Make an authenticated request to x.com using the raw cookie string directly. */
  private async xFetch(url: string): Promise<Response> {
    if (!this.creds) throw new Error('Not connected');
    const ct0Match = this.creds.cookieString.match(/(?:^|;\s*)ct0=([^;]+)/);
    const ct0 = ct0Match?.[1]?.trim() ?? '';
    return fetch(url, {
      headers: {
        authorization: `Bearer AAAAAAAAAAAAAAAAAAAAAFQODgEAAAAAVHTp76lzh3rFzcHbmHVvQxYYpTw%3DckAlMINMjmCwxUcaXbAN4XqJVdgMJaHqNOFgPMK0zN1qLqLQCF`,
        cookie: this.creds.cookieString,
        'x-csrf-token': ct0,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-client-language': 'en',
        'content-type': 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        referer: 'https://x.com/home',
        origin: 'https://x.com',
      },
    });
  }

  async getHomeFeed(count = 20, reset = false): Promise<Tweet[]> {
    if (!this.creds) throw new Error('Not connected');
    if (reset) this.seenFeedIds.clear();

    const cacheKey = `feed:${count}:${this.seenFeedIds.size}`;
    const cached = fromCache<Tweet[]>(cacheKey);
    if (cached) return cached;

    const variables = {
      count,
      includePromotedContent: true,
      latestControlAvailable: true,
      requestContext: 'launch',
      withCommunity: true,
      seenTweetIds: [...this.seenFeedIds],
    };
    const features = {
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      rweb_video_timestamps_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    };

    const url = `https://x.com/i/api/graphql/Fb7fyZ9MMCzvf_bNtwNdXA/HomeTimeline?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
    const res = await this.xFetch(url);
    if (!res.ok) {
      const body = await res.text();
      console.error('[twitter] HomeTimeline error:', res.status, body.slice(0, 300));
      throw new Error(`Response status: ${res.status}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const instructions = (data as Record<string, unknown> & {
      data?: { home?: { home_timeline_urt?: { instructions?: unknown[] } } }
    })?.data?.home?.home_timeline_urt?.instructions ?? [];

    const tweets: Tweet[] = [];
    for (const instruction of instructions as Array<Record<string, unknown>>) {
      if (instruction['type'] !== 'TimelineAddEntries') continue;
      for (const entry of (instruction['entries'] as Array<Record<string, unknown>> ?? [])) {
        const raw = (entry['content'] as Record<string, unknown>)?.['itemContent'] as Record<string, unknown>;
        const result = (raw?.['tweet_results'] as Record<string, unknown>)?.['result'] as Record<string, unknown>;
        if (!result?.['rest_id']) continue;
        const core = (result['core'] as Record<string, unknown>)?.['user_results'] as Record<string, unknown>;
        const userLegacy = ((core?.['result'] as Record<string, unknown>)?.['legacy'] as Record<string, unknown>);
        const legacy = result['legacy'] as Record<string, unknown>;
        const tweet: Tweet = {
          id: String(result['rest_id']),
          text: String(legacy?.['full_text'] || legacy?.['text'] || ''),
          username: String(userLegacy?.['screen_name'] || ''),
          name: String(userLegacy?.['name'] || ''),
          userId: String(userLegacy?.['id_str'] || ''),
          likes: Number(legacy?.['favorite_count'] || 0),
          retweets: Number(legacy?.['retweet_count'] || 0),
          replies: Number(legacy?.['reply_count'] || 0),
          timestamp: legacy?.['created_at'] ? new Date(String(legacy['created_at'])).getTime() / 1000 : 0,
          permanentUrl: `https://x.com/i/web/status/${result['rest_id']}`,
          photos: [],
          videos: [],
          hashtags: ((legacy?.['entities'] as Record<string, unknown>)?.['hashtags'] as Array<{ text: string }> || []).map((h) => h.text),
          mentions: ((legacy?.['entities'] as Record<string, unknown>)?.['user_mentions'] as Array<{ screen_name: string }> || []).map((m) => m.screen_name),
          urls: ((legacy?.['entities'] as Record<string, unknown>)?.['urls'] as Array<{ expanded_url: string }> || []).map((u) => u.expanded_url),
          isReply: !!(legacy?.['in_reply_to_status_id_str']),
          isRetweet: !!(legacy?.['retweeted_status_id_str']),
        } as unknown as Tweet;
        tweets.push(tweet);
        this.seenFeedIds.add(String(result['rest_id']));
      }
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

    // Use direct GraphQL call to avoid the hardcoded stale query ID in agent-twitter-client
    const results = await this.fetchFollowerProfiles(userId, count);
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

    // Use v1.1 REST API to avoid the hardcoded GraphQL query ID in agent-twitter-client
    // that breaks whenever Twitter rotates it (returns 404).
    const results = await this.fetchFollowingProfiles(userId, count);
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
