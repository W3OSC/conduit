/**
 * ContactSync — discovers, normalises, and persists contacts from all three platforms.
 *
 * Design principles:
 * - All inserts use onConflictDoUpdate so criteria flags are OR'd across
 *   multiple discovery passes (once a flag is set it stays set).
 * - Lightweight "from message" path is fast enough to call on every live event.
 * - Full scan path is called from initialFullSync after message sync finishes.
 * - Criteria are loaded from the settings table on each call so UI changes
 *   take effect on the next sync without a restart.
 */

import { getDb } from '../db/client.js';
import {
  contacts, settings, gmailMessages, calendarEvents,
  slackMessages, discordMessages, telegramMessages, twitterDms, accounts,
} from '../db/schema.js';
import { eq, and, sql, isNull } from 'drizzle-orm';

// ─── Criteria ─────────────────────────────────────────────────────────────────

export interface ContactCriteria {
  enabled: boolean;
  hasDm: boolean;
  ownedGroup: boolean;
  smallGroup: boolean;
  nativeContacts: boolean;
  smallGroupThreshold: number; // default 50
}

const DEFAULTS: Record<string, ContactCriteria> = {
  slack:    { enabled: true, hasDm: true, ownedGroup: true, smallGroup: true, nativeContacts: true, smallGroupThreshold: 50 },
  discord:  { enabled: true, hasDm: true, ownedGroup: true, smallGroup: true, nativeContacts: true, smallGroupThreshold: 50 },
  telegram: { enabled: true, hasDm: true, ownedGroup: true, smallGroup: true, nativeContacts: true, smallGroupThreshold: 50 },
  gmail:    { enabled: true, hasDm: true, ownedGroup: false, smallGroup: false, nativeContacts: false, smallGroupThreshold: 50 },
  calendar: { enabled: true, hasDm: true, ownedGroup: false, smallGroup: false, nativeContacts: false, smallGroupThreshold: 50 },
  // Twitter: DM participants + following list as native contacts (both enabled by default)
  twitter:  { enabled: true, hasDm: true, ownedGroup: false, smallGroup: false, nativeContacts: true, smallGroupThreshold: 50 },
};

export function getContactCriteria(source: string): ContactCriteria {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, `contacts.${source}.criteria`)).get();
  if (!row) return DEFAULTS[source] ?? DEFAULTS.slack;
  try {
    return { ...DEFAULTS[source], ...(JSON.parse(row.value) as Partial<ContactCriteria>) };
  } catch {
    return DEFAULTS[source] ?? DEFAULTS.slack;
  }
}

