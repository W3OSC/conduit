/**
 * Twitter API routes.
 *
 * Read/explore endpoints: live from agent-twitter-client with 15-min LRU cache.
 * DM routes: data from SQLite twitter_dms table.
 * Action routes: ALL create outbox items for approval.
 * Auth routes: credential management and connect/disconnect.
 */

import { Router } from 'express';
import { getDb } from '../db/client.js';
import { twitterDms, outbox, permissions, settings, accounts, contacts, apiKeyPermissions } from '../db/schema.js';
import type { TwitterFineGrained } from '../db/schema.js';
import { desc, eq, sql, and, inArray } from 'drizzle-orm';
import { optionalAuth, uiOnlyAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import type { TwitterAction, TwitterCreds } from '../sync/twitter.js';
import { parseFgConfig, requireRead, resolveTwitterReadPerms, isSendEnabled, isApprovalRequired } from './permissions-utils.js';

const router = Router();
const CREDS_KEY = 'credentials.twitter';

function getTwitterCreds(): TwitterCreds | null {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, CREDS_KEY)).get();
  if (!row) return null;
  try { return JSON.parse(row.value) as TwitterCreds; } catch { return null; }
}

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', optionalAuth, requireRead('twitter'), (req, res) => {
  const manager = getConnectionManager();
  const status = manager.getStatus('twitter');
  const db = getDb();
  const count = db.select({ count: sql<number>`count(*)` }).from(twitterDms).get();
  const creds = getTwitterCreds();
  res.json({
    connected: status.status === 'connected',
    status: status.status,
    handle: status.displayName || creds?.handle || null,
    userId: status.accountId || creds?.userId || null,
    dmCount: count?.count || 0,
    configured: !!creds?.cookieString,
  });
});

// ── Auth routes ───────────────────────────────────────────────────────────────

router.get('/auth/status', optionalAuth, requireRead('twitter'), (req, res) => {
  const creds = getTwitterCreds();
  const manager = getConnectionManager();
  const status = manager.getStatus('twitter');
  res.json({
    configured: !!creds?.cookieString,
    connected: status.status === 'connected',
    handle: creds?.handle || null,
    cookiesValid: !!creds?.cookies,
  });
});

router.post('/auth/connect', uiOnlyAuth, (req, res) => {
  const { cookieString } = req.body as Partial<TwitterCreds>;
  if (!cookieString?.trim()) {
    return res.status(400).json({ error: 'cookieString is required — paste the Cookie header from your browser DevTools' });
  }

  const manager = getConnectionManager();
  // Fire-and-forget — connection verify can take several seconds; status is pushed via WebSocket.
  manager.connectTwitter({ cookieString: cookieString.trim() }).catch((e) => {
    console.error('[twitter] connect error:', e instanceof Error ? e.message : e);
  });

  res.json({ success: true, status: 'connecting' });
});

router.delete('/auth/disconnect', uiOnlyAuth, (req, res) => {
  const manager = getConnectionManager();
  manager.getTwitter()?.disconnect();
  res.json({ success: true });
});

router.post('/auth/refresh', uiOnlyAuth, async (req, res) => {
  const creds = getTwitterCreds();
  if (!creds?.cookieString) return res.status(400).json({ error: 'No credentials configured' });
  const manager = getConnectionManager();
  await manager.connectTwitter(creds);
  res.json({ success: manager.getStatus('twitter').status === 'connected' });
});

// ── Feed / Explore ────────────────────────────────────────────────────────────

