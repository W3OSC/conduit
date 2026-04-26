import { WebClient } from '@slack/web-api';
import { SocketModeClient, LogLevel } from '@slack/socket-mode';
import { getDb } from '../db/client.js';
import { slackMessages, syncState, syncRuns, errorLog, accounts } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { broadcast, broadcastUnread } from '../websocket/hub.js';
import {
  syncSlackContacts, upsertContactFromMessage, getContactCriteria,
} from './contacts.js';
import { persistMuteState, seedReadState, broadcastUnreadForChat, markChatRead, computeAllUnreads } from './unread.js';

export interface SlackConfig {
  token: string;           // xoxp- user token
  appToken?: string;       // xapp- app-level token for Socket Mode
}

interface SlackChannelInfo {
  id: string;
  name: string;
  type: 'im' | 'mpim' | 'public_channel' | 'private_channel';
  isMember?: boolean;
}

export class SlackSync {
  private client: WebClient;
  private socketClient: SocketModeClient | null = null;
  private config: SlackConfig;
  private userCache = new Map<string, string>();
  private channelCache = new Map<string, string>();
  private syncRunId: number | null = null;
  private _cancelRequested = false;
  public connected = false;
  public accountInfo: { userId: string; displayName: string } | null = null;

  cancelSync(): void {
    this._cancelRequested = true;
    try {
      const db = getDb();
      db.update(syncRuns)
        .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
        .where(and(eq(syncRuns.source, 'slack'), eq(syncRuns.status, 'running')))
        .run();
      broadcast({ type: 'sync:progress', data: { service: 'slack', status: 'idle' } });
    } catch { /* ignore */ }
  }

  constructor(config: SlackConfig) {
    this.config = config;
    this.client = new WebClient(config.token);
  }

  async authenticate(): Promise<boolean> {
    try {
      const auth = await this.client.auth.test();
      if (!auth.ok) return false;
      this.accountInfo = {
        userId: auth.user_id as string,
        displayName: (auth.user as string) || auth.user_id as string,
      };
      const db = getDb();
      const existing = db.select().from(accounts)
        .where(and(eq(accounts.source, 'slack'), eq(accounts.accountId, auth.user_id as string)))
        .get();
      if (!existing) {
        db.insert(accounts).values({
          source: 'slack',
          accountId: auth.user_id as string,
          displayName: auth.user as string,
          lastSync: new Date().toISOString(),
        }).run();
      } else {
        db.update(accounts).set({ lastSync: new Date().toISOString() })
          .where(eq(accounts.id, existing.id)).run();
      }
      return true;
    } catch (e) {
      console.error('[slack] Auth failed:', e);
      return false;
    }
  }

  async getChannels(): Promise<SlackChannelInfo[]> {
    const channels: SlackChannelInfo[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.client.conversations.list({
        cursor,
        types: 'public_channel,private_channel,mpim,im',
        limit: 200,
        exclude_archived: true,
      });
      for (const ch of (res.channels || [])) {
        let name = ch.name || ch.id || 'unknown';
        let type: SlackChannelInfo['type'] = 'public_channel';
        if (ch.is_im) {
          type = 'im';
          // Resolve DM username
          if (ch.user) name = await this.resolveUser(ch.user);
        } else if (ch.is_mpim) {
          type = 'mpim';
          // Resolve MPDM name to a list of participant usernames (excluding self).
          // Resolve all members in parallel to avoid sequential await per member.
          if (ch.id) {
            try {
              const membersRes = await this.client.conversations.members({ channel: ch.id });
              const memberIds = (membersRes.members || []) as string[];
              const myUserId = this.accountInfo?.userId;
              const otherIds = memberIds.filter((id) => !myUserId || id !== myUserId);
              const resolvedNames = await Promise.all(otherIds.map((id) => this.resolveUser(id)));
              if (resolvedNames.length > 0) name = resolvedNames.join(', ');
            } catch {
              // keep raw name on error
            }
          }
        } else if (ch.is_private) {
          type = 'private_channel';
        }
        if (ch.id) {
          channels.push({ id: ch.id, name, type, isMember: ch.is_member ?? (type === 'im' || type === 'mpim') });
          this.channelCache.set(ch.id, name);
        }
      }
      cursor = (res.response_metadata as { next_cursor?: string })?.next_cursor || undefined;
    } while (cursor);
    return channels;
  }