export function setContactCriteria(source: string, criteria: Partial<ContactCriteria>): void {
  const db = getDb();
  const current = getContactCriteria(source);
  const merged = { ...current, ...criteria };
  const value = JSON.stringify(merged);
  db.insert(settings)
    .values({ key: `contacts.${source}.criteria`, value, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

// ─── Core upsert ──────────────────────────────────────────────────────────────

export interface UpsertContactData {
  source: string;
  platformId: string;
  accountId?: string;
  displayName?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  avatarUrl?: string;
  bio?: string;
  statusText?: string;
  workspaceIds?: string[];
  mutualGroupIds?: string[];
  rawJson?: Record<string, unknown>;

  // Criteria flags (OR'd on conflict — never cleared by an update)
  hasDm?: boolean;
  isFromOwnedGroup?: boolean;
  isFromSmallGroup?: boolean;
  isNativeContact?: boolean;

  lastMessageAt?: string;
  lastSeenAt?: string;
}

export function upsertContact(data: UpsertContactData): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Build a merge expression for criteria flags — use MAX(old, new) so flags are never cleared
  db.insert(contacts).values({
    source:           data.source,
    platformId:       data.platformId,
    accountId:        data.accountId ?? null,
    displayName:      data.displayName ?? null,
    username:         data.username ?? null,
    firstName:        data.firstName ?? null,
    lastName:         data.lastName ?? null,
    phone:            data.phone ?? null,
    avatarUrl:        data.avatarUrl ?? null,
    bio:              data.bio ?? null,
    statusText:       data.statusText ?? null,
    workspaceId:      data.workspaceIds ? JSON.stringify(data.workspaceIds) : null,
    mutualGroupIds:   data.mutualGroupIds ? JSON.stringify(data.mutualGroupIds) : null,
    hasDm:            data.hasDm ?? false,
    isFromOwnedGroup: data.isFromOwnedGroup ?? false,
    isFromSmallGroup: data.isFromSmallGroup ?? false,
    isNativeContact:  data.isNativeContact ?? false,
    lastMessageAt:    data.lastMessageAt ?? null,
    lastSeenAt:       data.lastSeenAt ?? null,
    firstSeenAt:      now,
    updatedAt:        now,
    rawJson:          data.rawJson ? JSON.stringify(data.rawJson) : null,
  }).onConflictDoUpdate({
    target: [contacts.source, contacts.platformId],
    set: {
      // Always update metadata fields
      displayName:      data.displayName ?? sql`display_name`,
      username:         data.username    ?? sql`username`,
      firstName:        data.firstName   ?? sql`first_name`,
      lastName:         data.lastName    ?? sql`last_name`,
      phone:            data.phone       ?? sql`phone`,
      avatarUrl:        data.avatarUrl   ?? sql`avatar_url`,
      bio:              data.bio         ?? sql`bio`,
      statusText:       data.statusText  ?? sql`status_text`,
      workspaceId:      data.workspaceIds ? JSON.stringify(data.workspaceIds) : sql`workspace_id`,
      mutualGroupIds:   data.mutualGroupIds ? JSON.stringify(data.mutualGroupIds) : sql`mutual_group_ids`,
      rawJson:          data.rawJson ? JSON.stringify(data.rawJson) : sql`raw_json`,
      updatedAt:        now,
      // Criteria flags: OR with existing values (never clear a flag once set)
      hasDm:            data.hasDm            ? true : sql`has_dm`,
      isFromOwnedGroup: data.isFromOwnedGroup ? true : sql`is_from_owned_group`,
      isFromSmallGroup: data.isFromSmallGroup ? true : sql`is_from_small_group`,
      isNativeContact:  data.isNativeContact  ? true : sql`is_native_contact`,
      // Timestamps — only update if new value is more recent
      lastMessageAt: data.lastMessageAt ? sql`CASE WHEN last_message_at IS NULL OR last_message_at < ${data.lastMessageAt} THEN ${data.lastMessageAt} ELSE last_message_at END` : sql`last_message_at`,
      lastSeenAt:    data.lastSeenAt    ? sql`CASE WHEN last_seen_at    IS NULL OR last_seen_at    < ${data.lastSeenAt}    THEN ${data.lastSeenAt}    ELSE last_seen_at    END` : sql`last_seen_at`,
    },
  }).run();
}

/**
 * Fast path called from live event handlers — just tracks that a message
 * was received from this person, sets hasDm if it's a DM channel.
 */
export function upsertContactFromMessage(opts: {
  source: string;
  platformId: string;
  accountId?: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
  isDm: boolean;
  isSmallGroup: boolean;
  isOwnedGroup: boolean;
  timestamp?: string;
}): void {
  const criteria = getContactCriteria(opts.source);
  if (!criteria.enabled) return;

  // Skip if none of the active criteria are met
  if (
    !(opts.isDm      && criteria.hasDm) &&
    !(opts.isOwnedGroup && criteria.ownedGroup) &&
    !(opts.isSmallGroup && criteria.smallGroup)
  ) return;

  upsertContact({
    source:           opts.source,
    platformId:       opts.platformId,
    accountId:        opts.accountId,
    displayName:      opts.displayName,
    username:         opts.username,
    avatarUrl:        opts.avatarUrl,
    hasDm:            opts.isDm && criteria.hasDm,
    isFromOwnedGroup: opts.isOwnedGroup && criteria.ownedGroup,
    isFromSmallGroup: opts.isSmallGroup && criteria.smallGroup,
    lastMessageAt:    opts.timestamp,
    lastSeenAt:       opts.timestamp,
  });
}

// ─── Slack ─────────────────────────────────────────────────────────────────────

interface SlackWebClient {
  users: {
    list: (opts?: { cursor?: string; limit?: number }) => Promise<{
      ok: boolean;
      members?: Array<{
        id?: string;
        name?: string;
        real_name?: string;
        profile?: {
          display_name?: string;
          real_name?: string;
          image_192?: string;
          image_72?: string;
          status_text?: string;
          phone?: string;
        };
        is_bot?: boolean;
        deleted?: boolean;
      }>;
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

export async function syncSlackContacts(
  client: SlackWebClient,
  accountId: string,
  _criteria: ContactCriteria,
): Promise<number> {
  // Slack: collect all non-bot, non-deleted workspace members.
  // The criteria flags concept still applies (we tag everyone as isNativeContact
  // since a Slack workspace is essentially the native contact list), but we
  // include everyone regardless.
  let count = 0;
  let cursor: string | undefined;

  do {
    const res = await client.users.list({ cursor, limit: 200 });
    if (!res.ok) break;

    for (const member of res.members ?? []) {
      if (!member.id || member.is_bot || member.deleted) continue;
      const displayName =
        member.profile?.display_name ||
        member.profile?.real_name ||
        member.real_name ||
        member.name ||
        member.id;

      upsertContact({
        source:          'slack',
        platformId:      member.id,
        accountId,
        displayName,
        username:        member.name,
        avatarUrl:       member.profile?.image_192 || member.profile?.image_72,
        statusText:      member.profile?.status_text,
        phone:           member.profile?.phone,
        isNativeContact: true,
        rawJson:         member as unknown as Record<string, unknown>,
      });
      count++;
    }

    cursor = res.response_metadata?.next_cursor || undefined;
    await sleep(300);
  } while (cursor);

  return count;
}

// ─── Discord ───────────────────────────────────────────────────────────────────

interface DiscordGuildMember {
  user?: { id: string; tag?: string; username?: string; discriminator?: string; avatar?: string; bot?: boolean };
  nickname?: string;
  roles?: string[];
  joinedAt?: string | Date;
  permissions?: { has?: (perm: string) => boolean; bitfield?: bigint };
}

interface DiscordGuildForContacts {
  id: string;
  name: string;
  ownerId?: string;
  memberCount?: number;
  members: {
    fetch: (opts?: { limit?: number; after?: string }) => Promise<Map<string, DiscordGuildMember>>;
    cache: Map<string, DiscordGuildMember>;
  };
}

interface DiscordChannelForContacts {
  id: string;
  type: number;
  recipient?: { id: string; tag?: string; username?: string; avatar?: string; bot?: boolean };
}

interface DiscordClientForContacts {
  guilds: { cache: Map<string, DiscordGuildForContacts> };
  channels: { cache: Map<string, DiscordChannelForContacts> };
  user: { id: string; tag?: string } | null;
  // Relationships (friend list) — only available on self-bots
  relationships?: {
    cache?: Map<string, { type: number; user?: { id: string; tag?: string; username?: string; avatar?: string } }>;
  };
}

function discordAvatarUrl(userId: string, hash?: string): string {
  if (hash) {
    const ext = hash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${ext}?size=128`;
  }
  // Fall back to Discord's default avatar based on the user's snowflake ID
  const defaultIndex = Number(BigInt(userId) >> 22n) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
}

export async function syncDiscordContacts(
  client: DiscordClientForContacts,
  accountId: string,
  criteria: ContactCriteria,
  allowedGuildIds: Set<string> | null,
): Promise<number> {
  let count = 0;
  const myId = client.user?.id;

  // 1. Native contacts — Discord friend list (relationships)
  if (criteria.nativeContacts) {
    const rels = client.relationships?.cache;
    if (rels) {
      for (const [, rel] of rels) {
        if (rel.type !== 1 /* FRIEND */ || !rel.user?.id) continue;
        upsertContact({
          source: 'discord', platformId: rel.user.id, accountId,
          displayName: rel.user.tag || rel.user.username,
          username: rel.user.tag || rel.user.username,
          avatarUrl: discordAvatarUrl(rel.user.id, rel.user.avatar),
          isNativeContact: true,
          rawJson: rel as unknown as Record<string, unknown>,
        });
        count++;
      }
    }
  }

  // 2. DM channels — everyone we have an open DM with
  if (criteria.hasDm) {
    for (const [, channel] of client.channels.cache) {
      if (channel.type !== 1 /* DM */ || !channel.recipient?.id) continue;
      if (channel.recipient.bot) continue;
      upsertContact({
        source: 'discord', platformId: channel.recipient.id, accountId,
        displayName: channel.recipient.tag || channel.recipient.username,
        username: channel.recipient.tag || channel.recipient.username,
        avatarUrl: discordAvatarUrl(channel.recipient.id, channel.recipient.avatar),
        hasDm: true,
        rawJson: channel.recipient as unknown as Record<string, unknown>,
      });
      count++;
    }
  }

  // 3. Guild members — only guilds in the allowlist (or all if no allowlist)
  for (const [, guild] of client.guilds.cache) {
    if (allowedGuildIds && !allowedGuildIds.has(guild.id)) continue;

    const memberCount = guild.memberCount ?? 0;
    const isOwned = guild.ownerId === myId;
    const isSmall = memberCount > 0 && memberCount < criteria.smallGroupThreshold;

    if (!isOwned && !isSmall && !criteria.nativeContacts) continue;

    // Fetch members (may require GUILD_MEMBERS intent — best-effort)
    let members: Map<string, DiscordGuildMember>;
    try {
      members = await guild.members.fetch({ limit: 1000 });
    } catch {
      members = guild.members.cache;
    }

    for (const [, member] of members) {
      if (!member.user?.id || member.user.bot || member.user.id === myId) continue;
      const isAdmin = member.permissions?.has?.('MANAGE_GUILD') ?? false;

      upsertContact({
        source: 'discord', platformId: member.user.id, accountId,
        displayName: member.nickname || member.user.tag || member.user.username,
        username: member.user.tag || member.user.username,
        avatarUrl: discordAvatarUrl(member.user.id, member.user.avatar),
        workspaceIds: [guild.id],
        isFromOwnedGroup: (isOwned || isAdmin) && criteria.ownedGroup,
        isFromSmallGroup: isSmall && criteria.smallGroup,
        rawJson: { userId: member.user.id, guildId: guild.id, guildName: guild.name, memberCount } as Record<string, unknown>,
      });
      count++;
    }

    await sleep(200);
  }

  return count;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

// We use GramJS's Entity types loosely via duck typing
interface TgUser {
  id: { toString(): string; valueOf(): number | bigint };
  className: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
  about?: string;
  bot?: boolean;
  photo?: { photoId?: { toString(): string } };
}

interface TgChat {
  id: { toString(): string };
  className: string;
  title?: string;
  creator?: boolean;
  adminRights?: Record<string, unknown>;
  participantsCount?: number;
  broadcast?: boolean;
}

interface TgParticipant {
  userId?: { toString(): string };
  user?: TgUser;
  isCreator?: boolean;
  isAdmin?: boolean;
}

interface TgDialog {
  entity?: unknown;
  isChannel?: boolean;
  isGroup?: boolean;
  isUser?: boolean;
}

interface GramJSClient {
  getDialogs: (opts?: { limit?: number }) => Promise<Array<TgDialog & { entity?: unknown }>>;
  getParticipants: (entity: unknown, opts?: { limit?: number }) => Promise<Array<TgParticipant>>;
  invoke: (request: unknown) => Promise<unknown>;
  downloadProfilePhoto: (entity: unknown, params?: { isBig?: boolean }) => Promise<Buffer | string | undefined>;
  me?: { id: { toString(): string } };
}

async function tgDownloadAvatar(client: GramJSClient, entity: unknown): Promise<string | undefined> {
  try {
    const result = await client.downloadProfilePhoto(entity, { isBig: false });
    if (!result || typeof result === 'string') return undefined;
    return `data:image/jpeg;base64,${result.toString('base64')}`;
  } catch {
    return undefined;
  }
}

export async function syncTelegramContacts(
  client: GramJSClient,
  accountId: string,
  criteria: ContactCriteria,
): Promise<number> {
  let count = 0;
  const myId = client.me?.id.toString();

  // 1. Native Telegram contacts (GetContacts API call)
  if (criteria.nativeContacts) {
    try {
      const { Api } = await import('telegram');
      const bigInt = (await import('big-integer')).default;
      const result = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) })) as {
        users?: Array<{ id: { toString(): string }; firstName?: string; lastName?: string; username?: string; phone?: string; className: string }>;
      };
      for (const user of result.users ?? []) {
        if (user.className === 'UserEmpty') continue;
        const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || user.id.toString();
        const avatarUrl = await tgDownloadAvatar(client, user);
        upsertContact({
          source: 'telegram', platformId: user.id.toString(), accountId,
          displayName, username: user.username, firstName: user.firstName,
          lastName: user.lastName, phone: user.phone,
          avatarUrl,
          isNativeContact: true,
          rawJson: user as unknown as Record<string, unknown>,
        });
        count++;
      }
    } catch (e) {
      console.error('[telegram] GetContacts failed:', e);
    }
  }

  // 2. Iterate dialogs
  const dialogs = await client.getDialogs({ limit: 500 });

  for (const dialog of dialogs) {
    const entity = dialog.entity as TgUser & TgChat | undefined;
    if (!entity) continue;

    // DM — entity is a User
    if (dialog.isUser) {
      const user = entity as TgUser;
      if (user.bot || user.id.toString() === myId) continue;

      if (criteria.hasDm) {
        const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || user.id.toString();
        const avatarUrl = await tgDownloadAvatar(client, user);
        upsertContact({
          source: 'telegram', platformId: user.id.toString(), accountId,
          displayName, username: user.username, firstName: user.firstName,
          lastName: user.lastName, phone: user.phone,
          avatarUrl,
          hasDm: true,
          rawJson: user as unknown as Record<string, unknown>,
        });
        count++;
      }
      continue;
    }

    // Group or channel
    if (!dialog.isGroup && !dialog.isChannel) continue;
    const chat = entity as TgChat;

    const isCreator = chat.creator === true;
    const isAdmin   = !!chat.adminRights;
    const isOwned   = isCreator || isAdmin;
    const memberCount = chat.participantsCount ?? 0;
    const isSmall = memberCount > 0 && memberCount < criteria.smallGroupThreshold;

    if (!isOwned && !isSmall) continue;
    if (!isOwned && !criteria.smallGroup) continue;
    if (isOwned && !criteria.ownedGroup) continue;

    // Fetch participants — channels need a different approach
    try {
      const participants = await client.getParticipants(entity, { limit: criteria.smallGroupThreshold + 10 });
      for (const p of participants) {
        const user = p.user;
        const userId = p.userId?.toString() || user?.id?.toString();
        if (!userId || userId === myId) continue;
        if ((user as TgUser | undefined)?.bot) continue;

        const displayName = user
          ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || userId
          : userId;

        const avatarUrl = user ? await tgDownloadAvatar(client, user) : undefined;
        upsertContact({
          source: 'telegram', platformId: userId, accountId,
          displayName,
          username: user?.username,
          firstName: user?.firstName,
          lastName: user?.lastName,
          phone: user?.phone,
          avatarUrl,
          mutualGroupIds: [chat.id.toString()],
          isFromOwnedGroup: isOwned && criteria.ownedGroup,
          isFromSmallGroup: isSmall && criteria.smallGroup,
          rawJson: user as unknown as Record<string, unknown>,
        });
        count++;
      }
    } catch { /* participant fetch may fail for large channels — skip */ }

    await sleep(400);
  }

  return count;
}

// ─── Gmail ─────────────────────────────────────────────────────────────────────

/**
 * Derives contacts from the local gmail_messages table.
 *
 * Discovery rules (each sets `hasDm: true` since email is always 1:1):
 *  - fromAddress / fromName  → people who emailed us
 *  - toAddresses / ccAddresses → people we emailed or were CC'd
 *
 * platformId for gmail contacts is the email address (lowercased).
 * displayName is the "Name" part of "Name <addr>" when available.
 */
export function syncGmailContactsFromDb(accountId?: string): number {
  const db = getDb();
  let count = 0;

  // Helper: parse a raw address string like "Alice <alice@example.com>" or just "alice@example.com"
  function parseAddress(raw: string): { email: string; name: string } | null {
    if (!raw) return null;
    const m = raw.match(/^"?([^"<]*)"?\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?$/);
    if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
    // bare address with no name part
    const bare = raw.trim().toLowerCase();
    if (bare.includes('@')) return { email: bare, name: '' };
    return null;
  }

  // Collect all rows — we need fromAddress, fromName, toAddresses, ccAddresses
  const rows = db
    .select({
      fromAddress: gmailMessages.fromAddress,
      fromName: gmailMessages.fromName,
      toAddresses: gmailMessages.toAddresses,
      ccAddresses: gmailMessages.ccAddresses,
      internalDate: gmailMessages.internalDate,
      syncedAt: gmailMessages.syncedAt,
    })
    .from(gmailMessages)
    .all();

  // Aggregate: email → { name, lastTs }
  const seen = new Map<string, { name: string; lastTs: string | null }>();

  const touch = (email: string, name: string, ts: string | null) => {
    const existing = seen.get(email);
    if (!existing) {
      seen.set(email, { name, lastTs: ts });
    } else {
      // Prefer non-empty names
      if (!existing.name && name) existing.name = name;
      // Keep most recent timestamp
      if (ts && (!existing.lastTs || ts > existing.lastTs)) existing.lastTs = ts;
    }
  };

  for (const row of rows) {
    const ts = row.internalDate || row.syncedAt || null;

    // Sender
    if (row.fromAddress) {
      touch(row.fromAddress.toLowerCase(), row.fromName || '', ts);
    }

    // To + Cc recipients (JSON arrays of address strings)
    for (const field of [row.toAddresses, row.ccAddresses]) {
      if (!field) continue;
      let addrs: string[] = [];
      try { addrs = JSON.parse(field) as string[]; } catch { continue; }
      for (const raw of addrs) {
        const parsed = parseAddress(raw);
        if (parsed) touch(parsed.email, parsed.name, ts);
      }
    }
  }

  // Skip our own account email
  const ownEmail = accountId?.toLowerCase();

  for (const [email, { name, lastTs }] of seen) {
    if (ownEmail && email === ownEmail) continue;
    upsertContact({
      source: 'gmail',
      platformId: email,
      accountId,
      displayName: name || email,
      username: email,
      hasDm: true,
      lastMessageAt: lastTs ?? undefined,
      lastSeenAt: lastTs ?? undefined,
    });
    count++;
  }

  return count;
}

// ─── Calendar ──────────────────────────────────────────────────────────────────

/**
 * Derives contacts from the local calendar_events table.
 *
 * Discovery rules:
 *  - attendees JSON field: each entry has { email, name, responseStatus }
 *  - organizerEmail / organizerName: person who created the event
 *
 * platformId is the email address (lowercased).
 * `hasDm: true` — every calendar contact represents a real human the user
 * directly scheduled with (equivalent to a DM relationship).
 * `lastMessageAt` is set to the event's startTime so the contact list stays
 * sorted by recency of interaction.
 */
export function syncCalendarContactsFromDb(accountId?: string): number {
  const db = getDb();
  let count = 0;

  const rows = db
    .select({
      attendees: calendarEvents.attendees,
      organizerEmail: calendarEvents.organizerEmail,
      organizerName: calendarEvents.organizerName,
      startTime: calendarEvents.startTime,
    })
    .from(calendarEvents)
    .all();

  const seen = new Map<string, { name: string; lastTs: string | null }>();

  const touch = (email: string, name: string, ts: string | null) => {
    const e = email.toLowerCase();
    const existing = seen.get(e);
    if (!existing) {
      seen.set(e, { name, lastTs: ts });
    } else {
      if (!existing.name && name) existing.name = name;
      if (ts && (!existing.lastTs || ts > existing.lastTs)) existing.lastTs = ts;
    }
  };

  for (const row of rows) {
    const ts = row.startTime || null;

    // Organizer
    if (row.organizerEmail) {
      touch(row.organizerEmail, row.organizerName || '', ts);
    }

    // Attendees
    if (row.attendees) {
      let attendees: Array<{ email?: string; name?: string; responseStatus?: string }> = [];
      try { attendees = JSON.parse(row.attendees); } catch { continue; }
      for (const a of attendees) {
        if (a.email) touch(a.email, a.name || '', ts);
      }
    }
  }

  const ownEmail = accountId?.toLowerCase();

  for (const [email, { name, lastTs }] of seen) {
    if (ownEmail && email === ownEmail) continue;
    upsertContact({
      source: 'calendar',
      platformId: email,
      accountId,
      displayName: name || email,
      username: email,
      hasDm: true,
      lastMessageAt: lastTs ?? undefined,
      lastSeenAt: lastTs ?? undefined,
    });
    count++;
  }

  return count;
}

// ─── Rebuild contacts from local messages (no API calls) ─────────────────────

/**
 * Scans existing message tables and upserts contacts for the given sources.
 * Pure local operation — no platform API calls.
 * Returns the number of contacts upserted.
 */
export function rebuildContactsFromMessages(
  sources: string[] = ['slack', 'discord', 'telegram', 'twitter'],
): number {
  const db = getDb();
  let total = 0;

  for (const src of sources) {
    const criteria = getContactCriteria(src);
    if (!criteria.enabled) continue;

    const myAccounts = db.select({ accountId: accounts.accountId })
      .from(accounts).where(eq(accounts.source, src)).all();
    const myIds = new Set(myAccounts.map((a) => a.accountId).filter(Boolean) as string[]);

    if (src === 'slack') {
      const rows = db.selectDistinct({
        userId: slackMessages.userId,
        userName: slackMessages.userName,
        channelId: slackMessages.channelId,
      }).from(slackMessages).all();

      for (const row of rows) {
        if (!row.userId || myIds.has(row.userId)) continue;
        const isDm = row.channelId.startsWith('D') || row.channelId.startsWith('G');
        if (!isDm && !criteria.smallGroup) continue;
        upsertContact({
          source: 'slack',
          platformId: row.userId,
          displayName: row.userName || row.userId || undefined,
          username: row.userName ?? undefined,
          hasDm: isDm && criteria.hasDm,
          isFromSmallGroup: !isDm && criteria.smallGroup,
        });
        total++;
      }
    }

    if (src === 'discord') {
      if (criteria.hasDm) {
        const dmAuthors = db.selectDistinct({
          authorId: discordMessages.authorId,
          authorName: discordMessages.authorName,
          channelId: discordMessages.channelId,
        }).from(discordMessages).where(isNull(discordMessages.guildId)).all();

        for (const row of dmAuthors) {
          if (!row.authorId || myIds.has(row.authorId)) continue;
          const defaultIndex = Number(BigInt(row.authorId) >> 22n) % 6;
          upsertContact({
            source: 'discord',
            platformId: row.authorId,
            displayName: row.authorName || row.authorId || undefined,
            username: row.authorName ?? undefined,
            avatarUrl: `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`,
            hasDm: true,
          });
          total++;
        }
      }

      if (criteria.ownedGroup || criteria.smallGroup) {
        const guildAuthors = db.selectDistinct({
          authorId: discordMessages.authorId,
          authorName: discordMessages.authorName,
          guildId: discordMessages.guildId,
        }).from(discordMessages).all();

        for (const row of guildAuthors) {
          if (!row.authorId || !row.guildId || myIds.has(row.authorId)) continue;
          upsertContact({
            source: 'discord',
            platformId: row.authorId,
            displayName: row.authorName || row.authorId || undefined,
            username: row.authorName ?? undefined,
            isFromSmallGroup: criteria.smallGroup,
            workspaceIds: [row.guildId],
          });
          total++;
        }
      }
    }

    if (src === 'telegram') {
      if (criteria.hasDm) {
        const tgRows = db.selectDistinct({
          senderId: telegramMessages.senderId,
          senderName: telegramMessages.senderName,
          chatId: telegramMessages.chatId,
          chatType: telegramMessages.chatType,
        }).from(telegramMessages).all();

        for (const row of tgRows) {
          if (!row.senderId || myIds.has(String(row.senderId))) continue;
          const type = row.chatType?.toLowerCase() || '';
          const isDm = type === 'private' || type === 'user' ||
            (!type && row.chatId > 0 && row.chatId < 1_000_000_000_000);
          const isGroup = type === 'group' || type === 'supergroup' ||
            (!type && row.chatId < 0);
          if (!isDm && !isGroup) continue;
          upsertContact({
            source: 'telegram',
            platformId: String(row.senderId),
            displayName: row.senderName || String(row.senderId) || undefined,
            hasDm: isDm && criteria.hasDm,
            isFromSmallGroup: isGroup && criteria.smallGroup,
          });
          total++;
        }
      }
    }

    if (src === 'twitter') {
      if (criteria.hasDm) {
        const twRows = db.selectDistinct({
          senderId: twitterDms.senderId,
          senderHandle: twitterDms.senderHandle,
          senderName: twitterDms.senderName,
        }).from(twitterDms).all();

        for (const row of twRows) {
          if (!row.senderId || myIds.has(row.senderId)) continue;
          upsertContact({
            source: 'twitter',
            platformId: row.senderId,
            displayName: row.senderName || row.senderHandle || row.senderId || undefined,
            username: row.senderHandle ?? undefined,
            hasDm: true,
          });
          total++;
        }
      }
    }
  }

  return total;
}

/**
 * Checks which of the given sources have messages but no contacts,
 * and runs rebuildContactsFromMessages for those sources.
 * Safe to call on every startup — no-ops if contacts already exist.
 */
export function bootstrapContactsIfEmpty(
  sources: string[] = ['slack', 'discord', 'telegram', 'twitter'],
): void {
  const db = getDb();

  const sourcesToRebuild: string[] = [];
  for (const src of sources) {
    const contactCount = db.select({ n: sql<number>`count(*)` })
      .from(contacts).where(eq(contacts.source, src)).get()?.n ?? 0;
    if (contactCount > 0) continue;

    // Check if there are any messages for this source
    let hasMessages = false;
    if (src === 'slack') {
      hasMessages = (db.select({ n: sql<number>`count(*)` }).from(slackMessages).get()?.n ?? 0) > 0;
    } else if (src === 'discord') {
      hasMessages = (db.select({ n: sql<number>`count(*)` }).from(discordMessages).get()?.n ?? 0) > 0;
    } else if (src === 'telegram') {
      hasMessages = (db.select({ n: sql<number>`count(*)` }).from(telegramMessages).get()?.n ?? 0) > 0;
    } else if (src === 'twitter') {
      hasMessages = (db.select({ n: sql<number>`count(*)` }).from(twitterDms).get()?.n ?? 0) > 0;
    }

    if (hasMessages) sourcesToRebuild.push(src);
  }

  if (sourcesToRebuild.length === 0) return;

  console.log(`[contacts] Bootstrapping contacts from messages for: ${sourcesToRebuild.join(', ')}`);
  const n = rebuildContactsFromMessages(sourcesToRebuild);
  console.log(`[contacts] Bootstrap complete: ${n} contacts upserted`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