router.get('/feed', optionalAuth, requireRead('twitter'), async (req, res) => {
  if (!resolveTwitterReadPerms((req as AuthedRequest).apiKey?.id).readTimeline) {
    return res.status(403).json({ error: 'Timeline access is not permitted for this API key' });
  }
  const { count = '20', reset = 'false' } = req.query as Record<string, string>;
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const tweets = await twitter.getHomeFeed(parseInt(count), reset === 'true');
    res.json({ tweets });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/search', optionalAuth, requireRead('twitter'), async (req, res) => {
  const { q = '', count = '20', mode = 'Latest' } = req.query as Record<string, string>;
  if (!q) return res.status(400).json({ error: 'q is required' });

  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    if (mode === 'People') {
      const profiles = await twitter.searchPeople(q, parseInt(count));
      return res.json({ profiles });
    }
    const tweets = await twitter.searchTweets(q, parseInt(count), mode as 'Latest' | 'Top');
    res.json({ tweets });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/trends', optionalAuth, requireRead('twitter'), async (req, res) => {
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const trends = await twitter.getTrends();
    res.json({ trends });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/tweet/:id', optionalAuth, requireRead('twitter'), async (req, res) => {
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const tweet = await twitter.getTweet(req.params['id'] as string);
    if (!tweet) return res.status(404).json({ error: 'Tweet not found' });
    res.json(tweet);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/tweet/:id/thread', optionalAuth, requireRead('twitter'), async (req, res) => {
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const tweets = await twitter.getTweetThread(req.params['id'] as string);
    res.json({ tweets });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/user/:handle', optionalAuth, requireRead('twitter'), async (req, res) => {
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const profile = await twitter.getUserProfile(req.params['handle'] as string);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/user/:handle/tweets', optionalAuth, requireRead('twitter'), async (req, res) => {
  const { count = '20' } = req.query as Record<string, string>;
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const tweets = await twitter.getUserTweets(req.params['handle'] as string, parseInt(count));
    res.json({ tweets });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/user/:handle/followers', optionalAuth, requireRead('twitter'), async (req, res) => {
  const { count = '50' } = req.query as Record<string, string>;
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const profiles = await twitter.getUserFollowers(req.params['handle'] as string, parseInt(count));
    res.json({ profiles });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/user/:handle/following', optionalAuth, requireRead('twitter'), async (req, res) => {
  const { count = '50' } = req.query as Record<string, string>;
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const profiles = await twitter.getUserFollowing(req.params['handle'] as string, parseInt(count));
    res.json({ profiles });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/me', optionalAuth, requireRead('twitter'), async (req, res) => {
  const creds = getTwitterCreds();
  if (!creds?.handle) return res.status(503).json({ error: 'Twitter not connected' });
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const profile = await twitter.getUserProfile(creds.handle);
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/notifications/mentions', optionalAuth, requireRead('twitter'), async (req, res) => {
  if (!resolveTwitterReadPerms((req as AuthedRequest).apiKey?.id).readTimeline) {
    return res.status(403).json({ error: 'Timeline access is not permitted for this API key' });
  }
  const { count = '20' } = req.query as Record<string, string>;
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const tweets = await twitter.getMentions(parseInt(count));
    res.json({ tweets });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── DM routes (stored data) ───────────────────────────────────────────────────

router.get('/dms', optionalAuth, requireRead('twitter'), (req, res) => {
  if (!resolveTwitterReadPerms((req as AuthedRequest).apiKey?.id).readDms) {
    return res.status(403).json({ error: 'DM access is not permitted for this API key' });
  }
  const { limit = '50', offset = '0' } = req.query as Record<string, string>;
  const db = getDb();
  const creds = getTwitterCreds();
  const myUserIdFromCreds = creds?.userId ? String(creds.userId) : null;
  // Also pull account IDs from the accounts table as a fallback
  const myAccountRows = db.select({ accountId: accounts.accountId })
    .from(accounts).where(eq(accounts.source, 'twitter')).all();
  const myUserIds = new Set<string>(myAccountRows.map((a) => a.accountId));
  if (myUserIdFromCreds) myUserIds.add(myUserIdFromCreds);

  // Latest message + total count per conversation via window functions —
  // avoids pulling every DM row into JS.
  type LatestRow = {
    conversation_id: string;
    message_id: string;
    sender_id: string;
    sender_handle: string | null;
    sender_name: string | null;
    recipient_id: string | null;
    text: string | null;
    created_at: string;
    msg_count: number;
  };
  const latest = db.all<LatestRow>(sql`
    SELECT conversation_id, message_id, sender_id, sender_handle, sender_name,
           recipient_id, text, created_at, msg_count
    FROM (
      SELECT conversation_id, message_id, sender_id, sender_handle, sender_name,
             recipient_id, text, created_at,
             COUNT(*) OVER (PARTITION BY conversation_id) AS msg_count,
             ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS rn
      FROM twitter_dms
    )
    WHERE rn = 1
    ORDER BY created_at DESC
  `);

  // One DISTINCT participants query (senders carry their latest handle/name via
  // SQLite's bare-column-with-MAX semantics; recipients have no handle info).
  type ParticipantRow = {
    conversation_id: string;
    participant: string;
    handle: string | null;
    name: string | null;
    last_at: string | null;
  };
  const participantRows = db.all<ParticipantRow>(sql`
    SELECT conversation_id, sender_id AS participant, sender_handle AS handle,
           sender_name AS name, MAX(created_at) AS last_at
    FROM twitter_dms
    WHERE sender_id IS NOT NULL AND sender_id != ''
    GROUP BY conversation_id, sender_id
    UNION ALL
    SELECT DISTINCT conversation_id, recipient_id AS participant, NULL, NULL, NULL
    FROM twitter_dms
    WHERE recipient_id IS NOT NULL AND recipient_id != ''
  `);

  // Group participants by conversation in JS
  type ParticipantInfo = { handle: string | null; name: string | null; lastAt: string };
  const participantsByConv = new Map<string, Map<string, ParticipantInfo>>();
  for (const row of participantRows) {
    let conv = participantsByConv.get(row.conversation_id);
    if (!conv) { conv = new Map(); participantsByConv.set(row.conversation_id, conv); }
    const existing = conv.get(row.participant);
    if (!existing) {
      conv.set(row.participant, { handle: row.handle, name: row.name, lastAt: row.last_at ?? '' });
    } else if (row.handle || row.name) {
      // Sender info wins over the bare recipient entry
      existing.handle = existing.handle ?? row.handle;
      existing.name = existing.name ?? row.name;
      if ((row.last_at ?? '') > existing.lastAt) existing.lastAt = row.last_at ?? '';
    }
  }

  // ONE contacts lookup for all participants' avatars
  const allParticipantIds = new Set<string>();
  for (const conv of participantsByConv.values()) {
    for (const pid of conv.keys()) allParticipantIds.add(pid);
  }
  const avatarByUserId = new Map<string, string | null>();
  if (allParticipantIds.size > 0) {
    const contactRows = db.select({ platformId: contacts.platformId, avatarUrl: contacts.avatarUrl })
      .from(contacts)
      .where(and(eq(contacts.source, 'twitter'), inArray(contacts.platformId, [...allParticipantIds])))
      .all();
    for (const c of contactRows) avatarByUserId.set(c.platformId, c.avatarUrl);
  }

  // `latest` is already ordered by created_at DESC — the load-bearing sort.
  const conversations = latest.map((r) => {
    const conv = participantsByConv.get(r.conversation_id) ?? new Map<string, ParticipantInfo>();
    const participantIds = [...conv.keys()];
    // Other participants (not the logged-in user), most recently active first
    const others = [...conv.entries()]
      .filter(([pid]) => !myUserIds.has(pid))
      .sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt));
    const otherHandle = others.find(([, info]) => info.handle)?.[1].handle ?? '';
    const otherName = others.find(([, info]) => info.name)?.[1].name ?? '';
    const otherAvatarUrl = others.length > 0
      ? avatarByUserId.get(others[0][0]) || null
      : null;
    return {
      conversationId: r.conversation_id,
      participantIds,
      lastMessage: {
        conversationId: r.conversation_id,
        messageId: r.message_id,
        senderId: r.sender_id,
        senderHandle: r.sender_handle,
        senderName: r.sender_name,
        recipientId: r.recipient_id,
        text: r.text,
        createdAt: r.created_at,
      },
      messageCount: r.msg_count,
      otherHandle,
      otherName,
      otherAvatarUrl,
    };
  });

  const lim = Math.min(parseInt(limit), 100);
  const off = parseInt(offset);
  res.json({ conversations: conversations.slice(off, off + lim), total: conversations.length });
});

