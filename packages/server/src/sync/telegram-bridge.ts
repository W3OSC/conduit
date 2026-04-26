import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { getDb } from '../db/client.js';
import { telegramMessages, syncState, syncRuns, accounts } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { broadcast, broadcastUnread } from '../websocket/hub.js';
import { persistMuteState, seedReadState, broadcastUnreadForChat, markChatRead, computeAllUnreads } from './unread.js';
import { getCreds, setCreds, type TelegramCreds } from '../api/credentials.js';
import {
  syncTelegramContacts, upsertContact, upsertContactFromMessage, getContactCriteria,
} from './contacts.js';
import type { Entity } from 'telegram/define.js';

export interface TelegramConfig {
  phone: string;
  apiId: number;
  apiHash: string;
  /** Serialised GramJS StringSession (base64). Empty string for first-time auth. */
  sessionString?: string;
}

interface TelegramChat {
  chat_id: string;
  name: string;
  chat_type: string;
}

interface TelegramMessageData {
  message_id: string;
  chat_id: string;
  chat_name: string;
  sender_id?: string;
  sender_name?: string;
  content?: string;
  media_type?: string;
  timestamp: string;
  raw_json?: Record<string, unknown>;
}

function entityName(entity: Entity): string {
  if ('title' in entity && entity.title) return entity.title as string;
  const parts: string[] = [];
  if ('firstName' in entity && entity.firstName) parts.push(entity.firstName as string);
  if ('lastName' in entity && entity.lastName) parts.push(entity.lastName as string);
  return parts.join(' ') || String(entity.id);
}

function entityType(entity: Entity): string {
  const className = entity.className ?? '';
  if (className === 'Channel') return (entity as { broadcast?: boolean }).broadcast ? 'channel' : 'supergroup';
  if (className === 'Chat') return 'group';
  return 'private';
}

// Transient GramJS errors that are normal network noise and should not
// be treated as connection failures or logged at error level.
const TRANSIENT_ERRORS = new Set(['TIMEOUT', 'CONNECTION_RESET', 'AUTH_KEY_UNREGISTERED']);

