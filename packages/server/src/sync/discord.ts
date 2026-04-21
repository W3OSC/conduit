// @ts-ignore — discord.js-selfbot-v13 types
import DiscordJS from 'discord.js-selfbot-v13';
const { Client } = DiscordJS as unknown as { Client: new (opts?: Record<string, unknown>) => DiscordClient };

import { getDb } from '../db/client.js';
import { discordMessages, syncState, syncRuns, accounts, settings } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { broadcast } from '../websocket/hub.js';
import {
  syncDiscordContacts, upsertContact, upsertContactFromMessage, getContactCriteria,
} from './contacts.js';
import { buildMutedChannelsMap, type GuildMuteSettings } from './discord-mute.js';
import { persistMuteState, seedReadState, broadcastUnreadForChat, computeAllUnreads } from './unread.js';
import { broadcastUnread } from '../websocket/hub.js';

// Minimal Discord client interface we need
interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; tag: string; username: string; bot?: boolean } | null;
  channel: { id: string; name?: string; type: number; send?: (text: string) => Promise<void> } | null;
  guild: { id: string; name: string } | null;
  createdAt: Date;
}

interface DiscordChannel {
  id: string;
  name?: string;
  type: number;
  messages: { fetch: (opts: Record<string, unknown>) => Promise<Map<string, DiscordMessage>> };
  send: (text: string) => Promise<void>;
  recipient?: { tag?: string; username?: string };
}

interface DiscordGuild {
  id: string;
  name: string;
  icon?: string | null;
  channels: { cache: Map<string, DiscordChannel> };
}

export interface GuildInfo {
  id: string;
  name: string;
  icon: string | null;
  channels: Array<{ id: string; name: string; type: number }>;
}

interface DiscordClient {
  user: { id: string; tag: string; username: string; avatar?: string } | null;
  guilds: { cache: Map<string, DiscordGuild> };
  channels: { cache: Map<string, DiscordChannel> };
  users: { fetch: (id: string) => Promise<{ createDM: () => Promise<DiscordChannel> }> };
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  login: (token: string) => Promise<void>;
  destroy: () => void;
}

export interface DiscordConfig {
  token: string;
}

export class DiscordSync {
  private client: DiscordClient;
  private config: DiscordConfig;
  private _cancelRequested = false;
  public connected = false;
  public accountInfo: { userId: string; displayName: string } | null = null;

  cancelSync(): void {
    this._cancelRequested = true;
    // Immediately mark any running sync as cancelled in the DB so the UI
    // reflects it even if the loop hasn't checked the flag yet
    try {
      const db = getDb();
      db.update(syncRuns)
        .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
        .where(and(eq(syncRuns.source, 'discord'), eq(syncRuns.status, 'running')))
        .run();
      broadcast({ type: 'sync:progress', data: { service: 'discord', status: 'idle' } });
    } catch { /* ignore */ }
  }

  constructor(config: DiscordConfig) {
    this.config = config;
    // discord.js-selfbot-v13 does not use Intents — it handles all events
    // automatically as a user account client.
    this.client = new Client({ checkUpdate: false });
  }