router.get('/dms/:conversationId', optionalAuth, requireRead('twitter'), (req, res) => {
  if (!resolveTwitterReadPerms((req as AuthedRequest).apiKey?.id).readDms) {
    return res.status(403).json({ error: 'DM access is not permitted for this API key' });
  }
  const { limit = '100' } = req.query as Record<string, string>;
  const db = getDb();
  const lim = Math.max(parseInt(limit) || 100, 1);

  // Fetch the NEWEST `lim` messages in SQL, then reverse to ascending order —
  // the UI depends on ascending chronological order.
  const messages = db.select().from(twitterDms)
    .where(eq(twitterDms.conversationId, req.params['conversationId'] as string))
    .orderBy(desc(twitterDms.createdAt))
    .limit(lim)
    .all()
    .reverse();

  // Attach avatar URLs from the contacts table with ONE batched lookup
  const senderIds = [...new Set(messages.map((m) => m.senderId).filter(Boolean) as string[])];
  const avatarBySender = new Map<string, string | null>();
  if (senderIds.length > 0) {
    const contactRows = db.select({ platformId: contacts.platformId, avatarUrl: contacts.avatarUrl })
      .from(contacts)
      .where(and(eq(contacts.source, 'twitter'), inArray(contacts.platformId, senderIds)))
      .all();
    for (const c of contactRows) avatarBySender.set(c.platformId, c.avatarUrl);
  }

  const enriched = messages.map((m) => ({
    ...m,
    senderAvatarUrl: avatarBySender.get(m.senderId) ?? null,
  }));

  res.json({ messages: enriched, conversationId: req.params['conversationId'] });
});

