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
import { twitterDms, outbox, permissions, settings, accounts, contacts } from '../db/schema.js';
import { desc, eq, sql, and } from 'drizzle-orm';
import { optionalAuth, writeAuditLog, type AuthedRequest } from '../auth/middleware.js';
import { getConnectionManager } from '../connections/manager.js';
import { broadcast } from '../websocket/hub.js';
import type { TwitterAction, TwitterCreds } from '../sync/twitter.js';

const router = Router();
const CREDS_KEY = 'credentials.twitter';

function getTwitterCreds(): TwitterCreds | null {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, CREDS_KEY)).get();
  if (!row) return null;
  try { return JSON.parse(row.value) as TwitterCreds; } catch { return null; }
}

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', optionalAuth, (req, res) => {
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

router.get('/auth/status', optionalAuth, (req, res) => {
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

router.post('/auth/connect', optionalAuth, (req, res) => {
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

router.delete('/auth/disconnect', optionalAuth, (req, res) => {
  const manager = getConnectionManager();
  manager.getTwitter()?.disconnect();
  res.json({ success: true });
});

router.post('/auth/refresh', optionalAuth, async (req, res) => {
  const creds = getTwitterCreds();
  if (!creds?.cookieString) return res.status(400).json({ error: 'No credentials configured' });
  const manager = getConnectionManager();
  await manager.connectTwitter(creds);
  res.json({ success: manager.getStatus('twitter').status === 'connected' });
});

// ── Feed / Explore ────────────────────────────────────────────────────────────

router.get('/feed', optionalAuth, async (req, res) => {
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

router.get('/search', optionalAuth, async (req, res) => {
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

router.get('/trends', optionalAuth, async (req, res) => {
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

router.get('/tweet/:id', optionalAuth, async (req, res) => {
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

router.get('/tweet/:id/thread', optionalAuth, async (req, res) => {
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

router.get('/user/:handle', optionalAuth, async (req, res) => {
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

router.get('/user/:handle/tweets', optionalAuth, async (req, res) => {
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

router.get('/user/:handle/followers', optionalAuth, async (req, res) => {
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

router.get('/user/:handle/following', optionalAuth, async (req, res) => {
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

router.get('/me', optionalAuth, async (req, res) => {
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

router.get('/notifications/mentions', optionalAuth, async (req, res) => {
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

router.get('/dms', optionalAuth, (req, res) => {
  const { limit = '50', offset = '0' } = req.query as Record<string, string>;
  const db = getDb();
  const creds = getTwitterCreds();
  const myUserIdFromCreds = creds?.userId ? String(creds.userId) : null;
  // Also pull account IDs from the accounts table as a fallback
  const myAccountRows = db.select({ accountId: accounts.accountId })
    .from(accounts).where(eq(accounts.source, 'twitter')).all();
  const myUserIds = new Set<string>(myAccountRows.map((a) => a.accountId));
  if (myUserIdFromCreds) myUserIds.add(myUserIdFromCreds);
  const all = db.select().from(twitterDms).orderBy(desc(twitterDms.createdAt)).all();

  // Group by conversationId
  type ConvEntry = {
    conversationId: string;
    participants: Set<string>;
    lastMessage: typeof all[0];
    messageCount: number;
    // Best known handle/name for the other participant
    otherHandle: string;
    otherName: string;
  };
  const convMap = new Map<string, ConvEntry>();
  for (const msg of all) {
    const c = convMap.get(msg.conversationId);
    if (!c) {
      convMap.set(msg.conversationId, {
        conversationId: msg.conversationId,
        participants: new Set([msg.senderId, msg.recipientId || ''].filter(Boolean)),
        lastMessage: msg,
        messageCount: 1,
        otherHandle: '',
        otherName: '',
      });
    } else {
      c.messageCount++;
      c.participants.add(msg.senderId);
      if (msg.recipientId) c.participants.add(msg.recipientId);
    }

    // Track the best handle/name for the other participant (not the logged-in user).
    // isFromMe: true if senderId matches any known account ID for the logged-in user.
    const entry = convMap.get(msg.conversationId)!;
    const isFromMe = myUserIds.size > 0
      ? myUserIds.has(String(msg.senderId))
      : false;
    if (!isFromMe && msg.senderHandle && !entry.otherHandle) {
      entry.otherHandle = msg.senderHandle;
    }
    if (!isFromMe && msg.senderName && !entry.otherName) {
      entry.otherName = msg.senderName;
    }
  }

  // Look up avatar URLs from the contacts table for all known participants
  const allParticipantIds = new Set<string>();
  for (const c of convMap.values()) {
    for (const pid of c.participants) allParticipantIds.add(pid);
  }
  const avatarByUserId = new Map<string, string | null>();
  for (const pid of allParticipantIds) {
    const contact = db.select({ avatarUrl: contacts.avatarUrl })
      .from(contacts)
      .where(and(eq(contacts.source, 'twitter'), eq(contacts.platformId, pid)))
      .get();
    if (contact) avatarByUserId.set(pid, contact.avatarUrl);
  }

  const conversations = [...convMap.values()].map((c) => {
    // Find the other participant's user id (not the logged-in user)
    const otherParticipantIds = [...c.participants].filter((pid) => !myUserIds.has(pid));
    const otherAvatarUrl = otherParticipantIds.length > 0
      ? avatarByUserId.get(otherParticipantIds[0]) || null
      : null;
    return {
      conversationId: c.conversationId,
      participantIds: [...c.participants],
      lastMessage: c.lastMessage,
      messageCount: c.messageCount,
      otherHandle: c.otherHandle,
      otherName: c.otherName,
      otherAvatarUrl,
    };
  }).sort((a, b) => (b.lastMessage.createdAt || '').localeCompare(a.lastMessage.createdAt || ''));

  const lim = Math.min(parseInt(limit), 100);
  const off = parseInt(offset);
  res.json({ conversations: conversations.slice(off, off + lim), total: conversations.length });
});

router.get('/dms/:conversationId', optionalAuth, (req, res) => {
  const { limit = '100' } = req.query as Record<string, string>;
  const db = getDb();
  const messages = db.select().from(twitterDms)
    .where(eq(twitterDms.conversationId, req.params['conversationId'] as string))
    .orderBy(twitterDms.createdAt)
    .all();

  // Attach avatar URLs from the contacts table keyed by senderId
  const senderIds = new Set(messages.map((m) => m.senderId).filter(Boolean) as string[]);
  const avatarBySender = new Map<string, string | null>();
  for (const sid of senderIds) {
    const contact = db.select({ avatarUrl: contacts.avatarUrl })
      .from(contacts)
      .where(and(eq(contacts.source, 'twitter'), eq(contacts.platformId, sid)))
      .get();
    if (contact) avatarBySender.set(sid, contact.avatarUrl);
  }

  const enriched = messages.map((m) => ({
    ...m,
    senderAvatarUrl: avatarBySender.get(m.senderId) ?? null,
  }));

  res.json({ messages: enriched.slice(0, parseInt(limit)), conversationId: req.params['conversationId'] });
});

// ── Analytics ─────────────────────────────────────────────────────────────────

router.get('/analytics', optionalAuth, async (req, res) => {
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

router.post('/sync', optionalAuth, async (req, res) => {
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

router.post('/actions', optionalAuth, (req, res) => {
  const authedReq = req as AuthedRequest;
  const action = req.body as TwitterAction;

  if (!action?.action) return res.status(400).json({ error: 'action is required' });

  const db = getDb();
  const perm = db.select().from(permissions).where(eq(permissions.service, 'twitter')).get();
  if (!perm?.sendEnabled) {
    return res.status(403).json({ error: 'Twitter actions are not enabled' });
  }

  const status = perm.requireApproval ? 'pending' : 'approved';
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

  res.json({ success: true, outboxItemId: outboxId, status });
});

export default router;