  async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      this.client.once('ready', async () => {
        const user = this.client.user;
        if (user) {
          this.accountInfo = { userId: user.id, displayName: user.tag || user.username };
          const db = getDb();
          const existing = db.select().from(accounts)
            .where(and(eq(accounts.source, 'discord'), eq(accounts.accountId, user.id)))
            .get();
          if (!existing) {
            db.insert(accounts).values({
              source: 'discord',
              accountId: user.id,
              displayName: user.tag || user.username,
              lastSync: new Date().toISOString(),
            }).run();
          } else {
            db.update(accounts).set({ lastSync: new Date().toISOString() })
              .where(eq(accounts.id, existing.id)).run();
          }

          // Upsert own user into contacts so our avatar shows in chat
          const avatarUrl = user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar.startsWith('a_') ? user.avatar + '.gif' : user.avatar + '.png'}?size=128`
            : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
          upsertContact({
            source: 'discord',
            platformId: user.id,
            accountId: user.id,
            displayName: user.tag || user.username,
            avatarUrl,
          });
        }
        this.connected = true;
        broadcast({ type: 'connection:status', data: { service: 'discord', status: 'connected', mode: 'gateway' } });
        console.log('[discord] Gateway connected as', this.client.user?.tag);

        this.client.on('messageCreate', (...args: unknown[]) => {
          const msg = args[0] as DiscordMessage;
          this.handleNewMessage(msg);
        });

        // Re-compute and persist mute state whenever the user changes their
        // guild notification/mute settings in the Discord client.
        this.client.on('userGuildSettingsUpdate', () => {
          this.fetchUnreadCounts().catch((e) =>
            console.error('[discord] fetchUnreadCounts after settings update failed:', e),
          );
        });

        resolve(true);
      });

      this.client.on('error', (...args: unknown[]) => {
        const err = args[0] as Error;
        console.error('[discord] Client error:', err?.message);
        this.connected = false;
        broadcast({ type: 'connection:status', data: { service: 'discord', status: 'error', error: err?.message } });
      });

      this.client.on('disconnect', () => {
        this.connected = false;
        broadcast({ type: 'connection:status', data: { service: 'discord', status: 'disconnected' } });
      });

      this.client.login(this.config.token).catch((e: Error) => {
        console.error('[discord] Login failed:', e.message);
        resolve(false);
      });
    });
  }

  private handleNewMessage(msg: DiscordMessage): void {
    if (msg.author?.bot) return;
    // If the message is from a guild, check the allowlist
    if (msg.guild) {
      const allowed = this.getAllowedGuildIds();
      if (allowed && !allowed.has(msg.guild.id)) return;
    }

    const messageId = msg.id;
    const channelId = msg.channel?.id || '';
    const channelName = (msg.channel as { name?: string })?.name || 'DM';
    const guildId = msg.guild?.id;
    const guildName = msg.guild?.name;
    const authorId = msg.author?.id;
    const authorName = msg.author?.tag || msg.author?.username || 'Unknown';
    const content = msg.content || '';
    const timestamp = msg.createdAt?.toISOString?.() || new Date().toISOString();

    // Extract attachments from live message
    type LiveMsg = { attachments?: Map<string, { url?: string; proxyURL?: string; filename?: string; contentType?: string; width?: number | null; height?: number | null }> | undefined; embeds?: Array<{ image?: { url?: string; proxyURL?: string }; thumbnail?: { url?: string; proxyURL?: string } }> | undefined };
    const liveMsg = msg as unknown as LiveMsg;
    const liveAttachments = [...(liveMsg.attachments?.values() || [])].map((a) => ({
      url: a.url || '', proxyURL: a.proxyURL || a.url || '',
      filename: a.filename || '', contentType: a.contentType || '',
      width: a.width ?? null, height: a.height ?? null,
    }));
    const liveEmbedImages = (liveMsg.embeds || []).map((e) => e.image || e.thumbnail).filter(Boolean)
      .map((img) => ({ url: img!.url || '', proxyURL: img!.proxyURL || img!.url || '' }));
    const attachmentsJson = liveAttachments.length || liveEmbedImages.length
      ? JSON.stringify({ files: liveAttachments, embedImages: liveEmbedImages }) : null;

    const db = getDb();
    const result = db.insert(discordMessages).values({
      messageId,
      channelId,
      channelName,
      guildId: guildId || null,
      guildName: guildName || null,
      authorId: authorId || null,
      authorName,
      content,
      attachments: attachmentsJson,
      timestamp,
      rawJson: JSON.stringify({ id: messageId, content, authorId, authorName }),
    }).onConflictDoNothing().run();

    // Broadcast the message for real-time display in open conversations
    broadcast({
      type: 'message:new',
      data: { source: 'discord', messageId, channelId, channelName, guildId, guildName, authorId, authorName, content, timestamp, attachments: attachmentsJson },
    });

    // Push updated unread count for this chat to all clients.
    // broadcastUnreadForChat reads chat_read_state and chat_mute_state from the DB
    // and computes the real count — no client-side increment needed.
    broadcastUnreadForChat('discord', channelId);

    if (result.changes > 0) {
      if (authorId && authorId !== this.accountInfo?.userId) {
        const isDm = !guildId;
        upsertContactFromMessage({
          source: 'discord',
          platformId: authorId,
          accountId: this.accountInfo?.userId,
          displayName: authorName,
          isDm,
          isSmallGroup: false,
          isOwnedGroup: false,
          timestamp,
        });
      }
    }
  }

  async initialFullSync(onProgress?: (service: string, chat: string, saved: number) => void): Promise<void> {
    const db = getDb();
    this._cancelRequested = false;
    const runId = db.insert(syncRuns).values({
      source: 'discord',
      syncType: 'full',
      status: 'running',
      startedAt: new Date().toISOString(),
    }).run().lastInsertRowid as number;

    broadcast({ type: 'sync:progress', data: { service: 'discord', status: 'running', type: 'full' } });

    try {
      let totalSaved = 0;
      let totalChats = 0;
      const allowedGuilds = this.getAllowedGuildIds();

      const updateProgress = () => {
        db.update(syncRuns)
          .set({ messagesSaved: totalSaved, chatsVisited: totalChats })
          .where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'discord', status: 'running', type: 'full', messagesSaved: totalSaved, chatsVisited: totalChats } });
      };

      // Sync guild channels.
      // If an allowlist is configured, only sync those guilds.
      // If no allowlist is set (null), sync ALL guilds the user is in.
      for (const [, guild] of this.client.guilds.cache) {
        if (this._cancelRequested) break;
        if (allowedGuilds && !allowedGuilds.has(guild.id)) continue;
        for (const [, channel] of guild.channels.cache) {
          if (this._cancelRequested) break;
          if (channel.type !== 0) continue; // GUILD_TEXT only
          totalChats++;
          const state = db.select().from(syncState)
            .where(and(eq(syncState.source, 'discord'), eq(syncState.chatId, channel.id)))
            .get();
          const saved = await this.fetchChannelHistory(channel, guild.id, guild.name, state?.lastMessageTs || undefined);
          totalSaved += saved;
          onProgress?.('discord', channel.name || channel.id, saved);
          updateProgress();
          await sleep(500);
        }
      }

      // Sync DMs — fetch via API to get all DM channels, not just cached ones
      if (!this._cancelRequested) {
        type RawDMChannel = { id: string; type: number; recipients?: Array<{ tag?: string; username?: string }> };
        let dmChannels: RawDMChannel[] = [];
        try {
          const raw = this.client as unknown as {
            api: { users: { '@me': { channels: { get: () => Promise<RawDMChannel[]> } } } };
          };
          const all = await raw.api.users['@me'].channels.get();
          dmChannels = all.filter((c) => c.type === 1);
        } catch {
          // Fall back to cache
          dmChannels = [...this.client.channels.cache.values()]
            .filter((c) => c.type === 1)
            .map((c) => ({ id: c.id, type: 1, recipients: c.recipient ? [c.recipient] : [] }));
        }

        for (const dmData of dmChannels) {
          if (this._cancelRequested) break;
          totalChats++;
          const channelName = dmData.recipients?.[0]?.tag || dmData.recipients?.[0]?.username || dmData.id;

          // Fetch the full channel object for history fetching
          let channel: DiscordChannel | undefined = this.client.channels.cache.get(dmData.id);
          if (!channel) {
            try {
              const raw = this.client as unknown as {
                channels: { fetch: (id: string) => Promise<DiscordChannel> };
              };
              channel = await raw.channels.fetch(dmData.id);
            } catch { continue; }
          }
          if (!channel) continue;

          const state = db.select().from(syncState)
            .where(and(eq(syncState.source, 'discord'), eq(syncState.chatId, dmData.id)))
            .get();
          const saved = await this.fetchChannelHistory(channel, undefined, undefined, state?.lastMessageTs || undefined);
          totalSaved += saved;
          onProgress?.('discord', channelName, saved);
          updateProgress();
          await sleep(300);
        }
      }

      if (this._cancelRequested) {
        db.update(syncRuns).set({ status: 'cancelled', finishedAt: new Date().toISOString(), messagesSaved: totalSaved })
          .where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'discord', status: 'idle' } });
        console.log('[discord] Sync cancelled');
      } else {
        db.update(syncRuns).set({ status: 'success', messagesSaved: totalSaved, chatsVisited: totalChats, finishedAt: new Date().toISOString() })
          .where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'discord', status: 'success', messagesSaved: totalSaved } });
        // Contact sync
        try {
          const criteria = getContactCriteria('discord');
          if (criteria.enabled && this.accountInfo) {
            const contactCount = await syncDiscordContacts(
              this.client as unknown as Parameters<typeof syncDiscordContacts>[0],
              this.accountInfo.userId,
              criteria,
              allowedGuilds,
            );
            console.log(`[discord] Contact sync complete: ${contactCount} contacts`);
          }
        } catch (ce) {
          console.error('[discord] Contact sync error:', ce);
        }
        // Broadcast unread counts with mute state
        await this.fetchUnreadCounts();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.update(syncRuns).set({ status: 'error', errorMessage: msg, finishedAt: new Date().toISOString() })
        .where(eq(syncRuns.id, runId)).run();
      broadcast({ type: 'sync:progress', data: { service: 'discord', status: 'error', error: msg } });
    }
  }

  /**
   * Compute mute state from live guild.settings, persist to chat_mute_state,
   * then broadcast authoritative unread counts (computed from DB message counts
   * vs chat_read_state) to all connected clients.
   *
   * Called after: initial sync, userGuildSettingsUpdate event.
   */
  async fetchUnreadCounts(): Promise<void> {
    try {
      const db = getDb();

      // Build channelId → isMuted map from live guild settings
      const guildsIterable = this.client.guilds.cache as unknown as Map<
        string,
        { channels: { cache: Map<string, { id: string; type: number }> }; settings?: GuildMuteSettings }
      >;
      const mutedChannels = buildMutedChannelsMap(guildsIterable);

      // Persist mute state to chat_mute_state for all guild text channels
      persistMuteState(
        [...mutedChannels.entries()].map(([chatId, isMuted]) => ({ source: 'discord', chatId, isMuted })),
      );

      // Seed read state: Discord's selfbot API does not expose a reliable
      // per-channel read cursor, so we treat the sync as a fresh start —
      // all known Discord channels are seeded as "read now". Only messages
      // that arrive as live events after this point will count as unread.
      // We collect channel IDs from both the mute map (guild channels) and
      // the messages table (DMs and any channels not in a guild cache).
      const now = new Date().toISOString();
      const channelIds = new Set<string>(mutedChannels.keys());
      const dmChats = db.selectDistinct({ channelId: discordMessages.channelId })
        .from(discordMessages).all();
      for (const { channelId } of dmChats) channelIds.add(channelId);

      seedReadState([...channelIds].map((chatId) => ({ source: 'discord', chatId, lastReadAt: now })));

      // Broadcast authoritative counts for all chats (all services)
      const updates = computeAllUnreads();
      if (updates.length > 0) broadcastUnread(updates);
    } catch (e) {
      console.error('[discord] fetchUnreadCounts error:', e);
    }
  }

  /**
   * Mark a Discord channel as read by acknowledging the latest message.
   * Uses the raw Discord API to send a MessageAck.
   * Only called when markReadEnabled permission is true.
   */
  async markChannelRead(channelId: string): Promise<void> {
    try {
      const raw = this.client as unknown as {
        api: {
          channels: {
            [id: string]: {
              messages: {
                [mid: string]: {
                  ack: { post: (opts: { data: Record<string, unknown> }) => Promise<void> };
                };
              };
            };
          };
        };
      };
      // Fetch the latest message ID
      const channel = this.client.channels.cache.get(channelId);
      if (!channel) return;
      const msgs = await channel.messages.fetch({ limit: 1 });
      const latest = [...msgs.values()][0];
      if (!latest?.id) return;
      // POST channels/{id}/messages/{msgId}/ack
      await raw.api.channels[channelId].messages[latest.id].ack.post({ data: {} });
    } catch { /* best-effort — Discord may not allow ACK via selfbot API */ }
  }

  private async fetchChannelHistory(
    channel: DiscordChannel,
    guildId: string | undefined,
    guildName: string | undefined,
    _before?: string,
  ): Promise<number> {
    const db = getDb();
    let saved = 0;
    let lastId: string | undefined;

    while (true) {
      // Check cancel flag at the top of every page fetch
      if (this._cancelRequested) break;

      const options: Record<string, unknown> = { limit: 100 };
      if (lastId) options.before = lastId;

      let messages: Map<string, DiscordMessage>;
      try {
        messages = await channel.messages.fetch(options);
      } catch { break; }

      if (!messages || messages.size === 0) break;

      for (const [id, msg] of messages) {
        if (this._cancelRequested) break;
        if (msg.author?.bot) continue;
        const authorId = msg.author?.id;
        const authorName = msg.author?.tag || msg.author?.username || 'Unknown';
        const content = msg.content || '';
        const timestamp = msg.createdAt?.toISOString?.() || new Date().toISOString();
        const channelName = (channel as { name?: string }).name || 'DM';

        // Extract attachments (images, files) and embeds
        type RawMsg = { attachments?: Map<string, { url?: string; proxyURL?: string; filename?: string; contentType?: string; width?: number | null; height?: number | null; size?: number }> | undefined; embeds?: Array<{ url?: string; image?: { url?: string; proxyURL?: string; width?: number; height?: number }; thumbnail?: { url?: string; proxyURL?: string } }> | undefined };
        const rawMsg = msg as unknown as RawMsg;

        const attachmentList = [...(rawMsg.attachments?.values() || [])].map((a) => ({
          url: a.url || '',
          proxyURL: a.proxyURL || a.url || '',
          filename: a.filename || '',
          contentType: a.contentType || '',
          width: a.width ?? null,
          height: a.height ?? null,
        }));

        const embedImages = (rawMsg.embeds || [])
          .map((e) => e.image || e.thumbnail)
          .filter(Boolean)
          .map((img) => ({ url: img!.url || '', proxyURL: img!.proxyURL || img!.url || '' }));

        const attachmentsJson = attachmentList.length || embedImages.length
          ? JSON.stringify({ files: attachmentList, embedImages })
          : null;

        const result = db.insert(discordMessages).values({
          messageId: id,
          channelId: channel.id,
          channelName,
          guildId: guildId || null,
          guildName: guildName || null,
          authorId: authorId || null,
          authorName,
          content,
          attachments: attachmentsJson,
          timestamp,
          rawJson: JSON.stringify({ id, content, authorId, authorName }),
        }).onConflictDoNothing().run();
        if (result.changes > 0) saved++;

        // Upsert contact for every message author — ensures DM participants are
        // always contacts even if they haven't sent a live message yet
        if (authorId && authorId !== this.accountInfo?.userId) {
          const isDm = !guildId;
          upsertContactFromMessage({
            source: 'discord',
            platformId: authorId,
            accountId: this.accountInfo?.userId,
            displayName: authorName,
            isDm,
            isSmallGroup: false,
            isOwnedGroup: false,
            timestamp,
          });
        }

        lastId = id;
      }

      if (this._cancelRequested) break;
      if (messages.size < 100) break;
      await sleep(500);
    }

    db.insert(syncState).values({
      source: 'discord',
      accountId: this.accountInfo?.userId,
      chatId: channel.id,
      chatName: (channel as { name?: string }).name || 'DM',
      lastMessageTs: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
      isFullSync: true,
      messageCount: saved,
    }).onConflictDoUpdate({
      target: [syncState.source, syncState.chatId, syncState.accountId],
      set: { lastFetchedAt: new Date().toISOString(), messageCount: saved },
    }).run();

    return saved;
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);
    await channel.send(text);
  }

  async getLatestDM(): Promise<{ channelName: string; content: string; timestamp: string } | null> {
    // Fetch all private channels from the API (not just cache) so we see
    // DMs even if they haven't been opened in this session
    try {
      const raw = this.client as unknown as {
        api: { users: { '@me': { channels: { get: () => Promise<Array<{ id: string; type: number; recipients?: Array<{ username?: string; tag?: string }> }>> } } } };
      };
      const channels: Array<{ id: string; type: number; recipients?: Array<{ username?: string; tag?: string }> }> = await raw.api.users['@me'].channels.get();
      for (const ch of channels) {
        if (ch.type !== 1) continue; // DM only
        const channelName = ch.recipients?.[0]?.tag || ch.recipients?.[0]?.username || 'DM';
        try {
          const msgs = await (this.client.channels.cache.get(ch.id) || await (this.client as unknown as { channels: { fetch: (id: string) => Promise<DiscordChannel> } }).channels.fetch(ch.id)).messages.fetch({ limit: 1 });
          if (msgs.size > 0) {
            const msg = [...msgs.values()][0];
            return { channelName, content: msg.content || '', timestamp: msg.createdAt?.toISOString?.() || '' };
          }
        } catch { /* skip this channel */ }
      }
    } catch {
      // Fallback: check cache
      for (const [, channel] of this.client.channels.cache) {
        if (channel.type !== 1) continue;
        const channelName = channel.recipient?.tag || channel.recipient?.username || 'DM';
        try {
          const msgs = await channel.messages.fetch({ limit: 1 });
          if (msgs.size > 0) {
            const msg = [...msgs.values()][0];
            return { channelName, content: msg.content || '', timestamp: msg.createdAt?.toISOString?.() || '' };
          }
        } catch { /* skip */ }
      }
    }
    return null;
  }

  async getLatestChannelMessage(): Promise<{ channelName: string; content: string; timestamp: string } | null> {
    for (const [, guild] of this.client.guilds.cache) {
      for (const [, channel] of guild.channels.cache) {
        if (channel.type !== 0) continue;
        try {
          const msgs = await channel.messages.fetch({ limit: 1 });
          if (msgs.size > 0) {
            const msg = [...msgs.values()][0];
            return { channelName: channel.name || 'channel', content: msg.content || '', timestamp: msg.createdAt?.toISOString?.() || '' };
          }
        } catch { /* no permission or empty — try next channel */ }
      }
    }
    // Guilds may not be in cache if GUILDS intent isn't populated yet
    return this.client.guilds.cache.size > 0 ? null : null;
  }

  /** Returns all guilds the bot can see, with their text channels. */
  getGuilds(): GuildInfo[] {
    return [...this.client.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon ?? null,
      channels: [...g.channels.cache.values()]
        .filter((c) => c.type === 0) // GUILD_TEXT
        .map((c) => ({ id: c.id, name: c.name || c.id, type: c.type }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }

  /** Read the guild allowlist from the settings table. Null = no allowlist (sync all). */
  private getAllowedGuildIds(): Set<string> | null {
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.key, 'discord.syncGuilds')).get();
    if (!row) return null;
    try {
      const ids = JSON.parse(row.value) as string[];
      if (!Array.isArray(ids) || ids.length === 0) return null;
      return new Set(ids);
    } catch { return null; }
  }

  async sendSelf(text: string): Promise<boolean> {
    if (!this.accountInfo) return false;
    try {
      const user = await this.client.users.fetch(this.accountInfo.userId);
      const dm = await user.createDM();
      await dm.send(text);
      return true;
    } catch { return false; }
  }

  /**
   * Sends a DM to self, then fetches the channel history to confirm the
   * message is visible. Returns the channel ID + message ID on success.
   * Test-runner only — bypasses outbox.
   *
   * Note: discord.js-selfbot-v13 does NOT fire messageCreate for messages
   * you send yourself, so we verify by reading channel history instead.
   */
  /**
   * Creates a temporary group DM with only the authenticated user,
   * sends a test message, returns the IDs for verification and cleanup.
   *
   * This calls the raw Discord API directly to bypass the client-side
   * friends-only filter in createGroupDM(). A group DM with just yourself
   * is the only way to test send/delete without messaging another person.
   *
   * Test-runner only — bypasses outbox.
   */
  async sendTestMessageToDM(text: string): Promise<{ channelId: string; messageId: string; channelName: string }> {
    if (!this.accountInfo) throw new Error('Not connected — no account info');

    const raw = this.client as unknown as {
      api: {
        users: {
          '@me': {
            channels: {
              post: (opts: { data: Record<string, unknown> }) => Promise<{ id: string }>;
            };
          };
        };
        channels: {
          [id: string]: {
            messages: {
              post: (opts: { data: Record<string, unknown> }) => Promise<{ id: string; content: string }>;
            };
            delete: () => Promise<void>;
          };
        };
      };
    };

    // Create a group DM with only our own user ID by calling the raw API
    // directly — this bypasses the friends-only client-side check.
    const groupDM = await raw.api.users['@me'].channels.post({
      data: { recipients: [this.accountInfo.userId] },
    });
    if (!groupDM?.id) throw new Error('Failed to create temporary group DM');

    const channelId = groupDM.id;

    try {
      // Send the test message
      const msg = await raw.api.channels[channelId].messages.post({
        data: { content: text },
      });
      if (!msg?.id) throw new Error('Failed to send test message');

      return { channelId, messageId: msg.id, channelName: 'group-dm (self)' };
    } catch (e) {
      // Clean up the channel even if send fails
      try { await raw.api.channels[channelId].delete(); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * Deletes the temporary group DM channel created during testing.
   * Called after the test message is verified and deleted.
   */
  async deleteTestGroupDM(channelId: string): Promise<void> {
    try {
      const raw = this.client as unknown as {
        api: { channels: { [id: string]: { delete: () => Promise<void> } } };
      };
      await raw.api.channels[channelId].delete();
    } catch { /* ignore — channel may already be gone */ }
  }

  /**
   * Verifies a sent message exists in the channel history and deletes it.
   * Safety-checked: confirms content contains the expected token and that
   * only this one specific message is deleted.
   * Test-runner only.
   */
  async deleteSelfMessage(channelId: string, messageId: string, expectedToken: string): Promise<boolean> {
    try {
      const raw = this.client as unknown as {
        channels: {
          fetch: (id: string) => Promise<{
            type: number;
            messages: {
              fetch: (opts: Record<string, unknown>) => Promise<Map<string, { id: string; content: string; author: { id: string }; delete: () => Promise<void> }>>;
            };
          } | null>;
        };
      };
      const channel = await raw.channels.fetch(channelId);
      if (!channel || channel.type !== 1) return false; // DM only
      // Fetch a small window around the message to locate it by ID
      const msgs = await channel.messages.fetch({ limit: 10, around: messageId });
      const msg = msgs.get(messageId);
      if (!msg) return false;
      if (!msg.content?.includes(expectedToken)) return false;
      if (this.accountInfo && msg.author?.id !== this.accountInfo.userId) return false;
      await msg.delete();
      return true;
    } catch { return false; }
  }

  /**
   * Verifies a message with the given ID + token exists in a DM channel.
   * Used by the test runner to confirm the send succeeded before deleting.
   */
  async verifyMessageInHistory(channelId: string, messageId: string, expectedToken: string): Promise<boolean> {
    try {
      const raw = this.client as unknown as {
        channels: {
          fetch: (id: string) => Promise<{
            type: number;
            messages: {
              fetch: (opts: Record<string, unknown>) => Promise<Map<string, { id: string; content: string; author: { id: string } }>>;
            };
          } | null>;
        };
      };
      const channel = await raw.channels.fetch(channelId);
      if (!channel || channel.type !== 1) return false;
      const msgs = await channel.messages.fetch({ limit: 10, around: messageId });
      const msg = msgs.get(messageId);
      return !!(msg && msg.content?.includes(expectedToken));
    } catch { return false; }
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
    this.connected = false;
    broadcast({ type: 'connection:status', data: { service: 'discord', status: 'disconnected' } });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