function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${e.stack || ''}` : String(e);
  return (
    TRANSIENT_ERRORS.has(e instanceof Error ? e.message : String(e)) ||
    msg.includes('TIMEOUT') ||
    msg.includes('FLOOD_WAIT') ||
    // GramJS update dispatcher bug: certain raw update types cause
    // "builder.resolve is not a function" — not fatal, not fixable in userland
    msg.includes('builder.resolve is not a function') ||
    msg.includes('builder.build is not a function') ||
    msg.includes('_dispatchUpdate')
  );
}

function floodWaitSeconds(e: unknown): number {
  const msg = e instanceof Error ? e.message : String(e);
  const match = msg.match(/FLOOD_WAIT_(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

export class TelegramBridge {
  private client: TelegramClient | null = null;
  private config: TelegramConfig | null = null;
  private _cancelRequested = false;
  private _reconnectTimer: NodeJS.Timeout | null = null;
  private _reconnectAttempts = 0;
  private _disconnecting = false;
  public connected = false;
  public accountInfo: { userId: string; displayName: string } | null = null;

  cancelSync(): void {
    this._cancelRequested = true;
    try {
      const db = getDb();
      db.update(syncRuns)
        .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
        .where(and(eq(syncRuns.source, 'telegram'), eq(syncRuns.status, 'running')))
        .run();
      broadcast({ type: 'sync:progress', data: { service: 'telegram', status: 'idle' } });
    } catch { /* ignore */ }
  }

  private _scheduleReconnect(): void {
    if (this._disconnecting || !this.config) return;
    // Exponential backoff: 5s, 10s, 20s, 40s … capped at 5 minutes
    const delay = Math.min(5000 * Math.pow(2, this._reconnectAttempts), 300000);
    this._reconnectAttempts++;
    console.log(`[telegram] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts})…`);
    broadcast({ type: 'connection:status', data: { service: 'telegram', status: 'connecting', error: 'Reconnecting…' } });
    this._reconnectTimer = setTimeout(async () => {
      if (this._disconnecting || !this.config) return;
      const ok = await this.connect(this.config);
      if (ok) {
        this._reconnectAttempts = 0;
        console.log('[telegram] Reconnected successfully');
      }
    }, delay);
  }

  async connect(cfg: TelegramConfig): Promise<boolean> {
    this.config = cfg;
    this._disconnecting = false;
    const session = new StringSession(cfg.sessionString || '');
    this.client = new TelegramClient(session, cfg.apiId, cfg.apiHash, {
      connectionRetries: 5,
      retryDelay: 2000,
    });

    // Catch unhandled errors from GramJS's update loop — these are normally
    // TIMEOUT errors from Telegram's servers that GramJS retries internally.
    // Without this handler they crash to stderr as unhandled rejections.
    (this.client as unknown as { _errorHandler?: (e: unknown) => void })._errorHandler = (e: unknown) => {
      if (isTransient(e)) return; // expected network noise, ignore
      console.error('[telegram] Client error:', e);
    };

    try {
      await this.client.connect();
      if (!await this.client.isUserAuthorized()) {
        console.error('[telegram] Session not authorised. Generate a session string first.');
        return false;
      }
      const me = await this.client.getMe();
      const displayName = [
        (me as { firstName?: string }).firstName,
        (me as { lastName?: string }).lastName,
      ].filter(Boolean).join(' ') || String(me.id);

      this.accountInfo = { userId: String(me.id), displayName };
      this.connected = true;

      // Persist the (possibly refreshed) session string back to the DB
      const freshSession = (this.client.session as StringSession).save();
      const existingCreds = (getCreds('telegram') || {}) as TelegramCreds;
      setCreds('telegram', { ...existingCreds, sessionString: freshSession });

      // Persist account record
      const db = getDb();
      const existing = db.select().from(accounts)
        .where(and(eq(accounts.source, 'telegram'), eq(accounts.accountId, String(me.id))))
        .get();
      if (!existing) {
        db.insert(accounts).values({
          source: 'telegram',
          accountId: String(me.id),
          displayName,
          lastSync: new Date().toISOString(),
        }).run();
      }

      // Upsert own user into contacts so our avatar shows in chat
      let selfAvatarUrl: string | undefined;
      try {
        const photoBuffer = await this.client!.downloadProfilePhoto(me, { isBig: false });
        if (photoBuffer && typeof photoBuffer !== 'string') {
          selfAvatarUrl = `data:image/jpeg;base64,${(photoBuffer as Buffer).toString('base64')}`;
        }
      } catch { /* no photo set — ignore */ }
      upsertContact({
        source: 'telegram',
        platformId: String(me.id),
        accountId: String(me.id),
        displayName,
        avatarUrl: selfAvatarUrl,
      });

      // Handle disconnection events — schedule reconnect with backoff
      this.client.addEventHandler(async () => {
        if (this._disconnecting) return;
        console.warn('[telegram] Disconnected from MTProto — scheduling reconnect');
        this.connected = false;
        this._scheduleReconnect();
      // @ts-ignore — GramJS Disconnected event
      }, new (await import('telegram/events/index.js').then(m => m.Disconnect || class {}))());

      // Register live message event handler
      this.client.addEventHandler(async (event: NewMessageEvent) => {
        try {
          const msg = event.message;
          const chat = await event.getChat();
          const sender = await msg.getSender();

          if (!chat) return;
          const chatId = String(msg.chatId ?? msg.peerId);
          const chatName = chat ? entityName(chat) : chatId;
          const senderId = msg.senderId ? String(msg.senderId) : undefined;
          const senderName = sender ? entityName(sender) : undefined;
          const timestamp = msg.date
            ? new Date(msg.date * 1000).toISOString()
            : new Date().toISOString();

          const chatType = entityType(chat);
          const db = getDb();
          const result = db.insert(telegramMessages).values({
            messageId: msg.id,
            chatId: Number(chatId),
            chatName,
            chatType,
            senderId: senderId ? Number(senderId) : null,
            senderName: senderName || null,
            content: msg.text || null,
            mediaType: msg.media ? msg.media.className.toLowerCase() : null,
            timestamp,
            rawJson: null,
          }).onConflictDoNothing().run();

          // Broadcast for real-time display in open conversations
          const broadcastContent = msg.text || msg.message || '';
          broadcast({
            type: 'message:new',
            data: {
              source: 'telegram',
              message_id: String(msg.id),
              chat_id: chatId,
              chat_name: chatName,
              sender_id: senderId,
              sender_name: senderName,
              content: broadcastContent,
              timestamp,
            },
          });

          // Push updated unread count (server-computed) to all clients
          broadcastUnreadForChat('telegram', chatId);

          if (result.changes > 0) {
            // Update contact for sender — private chats (User entity) are DMs
            if (senderId && senderId !== this.accountInfo?.userId) {
              const isDm = chat.className === 'User';
              upsertContactFromMessage({
                source: 'telegram',
                platformId: senderId,
                accountId: this.accountInfo?.userId,
                displayName: senderName,
                isDm,
                isSmallGroup: false,
                isOwnedGroup: false,
                timestamp,
              });
            }
          }
        } catch (e) {
          if (!isTransient(e)) console.error('[telegram] Error handling new message:', e);
        }
      }, new NewMessage({}));

      // Listen for read history events (fires when user reads a chat in another Telegram client)
      try {
        const { Raw } = await import('telegram/events/index.js');
        this.client.addEventHandler(async (update: unknown) => {
          try {
            const u = update as Record<string, unknown>;
            // UpdateReadHistoryInbox: another client read messages in a chat
            if (u?.className === 'UpdateReadHistoryInbox' || u?.className === 'UpdateChannelReadMessagesContents') {
              const peer = u.peer as Record<string, unknown> | undefined;
              const chatId = peer?.channelId ?? peer?.chatId ?? peer?.userId;
              if (chatId != null) {
                // Persist read state so counts stay accurate
                markChatRead('telegram', String(chatId));
              }
            }
          } catch { /* ignore */ }
        }, new Raw({}));
      } catch { /* Raw event may not be available in all GramJS versions */ }

      broadcast({ type: 'connection:status', data: { service: 'telegram', status: 'connected', mode: 'gramjs' } });
      console.log(`[telegram] Connected as ${displayName}`);

      // Broadcast platform unread counts shortly after connect (non-blocking)
      setTimeout(() => this.fetchUnreadCounts().catch(console.error), 2000);

      return true;
    } catch (e) {
      if (!isTransient(e)) console.error('[telegram] Connection failed:', e);
      return false;
    }
  }

  async getChats(): Promise<TelegramChat[]> {
    if (!this.client) throw new Error('Not connected');
    const dialogs = await this.client.getDialogs({ limit: 500 });
    return dialogs
      .filter((d) => d.entity != null)
      .map((d) => ({
        chat_id: String(d.entity!.id),
        name: entityName(d.entity!),
        chat_type: entityType(d.entity!),
      }));
  }

  async getMessages(chatId: string, since?: string, limit = 200): Promise<TelegramMessageData[]> {
    if (!this.client) throw new Error('Not connected');
    const entity = await this.client.getEntity(Number(chatId));
    const minDate = since ? Math.floor(new Date(since).getTime() / 1000) : undefined;
    const msgs = await this.client.getMessages(entity, {
      limit,
      ...(minDate ? { minId: 0, offsetDate: minDate } : {}),
    });
    return msgs.map((msg) => {
      const sender = msg.sender;
      const senderName = sender ? entityName(sender) : undefined;
      return {
        message_id: String(msg.id),
        chat_id: chatId,
        chat_name: entityName(entity),
        sender_id: msg.senderId ? String(msg.senderId) : undefined,
        sender_name: senderName,
        content: msg.text || '',
        media_type: msg.media ? msg.media.className.toLowerCase() : undefined,
        timestamp: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
      };
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const entity = await this.client.getEntity(Number(chatId));
    await this.client.sendMessage(entity, { message: text });
  }

  async initialFullSync(onProgress?: (service: string, chat: string, saved: number) => void): Promise<void> {
    const db = getDb();
    this._cancelRequested = false;
    const runId = db.insert(syncRuns).values({
      source: 'telegram',
      syncType: 'full',
      status: 'running',
      startedAt: new Date().toISOString(),
    }).run().lastInsertRowid as number;

    broadcast({ type: 'sync:progress', data: { service: 'telegram', status: 'running', type: 'full' } });

    try {
      const chats = await this.getChats();
      let totalSaved = 0;
      let totalChats = 0;

      const updateProgress = () => {
        db.update(syncRuns)
          .set({ messagesSaved: totalSaved, chatsVisited: totalChats })
          .where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'telegram', status: 'running', type: 'full', messagesSaved: totalSaved, chatsVisited: totalChats } });
      };

      for (const chat of chats) {
        if (this._cancelRequested) break;

        const state = db.select().from(syncState)
          .where(and(eq(syncState.source, 'telegram'), eq(syncState.chatId, chat.chat_id)))
          .get();

        let messages: Awaited<ReturnType<typeof this.getMessages>> = [];
        try {
          messages = await this.getMessages(chat.chat_id, state?.lastMessageTs || undefined, 500);
        } catch (e) {
          const wait = floodWaitSeconds(e);
          if (wait > 0) {
            console.log(`[telegram] FLOOD_WAIT ${wait}s — pausing sync for this chat`);
            await new Promise((r) => setTimeout(r, wait * 1000 + 1000));
            try { messages = await this.getMessages(chat.chat_id, state?.lastMessageTs || undefined, 500); }
            catch { continue; } // skip this chat if still failing
          } else if (!isTransient(e)) {
            console.error('[telegram] Error fetching messages for chat', chat.chat_id, e);
          }
          continue;
        }
        let saved = 0;

        for (const msg of messages) {
          if (this._cancelRequested) break;
          const result = db.insert(telegramMessages).values({
            messageId: parseInt(msg.message_id),
            chatId: parseInt(msg.chat_id),
            chatName: msg.chat_name,
            chatType: chat.chat_type || null,
            senderId: msg.sender_id ? parseInt(msg.sender_id) : null,
            senderName: msg.sender_name || null,
            content: msg.content || null,
            mediaType: msg.media_type || null,
            timestamp: msg.timestamp,
            rawJson: msg.raw_json ? JSON.stringify(msg.raw_json) : null,
          }).onConflictDoNothing().run();
          if (result.changes > 0) saved++;
        }

        totalSaved += saved;
        totalChats++;
        onProgress?.('telegram', chat.name, saved);
        updateProgress();

        db.insert(syncState).values({
          source: 'telegram',
          chatId: chat.chat_id,
          chatName: chat.name,
          lastMessageTs: new Date().toISOString(),
          lastFetchedAt: new Date().toISOString(),
          isFullSync: true,
          messageCount: saved,
        }).onConflictDoUpdate({
          target: [syncState.source, syncState.chatId, syncState.accountId],
          set: { lastFetchedAt: new Date().toISOString(), messageCount: saved },
        }).run();
      }

      if (this._cancelRequested) {
        db.update(syncRuns).set({ status: 'cancelled', finishedAt: new Date().toISOString(), messagesSaved: totalSaved, chatsVisited: totalChats })
          .where(eq(syncRuns.id, runId)).run();
        broadcast({ type: 'sync:progress', data: { service: 'telegram', status: 'idle' } });
        console.log('[telegram] Sync cancelled');
      } else {
        db.update(syncRuns).set({
          status: 'success',
          messagesSaved: totalSaved,
          chatsVisited: totalChats,
          finishedAt: new Date().toISOString(),
        }).where(eq(syncRuns.id, runId)).run();

        broadcast({ type: 'sync:progress', data: { service: 'telegram', status: 'success', messagesSaved: totalSaved } });

        // Contact sync
        try {
          const criteria = getContactCriteria('telegram');
          if (criteria.enabled && this.accountInfo && this.client) {
            const contactCount = await syncTelegramContacts(
              this.client as unknown as Parameters<typeof syncTelegramContacts>[0],
              this.accountInfo.userId,
              criteria,
            );
            console.log(`[telegram] Contact sync complete: ${contactCount} contacts`);
          }
        } catch (ce) {
          console.error('[telegram] Contact sync error:', ce);
        }
        // Refresh unread counts after sync
        this.fetchUnreadCounts().catch(console.error);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.update(syncRuns).set({
        status: 'error',
        errorMessage: msg,
        finishedAt: new Date().toISOString(),
      }).where(eq(syncRuns.id, runId)).run();
      broadcast({ type: 'sync:progress', data: { service: 'telegram', status: 'error', error: msg } });
    }
  }

  async testLatestDM(): Promise<{ channelName: string; content: string; timestamp: string } | null> {
    if (!this.client) return null;
    const dialogs = await this.client.getDialogs({ limit: 50 });
    for (const d of dialogs) {
      if (!d.entity || d.entity.className !== 'User') continue;
      const entity = d.entity;
      const msgs = await this.client.getMessages(entity, { limit: 1 });
      if (msgs.length) {
        return {
          channelName: entityName(entity),
          content: msgs[0].text || '',
          timestamp: msgs[0].date ? new Date(msgs[0].date * 1000).toISOString() : '',
        };
      }
    }
    return null;
  }

  async testLatestChannel(): Promise<{ channelName: string; content: string; timestamp: string } | null> {
    if (!this.client) return null;
    const dialogs = await this.client.getDialogs({ limit: 50 });
    for (const d of dialogs) {
      if (!d.entity || (d.entity.className !== 'Channel' && d.entity.className !== 'Chat')) continue;
      const entity = d.entity;
      const msgs = await this.client.getMessages(entity, { limit: 1 });
      if (msgs.length) {
        return {
          channelName: entityName(entity),
          content: msgs[0].text || '',
          timestamp: msgs[0].date ? new Date(msgs[0].date * 1000).toISOString() : '',
        };
      }
    }
    return null;
  }

  async testSendSelf(text = 'Conduit test message'): Promise<boolean> {
    if (!this.client) return false;
    try {
      const me = await this.client.getMe();
      await this.client.sendMessage(me as Entity, { message: text });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends a message to self and returns the message ID.
   * Test-runner only — bypasses outbox.
   */
  async sendSelfWithToken(text: string): Promise<{ messageId: number } | null> {
    if (!this.client) return null;
    try {
      const me = await this.client.getMe();
      const msg = await this.client.sendMessage(me as Entity, { message: text });
      return { messageId: msg.id };
    } catch {
      return null;
    }
  }

  /**
   * Deletes a specific message from the Saved Messages chat (self DM).
   * Safety-checked: verifies the message text contains the expected token
   * and that only one message ID is deleted. Test-runner only.
   */
  async verifyMessageExists(messageId: number, expectedToken: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const me = await this.client.getMe();
      const msgs = await this.client.getMessages(me as Entity, { ids: [messageId] });
      if (!msgs.length || !msgs[0]) return false;
      return msgs[0].text?.includes(expectedToken) ?? false;
    } catch {
      return false;
    }
  }

  async deleteSelfMessage(messageId: number, expectedToken: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const me = await this.client.getMe();
      // Fetch the specific message to verify before deleting
      const msgs = await this.client.getMessages(me as Entity, { ids: [messageId] });
      if (!msgs.length || !msgs[0]) return false;
      if (!msgs[0].text?.includes(expectedToken)) return false;
      // Delete only this single specific message
      await this.client.deleteMessages(me as Entity, [messageId], { revoke: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch Telegram dialog folders (the user's custom folder/tab organization).
   * Returns an array of { id, title, chatIds[] } — the chatIds are the Telegram
   * peer IDs of chats included in each folder.
   */
  async getDialogFolders(): Promise<Array<{ id: number; title: string; chatIds: string[] }>> {
    if (!this.client) return [];
    try {
      const { Api } = await import('telegram');
      const result = await this.client.invoke(new Api.messages.GetDialogFilters()) as {
        filters?: Array<{
          id?: number;
          title?: string | { text?: string };
          includePeers?: Array<{ userId?: { value?: unknown }; chatId?: { value?: unknown }; channelId?: { value?: unknown } }>;
        }>;
      };

      const folders: Array<{ id: number; title: string; chatIds: string[] }> = [];

      for (const f of result.filters ?? []) {
        if (!f.id || !f.title) continue;
        const title = typeof f.title === 'string' ? f.title : (f.title?.text ?? '');
        if (!title) continue;

        const chatIds: string[] = [];
        for (const peer of f.includePeers ?? []) {
          const id = peer.userId?.value ?? peer.chatId?.value ?? peer.channelId?.value;
          if (id != null) chatIds.push(String(id));
        }

        folders.push({ id: f.id, title, chatIds });
      }

      return folders;
    } catch (e) {
      console.error('[telegram] GetDialogFilters error:', e);
      return [];
    }
  }

  /**
   * Fetch mute state for all Telegram dialogs, persist to chat_mute_state,
   * then broadcast authoritative unread counts (DB-computed) to all clients.
   *
   * muteUntil: 0 = not muted, 2147483647 = muted forever, future Unix ts = timed mute.
   */
  async fetchUnreadCounts(): Promise<void> {
    if (!this.client) return;
    try {
      const db = getDb();
      const dialogs = await this.client.getDialogs({ limit: 500 });
      const now = Math.floor(Date.now() / 1000);
      const muteUpdates: Array<{ source: string; chatId: string; isMuted: boolean }> = [];
      const readUpdates: Array<{ source: string; chatId: string; lastReadAt: string }> = [];

      // Build dialog map first (chatId → unreadCount/isMuted) in a single pass
      // over the dialogs list so we can batch the DB work below.
      const dialogMap = new Map<string, { isMuted: boolean; unreadCount: number }>();
      for (const dialog of dialogs) {
        const entity = dialog.entity as { id?: { value?: unknown } } | null;
        if (!entity?.id) continue;
        const chatId = String(entity.id.value ?? entity.id);
        const muteUntil: number =
          (dialog as unknown as { dialog?: { notifySettings?: { muteUntil?: number } } })
            .dialog?.notifySettings?.muteUntil ?? 0;
        const isMuted = muteUntil === 2147483647 || muteUntil > now;
        const unreadCount: number = (dialog as unknown as { unreadCount?: number }).unreadCount ?? 0;
        muteUpdates.push({ source: 'telegram', chatId, isMuted });
        dialogMap.set(chatId, { isMuted, unreadCount });
      }

      // Seed read cursors from Telegram's native unread state.
      // For chats fully read (unreadCount === 0) → seed to now.
      // For chats with unread messages → we need to find the timestamp of the
      // last-read message (i.e. the message just before the unread window).
      //
      // Instead of one DB query per dialog (N queries), we load all messages
      // for all relevant chat IDs in two bulk queries and compute offsets in memory.

      const nowIso = new Date().toISOString();

      // Chats the user has fully read: seed to now immediately.
      for (const [chatId, { unreadCount }] of dialogMap) {
        if (unreadCount === 0) {
          readUpdates.push({ source: 'telegram', chatId, lastReadAt: nowIso });
        }
      }

      // Chats with unread messages: fetch all their messages ordered DESC in one
      // query per chat — but batch them by loading timestamps for all affected
      // chats at once using a single GROUP BY + window-function-style raw query.
      const unreadChatIds = [...dialogMap.entries()]
        .filter(([, { unreadCount }]) => unreadCount > 0)
        .map(([chatId]) => chatId);

      if (unreadChatIds.length > 0) {
        // Load per-chat timestamp arrays in one query:
        // SELECT chat_id, timestamp, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp DESC)
        // SQLite supports window functions since 3.25 (2018). We use them here to
        // avoid N separate queries.
        const inList = sql.join(unreadChatIds.map((id) => sql`${id}`), sql`, `);
        const rows = db.all<{ chatId: string; timestamp: string; rn: number }>(sql`
          SELECT CAST(chat_id AS TEXT) AS chatId,
                 timestamp,
                 ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp DESC) AS rn
          FROM telegram_messages
          WHERE CAST(chat_id AS TEXT) IN (${inList})
        `);

        // Group by chatId for O(1) offset lookup
        const byChat = new Map<string, Array<string>>();
        for (const row of rows) {
          const key = String(row.chatId);
          if (!byChat.has(key)) byChat.set(key, []);
          byChat.get(key)!.push(row.timestamp); // already DESC order from window fn
        }

        for (const [chatId, { unreadCount }] of dialogMap) {
          if (unreadCount === 0) continue;
          const timestamps = byChat.get(chatId);
          if (!timestamps || timestamps.length <= unreadCount) {
            // Fewer messages in DB than unreadCount → all are unread, don't seed
            continue;
          }
          // timestamps[unreadCount] is the first message BEFORE the unread window
          readUpdates.push({ source: 'telegram', chatId, lastReadAt: timestamps[unreadCount] });
        }
      }

      persistMuteState(muteUpdates);
      seedReadState(readUpdates);
      const allUpdates = computeAllUnreads();
      if (allUpdates.length > 0) broadcastUnread(allUpdates);
    } catch (e) {
      if (!isTransient(e)) console.error('[telegram] fetchUnreadCounts error:', e);
    }
  }

  /**
   * Mark a Telegram chat as read.
   * Only called when markReadEnabled permission is true.
   */
  async markChatRead(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const { Api } = await import('telegram');
      const entity = await this.client.getEntity(Number(chatId));
      await this.client.invoke(new Api.messages.ReadHistory({ peer: entity as never, maxId: 0 }));
    } catch { /* mark-read is best-effort */ }
  }

  disconnect(): void {
    // Mark as intentionally disconnecting so the reconnect timer doesn't fire
    this._disconnecting = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempts = 0;
    if (this.client) {
      this.client.disconnect().catch(() => {});
      this.client = null;
    }
    this.connected = false;
    this.accountInfo = null;
    broadcast({ type: 'connection:status', data: { service: 'telegram', status: 'disconnected' } });
  }
}