  async resolveUser(userId: string): Promise<string> {
    if (this.userCache.has(userId)) return this.userCache.get(userId)!;
    try {
      const info = await this.client.users.info({ user: userId });
      const name = (info.user as { real_name?: string; name?: string })?.real_name
        || (info.user as { name?: string })?.name
        || userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  async fetchChannelMessages(
    channelId: string,
    channelName: string,
    since?: string,
    onProgress?: (count: number) => void,
  ): Promise<number> {
    const db = getDb();
    let saved = 0;
    let cursor: string | undefined;

    do {
      if (this._cancelRequested) break;

      const res = await this.client.conversations.history({
        channel: channelId,
        limit: 200,
        ...(since ? { oldest: since } : {}),
        ...(cursor ? { cursor } : {}),
      } as Parameters<typeof this.client.conversations.history>[0]);
      if (!res.ok) break;

      for (const msg of (res.messages || [])) {
        if (msg.type !== 'message' || msg.subtype) continue;
        const ts = msg.ts || '';
        const userId = msg.user || msg.bot_id || '';
        const userName = userId ? await this.resolveUser(userId) : 'Unknown';
        const timestamp = ts
          ? new Date(parseFloat(ts) * 1000).toISOString()
          : new Date().toISOString();

        // Combine Slack attachments (rich previews) and files (uploaded images/files)
        type SlackMsg = { attachments?: unknown[]; files?: Array<{ url_private?: string; permalink?: string; thumb_480?: string; thumb_360?: string; name?: string; mimetype?: string; filetype?: string; original_w?: number; original_h?: number }> };
        const slackMsg = msg as SlackMsg;
        const slackFiles = (slackMsg.files || []).map((f) => ({
          url: f.url_private || f.permalink || '',
          proxyURL: f.thumb_480 || f.thumb_360 || f.url_private || '',
          filename: f.name || '',
          contentType: f.mimetype || '',
          filetype: f.filetype || '',
          width: f.original_w ?? null,
          height: f.original_h ?? null,
        }));
        const combinedAttachments = slackFiles.length
          ? JSON.stringify({ files: slackFiles, richAttachments: slackMsg.attachments || [] })
          : (slackMsg.attachments ? JSON.stringify({ files: [], richAttachments: slackMsg.attachments }) : null);

        const result = db.insert(slackMessages).values({
          messageId: ts,
          channelId,
          channelName,
          userId,
          userName,
          content: msg.text || '',
          attachments: combinedAttachments,
          threadTs: msg.thread_ts || null,
          timestamp,
          rawJson: JSON.stringify(msg),
        }).onConflictDoNothing().run();
        if (result.changes > 0) saved++;

        // Progress is updated per-channel in initialFullSync, not per-message
      }

      onProgress?.(saved);
      cursor = (res.response_metadata as { next_cursor?: string })?.next_cursor || undefined;

      // Rate limit: short sleep between pages
      await sleep(500);
    } while (cursor);

    // Update sync state
    db.insert(syncState).values({
      source: 'slack',
      accountId: this.accountInfo?.userId,
      chatId: channelId,
      chatName: channelName,
      lastMessageTs: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
      isFullSync: true,
      messageCount: saved,
    }).onConflictDoUpdate({
      target: [syncState.source, syncState.chatId, syncState.accountId],
      set: {
        lastFetchedAt: new Date().toISOString(),
        messageCount: saved,
      },
    }).run();

    return saved;
  }

  async initialFullSync(onProgress?: (service: string, chat: string, saved: number) => void): Promise<void> {
    const db = getDb();
    this._cancelRequested = false;
    const runId = db.insert(syncRuns).values({
      source: 'slack',
      syncType: 'full',
      status: 'running',
      startedAt: new Date().toISOString(),
    }).run().lastInsertRowid as number;
    this.syncRunId = runId;

    broadcast({ type: 'sync:progress', data: { service: 'slack', status: 'running', type: 'full' } });

    try {
      const channels = await this.getChannels();
      let totalSaved = 0;
      let totalChats = 0;

      const updateProgress = () => {
        db.update(syncRuns)
          .set({ messagesSaved: totalSaved, chatsVisited: totalChats })
          .where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'slack', status: 'running', type: 'full', messagesSaved: totalSaved, chatsVisited: totalChats } });
      };

      for (const ch of channels) {
        if (this._cancelRequested) break;
        const existing = db.select().from(syncState)
          .where(and(eq(syncState.source, 'slack'), eq(syncState.chatId, ch.id)))
          .get();
        const since = existing?.lastMessageTs || undefined;

        const saved = await this.fetchChannelMessages(ch.id, ch.name, since, (count) => {
          onProgress?.('slack', ch.name, count);
        });
        totalSaved += saved;
        totalChats++;
        updateProgress();
        await sleep(300);
      }

      if (this._cancelRequested) {
        db.update(syncRuns).set({ status: 'cancelled', finishedAt: new Date().toISOString(), messagesSaved: totalSaved, chatsVisited: totalChats })
          .where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'slack', status: 'idle' } });
        console.log('[slack] Sync cancelled');
      } else {
        db.update(syncRuns).set({
          status: 'success',
          messagesSaved: totalSaved,
          chatsVisited: totalChats,
          finishedAt: new Date().toISOString(),
        }).where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'slack', status: 'success', messagesSaved: totalSaved } });
        // Contact sync — runs after messages so criteria flags can use message history
        try {
          const criteria = getContactCriteria('slack');
          if (criteria.enabled && this.accountInfo) {
            const contactCount = await syncSlackContacts(
              this.client as Parameters<typeof syncSlackContacts>[0],
              this.accountInfo.userId,
              criteria,
            );
            console.log(`[slack] Contact sync complete: ${contactCount} contacts`);
          }
        } catch (ce) {
          console.error('[slack] Contact sync error:', ce);
        }
        // Fetch and broadcast platform unread counts after sync
        this.fetchUnreadCounts().catch(console.error);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.update(syncRuns).set({
        status: 'error',
        errorMessage: msg,
        finishedAt: new Date().toISOString(),
      }).where(eq(syncRuns.id, runId)).run();
      broadcast({ type: 'sync:progress', data: { service: 'slack', status: 'error', error: msg } });
    }

    this.syncRunId = null;
  }

  async startSocketMode(): Promise<void> {
    if (!this.config.appToken) {
      console.warn('[slack] No app token — Socket Mode disabled. Using polling instead.');
      this.startPolling();
      return;
    }

    this.socketClient = new SocketModeClient({
      appToken: this.config.appToken,
      logLevel: LogLevel.ERROR,
    });

    this.socketClient.on('message', async ({ event, ack }: { event: Record<string, unknown>; ack: () => void }) => {
      ack();
      if (!event || event.subtype) return;

      const channelId = event.channel as string;
      const ts = event.ts as string || '';
      const userId = (event.user as string) || '';
      const userName = userId ? await this.resolveUser(userId) : 'Unknown';
      const channelName = this.channelCache.get(channelId) || channelId;
      const channelType = event.channel_type as string || '';
      const isDm = channelType === 'im';

      const db = getDb();
      const timestamp = ts ? new Date(parseFloat(ts) * 1000).toISOString() : new Date().toISOString();
      type SlackEvent = { files?: Array<{ url_private?: string; permalink?: string; thumb_480?: string; thumb_360?: string; name?: string; mimetype?: string; filetype?: string; original_w?: number; original_h?: number }>; attachments?: unknown[] };
      const slackEvent = event as SlackEvent;
      const liveFiles = (slackEvent.files || []).map((f) => ({
        url: f.url_private || '', proxyURL: f.thumb_480 || f.thumb_360 || f.url_private || '',
        filename: f.name || '', contentType: f.mimetype || '', filetype: f.filetype || '',
        width: f.original_w ?? null, height: f.original_h ?? null,
      }));
      const liveAttachments = liveFiles.length
        ? JSON.stringify({ files: liveFiles, richAttachments: slackEvent.attachments || [] })
        : (slackEvent.attachments ? JSON.stringify({ files: [], richAttachments: slackEvent.attachments }) : null);

      const result = db.insert(slackMessages).values({
        messageId: ts,
        channelId,
        channelName,
        userId,
        userName,
        content: (event.text as string) || '',
        attachments: liveAttachments,
        timestamp,
        rawJson: JSON.stringify(event),
      }).onConflictDoNothing().run();

      // Broadcast for real-time display in open conversations
      broadcast({
        type: 'message:new',
        data: {
          source: 'slack',
          messageId: ts,
          channelId,
          channelName,
          userId,
          userName,
          content: event.text,
          timestamp,
        },
      });

      // Push updated unread count to all clients (server-computed, DB-authoritative)
      broadcastUnreadForChat('slack', channelId);

      if (result.changes > 0) {
        if (userId && userId !== this.accountInfo?.userId) {
          upsertContactFromMessage({
            source: 'slack',
            platformId: userId,
            accountId: this.accountInfo?.userId,
            displayName: userName,
            isDm,
            isSmallGroup: false,
            isOwnedGroup: false,
            timestamp,
          });
        }
      }
    });

    // channel_marked / im_marked: user read a channel in another Slack client.
    // Write to chat_read_state so the count stays accurate cross-device.
    this.socketClient.on('channel_marked', async ({ event, ack }: { event: Record<string, unknown>; ack: () => void }) => {
      ack();
      const channelId = event.channel as string;
      if (channelId) markChatRead('slack', channelId);
    });

    this.socketClient.on('im_marked', async ({ event, ack }: { event: Record<string, unknown>; ack: () => void }) => {
      ack();
      const channelId = event.channel as string;
      if (channelId) markChatRead('slack', channelId);
    });

    await this.socketClient.start();
    this.connected = true;
    broadcast({ type: 'connection:status', data: { service: 'slack', status: 'connected', mode: 'socket' } });
    console.log('[slack] Socket Mode connected');
  }

  /**
   * Fetch mute state for all Slack channels from the API, persist to chat_mute_state,
   * then broadcast authoritative unread counts (DB-computed) to all clients.
   */
  async fetchUnreadCounts(): Promise<void> {
    try {
      const channels = await this.getChannels();
      const muteUpdates: Array<{ source: string; chatId: string; isMuted: boolean }> = [];
      const readUpdates: Array<{ source: string; chatId: string; lastReadAt: string }> = [];

      for (const ch of channels) {
        try {
          const info = await this.client.conversations.info({ channel: ch.id });
          const chInfo = info.channel as Record<string, unknown> | undefined;
          const isMuted = (chInfo?.is_muted as boolean | undefined) ?? false;
          muteUpdates.push({ source: 'slack', chatId: ch.id, isMuted });

          // Seed conduit's read cursor from Slack's native last_read timestamp.
          // last_read is a Slack epoch string like "1720000000.123456"; skip if
          // absent or "0" (channel never read on the platform).
          const lastReadTs = chInfo?.last_read as string | undefined;
          if (lastReadTs && lastReadTs !== '0') {
            const lastReadAt = new Date(parseFloat(lastReadTs) * 1000).toISOString();
            readUpdates.push({ source: 'slack', chatId: ch.id, lastReadAt });
          }

          await sleep(100); // rate limit
        } catch { /* skip individual channel errors */ }
      }

      // Persist mute + read state, then broadcast all counts (computed from DB)
      persistMuteState(muteUpdates);
      seedReadState(readUpdates);
      const allUpdates = computeAllUnreads();
      if (allUpdates.length > 0) broadcastUnread(allUpdates);
    } catch (e) {
      console.error('[slack] fetchUnreadCounts error:', e);
    }
  }

  /**
   * Mark a Slack channel as read up to the latest message.
   * Only called when markReadEnabled permission is true.
   */
  async markChannelRead(channelId: string): Promise<void> {
    try {
      // Get the latest message timestamp in this channel
      const res = await this.client.conversations.history({ channel: channelId, limit: 1 });
      const latestTs = (res.messages as Array<{ ts?: string }>)?.[0]?.ts;
      if (latestTs) {
        await this.client.conversations.mark({ channel: channelId, ts: latestTs });
      }
    } catch { /* ignore — mark-read is best-effort */ }
  }

  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  private startPolling(): void {
    // Fallback: poll every 2 minutes when no app token
    this.pollingInterval = setInterval(async () => {
      try {
        const channels = await this.getChannels();
        for (const ch of channels) {
          const db = getDb();
          const state = db.select().from(syncState)
            .where(and(eq(syncState.source, 'slack'), eq(syncState.chatId, ch.id)))
            .get();
          await this.fetchChannelMessages(ch.id, ch.name, state?.lastMessageTs || undefined);
          await sleep(200);
        }
      } catch (e) {
        console.error('[slack] Polling error:', e);
      }
    }, 2 * 60 * 1000);
    this.connected = true;
    broadcast({ type: 'connection:status', data: { service: 'slack', status: 'connected', mode: 'polling' } });
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    await this.client.chat.postMessage({ channel: channelId, text });
  }

  async getLatestDM(): Promise<{ channelName: string; content: string; timestamp: string } | null> {
    const channels = await this.getChannels();
    const dms = channels.filter((c) => c.type === 'im');
    for (const dm of dms) {
      const res = await this.client.conversations.history({ channel: dm.id, limit: 1 });
      if (res.messages && res.messages.length > 0) {
        const msg = res.messages[0];
        return {
          channelName: dm.name,
          content: msg.text || '',
          timestamp: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '',
        };
      }
    }
    return null;
  }

  async getLatestChannelMessage(): Promise<{ channelName: string; content: string; timestamp: string } | null> {
    const channels = await this.getChannels();
    const publicChannels = channels.filter((c) => (c.type === 'public_channel' || c.type === 'private_channel') && c.isMember !== false);
    for (const ch of publicChannels) {
      const res = await this.client.conversations.history({ channel: ch.id, limit: 1 });
      if (res.messages && res.messages.length > 0) {
        const msg = res.messages[0];
        return {
          channelName: ch.name,
          content: msg.text || '',
          timestamp: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '',
        };
      }
    }
    return null;
  }

  async sendSelf(text: string): Promise<boolean> {
    if (!this.accountInfo) return false;
    try {
      const dm = await this.client.conversations.open({ users: this.accountInfo.userId });
      const channelId = (dm.channel as { id: string })?.id;
      if (!channelId) return false;
      await this.client.chat.postMessage({ channel: channelId, text });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends a message to self and returns the channel ID + message timestamp,
   * which can be used to delete it after the realtime test completes.
   * Only used by the test runner — bypasses outbox intentionally.
   */
  async sendSelfWithToken(text: string): Promise<{ channelId: string; ts: string } | null> {
    if (!this.accountInfo) throw new Error('Not authenticated — accountInfo is missing');
    const dm = await this.client.conversations.open({ users: this.accountInfo.userId });
    const channelId = (dm.channel as { id: string })?.id;
    if (!channelId) throw new Error('conversations.open did not return a channel ID');
    const res = await this.client.chat.postMessage({ channel: channelId, text });
    const ts = (res as { ts?: string }).ts;
    if (!ts) throw new Error('chat.postMessage did not return a timestamp');
    return { channelId, ts };
  }

  /**
   * Deletes a specific message sent by this account.
   * Includes a safety check: verifies the message content matches the expected
   * token before deleting. Only deletes a single message. Test-runner only.
   */
  async deleteSelfMessage(channelId: string, ts: string, expectedToken: string): Promise<boolean> {
    try {
      // Safety: fetch the message and verify it is ours and matches the token
      const history = await this.client.conversations.history({
        channel: channelId, latest: ts, limit: 1, inclusive: true,
      });
      const msg = (history.messages as Array<{ ts: string; text: string; user?: string }> | undefined)?.[0];
      if (!msg || msg.ts !== ts) return false;
      if (!msg.text?.includes(expectedToken)) return false;
      if (this.accountInfo && msg.user && msg.user !== this.accountInfo.userId) return false;
      await this.client.chat.delete({ channel: channelId, ts });
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.socketClient) {
      await this.socketClient.disconnect();
      this.socketClient = null;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.connected = false;
    broadcast({ type: 'connection:status', data: { service: 'slack', status: 'disconnected' } });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
