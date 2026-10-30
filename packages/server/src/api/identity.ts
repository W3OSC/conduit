/**
 * Identity resolution and contact → chats mapping.
 *
 * Built for reconcile jobs (one call per lead, hundreds of leads per run):
 *
 *   POST /api/contacts/resolve
 *     Input: any combination of name, email, domain, handle, phone, company
 *     (+ optional sources[] and limit). Output: ranked candidates with the
 *     fields that matched, a confidence score, the owning connected account,
 *     DM availability and — where a direct conversation exists — the sendable
 *     dmChatId. An empty candidate list states explicitly that no connected
 *     account has seen the identity.
 *
 *   GET /api/contacts/{source}/{platformId}/chats
 *     Every chat the contact participates in (derived from the message
 *     tables), with chatId, chatType, last activity, and direct DMs flagged —
 *     this is what turns a matched contact into a sendable route.
 *
 * Both endpoints return the standard `coverage` block (see coverage.ts).
 */

import { Router } from 'express';
import { and, eq, desc, sql, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  contacts, telegramMessages, discordMessages, slackMessages, twitterDms, gmailMessages,
} from '../db/schema.js';
import { optionalAuth, trackAiCall, type AuthedRequest } from '../auth/middleware.js';
import { isReadEnabled } from './permissions-utils.js';
import { buildCoverage } from './coverage.js';
import {
  z, boundedInt, bodyOf, paramsOf, queryOf, validateBody, validateParams, validateQuery,
} from './validate.js';
import { documentRoute } from './openapi-registry.js';

const router = Router();

/** Sources a contact row can come from. */
const RESOLVE_SOURCES = ['slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar'] as const;
type ResolveSource = typeof RESOLVE_SOURCES[number];

// ─── Request schemas ──────────────────────────────────────────────────────────

const ResolveBody = z.object({
  name: z.string().trim().optional().openapi({ description: 'Person name; tokenised and matched against display/first/last name.' }),
  email: z.string().trim().optional().openapi({ description: 'Email address; matched exactly (case-insensitive) against known addresses.' }),
  domain: z.string().trim().optional().openapi({ description: 'Company domain, e.g. "symbiosis.finance"; matches email domains and the org token in display names/bios.' }),
  handle: z.string().trim().optional().openapi({ description: 'Platform handle, with or without a leading @.' }),
  phone: z.string().trim().optional().openapi({ description: 'Phone number in any format; digits are compared by suffix.' }),
  company: z.string().trim().optional().openapi({ description: 'Company name; tokens matched against display names, usernames and bios.' }),
  sources: z.array(z.enum(RESOLVE_SOURCES)).optional()
    .openapi({ description: 'Restrict the search to these services (default: all).' }),
  limit: boundedInt({ default: 5, max: 25, description: 'Max candidates to return (default 5, max 25).' }),
}).strict().refine(
  (b) => !!(b.name || b.email || b.domain || b.handle || b.phone || b.company),
  { error: 'at least one of name, email, domain, handle, phone, company is required' },
);

const ContactParams = z.object({
  source: z.string().min(1),
  platformId: z.string().min(1),
});

const ChatsQuery = z.object({
  limit: boundedInt({ default: 50, max: 200, description: 'Max chats to return (default 50, max 200).' }),
});

documentRoute({
  method: 'post',
  path: '/contacts/resolve',
  body: ResolveBody,
  summary: 'Resolve an external identity to known contacts',
  description:
    'Ranked candidate contacts for any combination of name, email, domain, handle, phone and company. ' +
    'Each candidate carries a confidence score, the fields that matched, the connected account that saw it, ' +
    'DM availability and the direct-conversation chat id where one exists. ' +
    'An empty candidate list means no connected account has seen this identity (see the coverage block for which accounts were searched). ' +
    'Cheap enough to call once per lead in a reconcile run.',
  bodyDescription: 'Identity fields to resolve. At least one is required.',
})
documentRoute({
  method: 'get',
  path: '/contacts/{source}/{platformId}/chats',
  params: ContactParams,
  query: ChatsQuery,
  summary: 'Chats a contact participates in',
  description:
    'All chats this contact participates in, derived from synced messages: chatId, chatType, last activity, ' +
    'message count, with direct DMs flagged (isDm). Use the DM entry\'s chatId as the sendable route for this contact.',
});

// ─── Normalised query ─────────────────────────────────────────────────────────

interface NormQuery {
  nameTokens: string[];
  email?: string;
  domain?: string;
  orgTokens: string[];
  handle?: string;
  phoneDigits?: string;
}