// ── Analytics ─────────────────────────────────────────────────────────────────

router.get('/analytics', optionalAuth, requireRead('twitter'), async (req, res) => {
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const tweets = await twitter.getOwnTweets(200);

    // Per-tweet metrics
    type TweetAnalytic = {
      id: string; text: string; timestamp: number; date: string;
      likes: number; retweets: number; replies: number; totalEngagement: number; url: string;
    };

    const enriched: TweetAnalytic[] = tweets
      .filter((t) => t.id)
      .map((t) => {
        const likes    = t.likes    || 0;
        const retweets = t.retweets || 0;
        const replies  = t.replies  || 0;
        return {
          id:              t.id ?? '',
          text:            t.text || '',
          timestamp:       t.timestamp || 0,
          date:            t.timestamp ? new Date(t.timestamp * 1000).toISOString() : '',
          likes,
          retweets,
          replies,
          totalEngagement: likes + retweets + replies,
          url:             t.permanentUrl || '',
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp); // newest first

    // Aggregate by day
    const dayMap = new Map<string, { likes: number; retweets: number; replies: number; tweets: number }>();
    for (const t of enriched) {
      if (!t.timestamp) continue;
      const day = new Date(t.timestamp * 1000).toISOString().split('T')[0];
      const bucket = dayMap.get(day) ?? { likes: 0, retweets: 0, replies: 0, tweets: 0 };
      bucket.likes    += t.likes;
      bucket.retweets += t.retweets;
      bucket.replies  += t.replies;
      bucket.tweets   += 1;
      dayMap.set(day, bucket);
    }
    const byDay = Array.from(dayMap.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Summary
    const n = enriched.length;
    const totalLikes    = enriched.reduce((s, t) => s + t.likes,    0);
    const totalRetweets = enriched.reduce((s, t) => s + t.retweets, 0);
    const totalReplies  = enriched.reduce((s, t) => s + t.replies,  0);
    const byEngagement  = [...enriched].sort((a, b) => b.totalEngagement - a.totalEngagement);
    const byLikes       = [...enriched].sort((a, b) => b.likes - a.likes);
    const byRetweets    = [...enriched].sort((a, b) => b.retweets - a.retweets);

    res.json({
      handle: twitter.accountInfo?.handle || '',
      tweets: enriched,
      byDay,
      summary: {
        totalTweets:   n,
        totalLikes,
        totalRetweets,
        totalReplies,
        avgLikes:       n ? +(totalLikes    / n).toFixed(1) : 0,
        avgRetweets:    n ? +(totalRetweets / n).toFixed(1) : 0,
        avgEngagement:  n ? +((totalLikes + totalRetweets + totalReplies) / n).toFixed(1) : 0,
        bestTweet:      byEngagement[0] ?? null,
        mostLiked:      byLikes[0]      ?? null,
        mostRetweeted:  byRetweets[0]   ?? null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/sync', optionalAuth, requireRead('twitter'), async (req, res) => {
  const manager = getConnectionManager();
  const twitter = manager.getTwitter();
  if (!twitter) return res.status(503).json({ error: 'Twitter not connected' });

  try {
    const count = await twitter.syncDMs();
    res.json({ success: true, newMessages: count });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Helper: create a Twitter outbox item with permission checks and optional auto-dispatch.
 * Returns the outbox item ID and status.
 */
function queueTwitterAction(
  action: TwitterAction,
  authedReq: AuthedRequest,
): { outboxId: number; status: string } {
  const db = getDb();
  if (!isSendEnabled('twitter', authedReq.apiKey?.id)) {
    throw Object.assign(new Error('Twitter actions are not enabled'), { statusCode: 403 });
  }

  // For API key actors, check fine-grained Twitter permissions
  if (authedReq.actor === 'api' && authedReq.apiKey?.id) {
    const db = getDb();
    const global = db.select().from(permissions).where(eq(permissions.service, 'twitter')).get();
    const override = db.select().from(apiKeyPermissions)
      .where(and(eq(apiKeyPermissions.apiKeyId, authedReq.apiKey.id), eq(apiKeyPermissions.service, 'twitter')))
      .get();
    const fg: TwitterFineGrained | null = (parseFgConfig(override?.fineGrainedConfig ?? global?.fineGrainedConfig) as TwitterFineGrained | null);
    if (fg) {
      if (action.action === 'tweet' || action.action === 'reply' || action.action === 'quote') {
        if (fg.allowTweets === false) {
          throw Object.assign(new Error('Tweet posting is not allowed for this API key'), { statusCode: 403 });
        }
      }
      if (action.action === 'dm') {
        if (fg.allowDmReplies === false) {
          throw Object.assign(new Error('DM sending is not allowed for this API key'), { statusCode: 403 });
        }
      }
    }
  }

  const status = isApprovalRequired('twitter', authedReq.apiKey?.id) ? 'pending' : 'approved';
  const recipientId = action.conversationId || action.handle || action.tweetId || 'twitter';
  const recipientName = action.handle || action.action;

  const insertResult = db.insert(outbox).values({
    source: 'twitter',
    recipientId,
    recipientName,
    content: JSON.stringify(action),
    status,
    requester: authedReq.actor,
    apiKeyId: authedReq.apiKey?.id || null,
  }).run();

  const outboxId = insertResult.lastInsertRowid as number;

  writeAuditLog('send_request', authedReq.actor, {
    service: 'twitter',
    targetId: String(outboxId),
    detail: { action: action.action },
  });

  broadcast({ type: 'outbox:new', data: { id: outboxId, source: 'twitter', status } });

  if (status === 'approved') {
    const manager = getConnectionManager();
    manager.executeTwitterAction(action).then(() => {
      db.update(outbox).set({ status: 'sent', sentAt: new Date().toISOString() })
        .where(eq(outbox.id, outboxId)).run();
      broadcast({ type: 'outbox:updated', data: { id: outboxId, status: 'sent' } });
    }).catch((e: Error) => {
      db.update(outbox).set({ status: 'failed', errorMessage: e.message })
        .where(eq(outbox.id, outboxId)).run();
    });
  }

  return { outboxId, status };
}

router.post('/actions', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const action = req.body as TwitterAction;

  if (!action?.action) return res.status(400).json({ error: 'action is required' });

  try {
    const { outboxId, status } = queueTwitterAction(action, authedReq);
    res.json({ success: true, outboxItemId: outboxId, status });
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /api/twitter/tweet
 * Convenience endpoint to post a tweet (or threaded reply) through the outbox.
 * Body: { text: string, replyToId?: string }
 *
 * Respects the `allowTweets` fine-grained permission for API key actors.
 * Obeys the global `requireApproval` setting (goes to outbox pending state when true).
 */
router.post('/tweet', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const { text, replyToId } = req.body as { text?: string; replyToId?: string };

  if (!text?.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const action: TwitterAction = {
    action: replyToId ? 'reply' : 'tweet',
    text: text.trim(),
    ...(replyToId ? { replyToId } : {}),
  };

  try {
    const { outboxId, status } = queueTwitterAction(action, authedReq);
    res.json({ success: true, outboxItemId: outboxId, status });
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