function tokenize(value: string, minLen: number): string[] {
  return value.toLowerCase().split(/[\s|,/()@"']+/).map((t) => t.trim()).filter((t) => t.length >= minLen);
}

function normalizeQuery(b: z.infer<typeof ResolveBody>): NormQuery {
  const orgTokens: string[] = [];
  let domain: string | undefined;
  if (b.domain) {
    domain = b.domain.toLowerCase().replace(/^www\./, '');
    // "symbiosis.finance" → "symbiosis": the org token that shows up in
    // display names like "Nathan | Symbiosis" on platforms without emails.
    const label = domain.split('.')[0];
    if (label && label.length >= 3) orgTokens.push(label);
  }
  if (b.company) {
    for (const t of tokenize(b.company, 3)) orgTokens.push(t);
  }
  return {
    nameTokens: b.name ? tokenize(b.name, 2) : [],
    email: b.email?.toLowerCase() || undefined,
    domain,
    orgTokens: [...new Set(orgTokens)],
    handle: b.handle ? b.handle.toLowerCase().replace(/^@/, '') : undefined,
    phoneDigits: b.phone ? b.phone.replace(/\D/g, '') : undefined,
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

type ContactRow = {
  id: number;
  source: string;
  platformId: string;
  accountId: string | null;
  displayName: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  bio: string | null;
  hasDm: boolean | null;
  lastMessageAt: string | null;
};

interface Scored {
  contact: ContactRow;
  confidence: number;
  matchedFields: string[];
  evidence: string[];
}

/** The contact's email address, when one is known. */
function contactEmail(c: ContactRow): string | null {
  if (c.platformId.includes('@')) return c.platformId.toLowerCase();
  if (c.username?.includes('@')) return c.username.toLowerCase();
  return null;
}

function scoreContact(c: ContactRow, q: NormQuery): Scored | null {
  let score = 0;
  const matchedFields: string[] = [];
  const evidence: string[] = [];

  const email = contactEmail(c);
  const username = c.username?.toLowerCase() ?? '';
  const nameHaystack = [c.displayName, c.firstName, c.lastName]
    .filter(Boolean).join(' ').toLowerCase();
  const orgHaystack = [c.displayName, c.username, c.bio].filter(Boolean).join(' ').toLowerCase();

  if (q.email) {
    if (email === q.email) {
      score += 1.0;
      matchedFields.push('email');
      evidence.push(`known address ${email} equals the queried email`);
    } else if (q.email && orgHaystack.includes(q.email)) {
      score += 0.5;
      matchedFields.push('email');
      evidence.push(`profile text contains ${q.email}`);
    }
  }

  if (q.domain && email?.endsWith(`@${q.domain}`)) {
    score += 0.6;
    matchedFields.push('domain');
    evidence.push(`email domain is ${q.domain}`);
  }

  if (q.orgTokens.length) {
    const hit = q.orgTokens.find((t) => orgHaystack.includes(t));
    if (hit) {
      score += 0.35;
      matchedFields.push(q.domain && q.orgTokens[0] === hit ? 'domain' : 'company');
      evidence.push(`profile contains "${hit}"`);
    }
  }

  if (q.handle) {
    if (username === q.handle) {
      score += 0.9;
      matchedFields.push('handle');
      evidence.push(`username is @${q.handle}`);
    } else if (username.includes(q.handle) || nameHaystack.includes(q.handle)) {
      score += 0.45;
      matchedFields.push('handle');
      evidence.push(`profile contains "${q.handle}"`);
    }
  }

  if (q.phoneDigits && q.phoneDigits.length >= 7 && c.phone) {
    const theirs = c.phone.replace(/\D/g, '');
    const a = theirs.slice(-9);
    const b = q.phoneDigits.slice(-9);
    if (a && b && (a.endsWith(b) || b.endsWith(a))) {
      score += 0.85;
      matchedFields.push('phone');
      evidence.push('phone number matches');
    }
  }

  if (q.nameTokens.length) {
    const matched = q.nameTokens.filter((t) => nameHaystack.includes(t) || username.includes(t));
    if (matched.length === q.nameTokens.length) {
      score += 0.6;
      matchedFields.push('name');
      evidence.push(`name matches "${matched.join(' ')}"`);
    } else if (matched.length > 0) {
      score += 0.3 * (matched.length / q.nameTokens.length);
      matchedFields.push('name');
      evidence.push(`name partially matches ("${matched.join(' ')}")`);
    }
  }

  if (matchedFields.length === 0) return null;

  // Engagement nudges separate "person we actually talk to" from namesakes —
  // deliberately small so they never outrank a stronger field match.
  if (c.hasDm) score += 0.05;
  if (c.lastMessageAt) score += 0.05;

  return {
    contact: c,
    confidence: Math.min(1, Math.round(score * 100) / 100),
    matchedFields: [...new Set(matchedFields)],
    evidence,
  };
}

// ─── Per-candidate enrichment (DM route + activity) ───────────────────────────

interface DmInfo {
  dmChatId: string | null;
  messageCount: number;
  lastMessageAt: string | null;
}

function lookupDmAndActivity(db: ReturnType<typeof getDb>, c: ContactRow): DmInfo {
  if (c.source === 'telegram') {
    const uid = parseInt(c.platformId, 10);
    const agg = db.select({
      count: sql<number>`count(*)`,
      lastTs: sql<string | null>`max(${telegramMessages.timestamp})`,
    }).from(telegramMessages).where(eq(telegramMessages.senderId, uid)).get();
    // For Telegram the DM chat id IS the peer's user id; a direct conversation
    // exists when that chat has messages (either direction) or the contact is
    // flagged hasDm by sync.
    const dmRow = db.select({ count: sql<number>`count(*)` })
      .from(telegramMessages).where(eq(telegramMessages.chatId, uid)).get();
    const hasDirect = (dmRow?.count ?? 0) > 0 || !!c.hasDm;
    return {
      dmChatId: hasDirect ? c.platformId : null,
      messageCount: agg?.count ?? 0,
      lastMessageAt: agg?.lastTs ?? c.lastMessageAt,
    };
  }

  if (c.source === 'discord') {
    const agg = db.select({
      count: sql<number>`count(*)`,
      lastTs: sql<string | null>`max(${discordMessages.timestamp})`,
    }).from(discordMessages).where(eq(discordMessages.authorId, c.platformId)).get();
    const dm = db.select({ channelId: discordMessages.channelId })
      .from(discordMessages)
      .where(and(eq(discordMessages.authorId, c.platformId), isNull(discordMessages.guildId)))
      .orderBy(desc(discordMessages.timestamp)).limit(1).get();
    return {
      dmChatId: dm?.channelId ?? null,
      messageCount: agg?.count ?? 0,
      lastMessageAt: agg?.lastTs ?? c.lastMessageAt,
    };
  }

  if (c.source === 'slack') {
    const agg = db.select({
      count: sql<number>`count(*)`,
      lastTs: sql<string | null>`max(${slackMessages.timestamp})`,
    }).from(slackMessages).where(eq(slackMessages.userId, c.platformId)).get();
    const dm = db.select({ channelId: slackMessages.channelId })
      .from(slackMessages)
      .where(and(eq(slackMessages.userId, c.platformId), sql`${slackMessages.channelId} LIKE 'D%'`))
      .orderBy(desc(slackMessages.timestamp)).limit(1).get();
    return {
      dmChatId: dm?.channelId ?? null,
      messageCount: agg?.count ?? 0,
      lastMessageAt: agg?.lastTs ?? c.lastMessageAt,
    };
  }

  if (c.source === 'twitter') {
    const agg = db.select({
      count: sql<number>`count(*)`,
      lastTs: sql<string | null>`max(${twitterDms.createdAt})`,
    }).from(twitterDms).where(eq(twitterDms.senderId, c.platformId)).get();
    const dm = db.select({ conversationId: twitterDms.conversationId })
      .from(twitterDms).where(eq(twitterDms.senderId, c.platformId))
      .orderBy(desc(twitterDms.createdAt)).limit(1).get();
    return {
      dmChatId: dm?.conversationId ?? null,
      messageCount: agg?.count ?? 0,
      lastMessageAt: agg?.lastTs ?? c.lastMessageAt,
    };
  }

  if (c.source === 'gmail' || c.source === 'calendar') {
    const address = contactEmail(c);
    if (address) {
      const agg = db.select({
        count: sql<number>`count(*)`,
        lastTs: sql<string | null>`max(${gmailMessages.internalDate})`,
      }).from(gmailMessages).where(sql`lower(${gmailMessages.fromAddress}) = ${address}`).get();
      // Email has no chat id — the address itself is the sendable route.
      return {
        dmChatId: null,
        messageCount: agg?.count ?? 0,
        lastMessageAt: agg?.lastTs ?? c.lastMessageAt,
      };
    }
  }

  return { dmChatId: null, messageCount: 0, lastMessageAt: c.lastMessageAt };
}

// ─── POST /api/contacts/resolve ───────────────────────────────────────────────

router.post('/resolve', optionalAuth, trackAiCall, validateBody(ResolveBody), (req, res) => {
  const body = bodyOf(ResolveBody, req);
  const q = normalizeQuery(body);
  const db = getDb();
  const apiKeyId = (req as AuthedRequest).apiKey?.id;

  const requested: ResolveSource[] = body.sources?.length ? body.sources : [...RESOLVE_SOURCES];
  const searched = apiKeyId
    ? requested.filter((s) => isReadEnabled(s, apiKeyId))
    : requested;

  let rows: ContactRow[] = [];
  if (searched.length) {
    rows = db.select({
      id: contacts.id,
      source: contacts.source,
      platformId: contacts.platformId,
      accountId: contacts.accountId,
      displayName: contacts.displayName,
      username: contacts.username,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phone: contacts.phone,
      bio: contacts.bio,
      hasDm: contacts.hasDm,
      lastMessageAt: contacts.lastMessageAt,
    }).from(contacts)
      .where(sql`${contacts.source} IN (${sql.join(searched.map((s) => sql`${s}`), sql`, `)})`)
      .all();
  }

  const scored: Scored[] = [];
  for (const row of rows) {
    const s = scoreContact(row, q);
    if (s) scored.push(s);
  }
  scored.sort((a, b) =>
    b.confidence - a.confidence ||
    (b.contact.lastMessageAt || '').localeCompare(a.contact.lastMessageAt || ''));

  const top = scored.slice(0, body.limit);

  const candidates = top.map((s) => {
    const dm = lookupDmAndActivity(db, s.contact);
    return {
      contact: {
        source: s.contact.source,
        platformId: s.contact.platformId,
        displayName: s.contact.displayName,
        username: s.contact.username,
        email: contactEmail(s.contact),
        phone: s.contact.phone,
      },
      confidence: s.confidence,
      matchedFields: s.matchedFields,
      evidence: s.evidence,
      accountId: s.contact.accountId,
      hasDm: !!s.contact.hasDm || dm.dmChatId !== null,
      dmChatId: dm.dmChatId,
      messageCount: dm.messageCount,
      lastMessageAt: dm.lastMessageAt,
    };
  });

  const queried = { ...body };
  delete (queried as Record<string, unknown>)['limit'];
  delete (queried as Record<string, unknown>)['sources'];

  res.json({
    query: queried,
    candidates,
    ...(candidates.length === 0
      ? { resolution: 'no_match', message: `No connected account has seen ${describeQuery(queried)}.` }
      : {}),
    coverage: buildCoverage(requested, searched),
  });
});

function describeQuery(q: Record<string, unknown>): string {
  const parts = Object.entries(q)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `${k} "${String(v)}"`);
  return parts.join(', ') || 'this identity';
}

// ─── GET /api/contacts/:source/:platformId/chats ──────────────────────────────

interface ContactChat {
  chatId: string;
  chatName: string | null;
  chatType: string;
  isDm: boolean;
  messageCount: number;
  lastActivityAt: string | null;
}

router.get(
  '/:source/:platformId/chats',
  optionalAuth,
  trackAiCall,
  validateParams(ContactParams),
  validateQuery(ChatsQuery),
  (req, res) => {
    const { source, platformId } = paramsOf(ContactParams, req);
    const { limit } = queryOf(ChatsQuery, req);
    const apiKeyId = (req as AuthedRequest).apiKey?.id;
    if (apiKeyId && !isReadEnabled(source, apiKeyId)) {
      return res.status(403).json({ error: `Read access to ${source} is not permitted for this API key` });
    }

    const db = getDb();
    const contact = db.select().from(contacts)
      .where(and(eq(contacts.source, source), eq(contacts.platformId, platformId)))
      .get();
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const chats: ContactChat[] = [];

    if (source === 'telegram') {
      const uid = parseInt(platformId, 10);
      // sender_id = them (their messages anywhere) OR chat_id = them (their DM,
      // both directions — for Telegram the DM chat id IS the peer user id).
      const rows = db.select({
        chatId: telegramMessages.chatId,
        chatName: sql<string | null>`max(${telegramMessages.chatName})`,
        chatType: sql<string | null>`max(${telegramMessages.chatType})`,
        count: sql<number>`count(*)`,
        lastTs: sql<string | null>`max(${telegramMessages.timestamp})`,
      }).from(telegramMessages)
        .where(sql`${telegramMessages.senderId} = ${uid} OR ${telegramMessages.chatId} = ${uid}`)
        .groupBy(telegramMessages.chatId)
        .all();
      for (const r of rows) {
        const type = (r.chatType || '').toLowerCase();
        const isDm = r.chatId === uid || type === 'private' || type === 'user';
        chats.push({
          chatId: String(r.chatId),
          chatName: r.chatName,
          chatType: r.chatType || (isDm ? 'private' : 'group'),
          isDm,
          messageCount: r.count,
          lastActivityAt: r.lastTs,
        });
      }
      // A DM can exist (hasDm from sync) with no local messages yet.
      if (contact.hasDm && !chats.some((c) => c.isDm)) {
        chats.push({
          chatId: platformId,
          chatName: contact.displayName,
          chatType: 'private',
          isDm: true,
          messageCount: 0,
          lastActivityAt: null,
        });
      }
    } else if (source === 'discord') {
      const rows = db.select({
        chatId: discordMessages.channelId,
        chatName: sql<string | null>`max(${discordMessages.channelName})`,
        guildId: sql<string | null>`max(${discordMessages.guildId})`,
        guildName: sql<string | null>`max(${discordMessages.guildName})`,
        count: sql<number>`count(*)`,
        lastTs: sql<string | null>`max(${discordMessages.timestamp})`,
      }).from(discordMessages)
        .where(eq(discordMessages.authorId, platformId))
        .groupBy(discordMessages.channelId)
        .all();
      for (const r of rows) {
        chats.push({
          chatId: r.chatId,
          chatName: r.chatName ?? r.guildName,
          chatType: r.guildId ? 'guild_channel' : 'dm',
          isDm: !r.guildId,
          messageCount: r.count,
          lastActivityAt: r.lastTs,
        });
      }
    } else if (source === 'slack') {
      const rows = db.select({
        chatId: slackMessages.channelId,
        chatName: sql<string | null>`max(${slackMessages.channelName})`,
        count: sql<number>`count(*)`,
        lastTs: sql<string | null>`max(${slackMessages.timestamp})`,
      }).from(slackMessages)
        .where(eq(slackMessages.userId, platformId))
        .groupBy(slackMessages.channelId)
        .all();
      for (const r of rows) {
        const isDm = r.chatId.startsWith('D');
        chats.push({
          chatId: r.chatId,
          chatName: r.chatName,
          chatType: isDm ? 'dm' : r.chatId.startsWith('G') ? 'group_dm' : 'channel',
          isDm,
          messageCount: r.count,
          lastActivityAt: r.lastTs,
        });
      }
    } else if (source === 'twitter') {
      const rows = db.select({
        chatId: twitterDms.conversationId,
        count: sql<number>`count(*)`,
        lastTs: sql<string | null>`max(${twitterDms.createdAt})`,
      }).from(twitterDms)
        .where(eq(twitterDms.senderId, platformId))
        .groupBy(twitterDms.conversationId)
        .all();
      for (const r of rows) {
        chats.push({
          chatId: r.chatId,
          chatName: contact.displayName,
          chatType: 'dm',
          isDm: true,
          messageCount: r.count,
          lastActivityAt: r.lastTs,
        });
      }
    } else if (source === 'gmail' || source === 'calendar') {
      const address = platformId.toLowerCase();
      const rows = db.select({
        chatId: gmailMessages.threadId,
        chatName: sql<string | null>`max(${gmailMessages.subject})`,
        count: sql<number>`count(*)`,
        lastTs: sql<string | null>`max(${gmailMessages.internalDate})`,
      }).from(gmailMessages)
        .where(sql`lower(${gmailMessages.fromAddress}) = ${address}`)
        .groupBy(gmailMessages.threadId)
        .orderBy(desc(sql`max(${gmailMessages.internalDate})`))
        .limit(limit)
        .all();
      for (const r of rows) {
        chats.push({
          chatId: r.chatId,
          chatName: r.chatName,
          chatType: 'email_thread',
          isDm: true,
          messageCount: r.count,
          lastActivityAt: r.lastTs,
        });
      }
    } else {
      return res.status(400).json({ error: `Unknown source "${source}"` });
    }

    chats.sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));

    res.json({
      contact: {
        source,
        platformId,
        displayName: contact.displayName,
        username: contact.username,
      },
      chats: chats.slice(0, limit),
      total: chats.length,
      coverage: buildCoverage([source]),
    });
  },
);

export default router;
