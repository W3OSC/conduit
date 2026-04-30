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

      // Listen for read history events (fires when user reads a chat in another Telegram client).
      // Use the maxId from the event to find the precise timestamp of the last-read message.
      try {
        const { Raw } = await import('telegram/events/index.js');
        this.client.addEventHandler(async (update: unknown) => {
          try {
            const u = update as Record<string, unknown>;
            // UpdateReadHistoryInbox fires for private chats/small groups
            // UpdateChannelReadMessagesContents fires for channels/supergroups
            if (u?.className === 'UpdateReadHistoryInbox' || u?.className === 'UpdateChannelReadMessagesContents') {
              const peer = u.peer as Record<string, unknown> | undefined;
              const chatIdRaw = peer?.channelId ?? peer?.chatId ?? peer?.userId;
              if (chatIdRaw == null) return;
              const chatId = String(chatIdRaw);

              // maxId is the message ID of the last message the user read.
              // Use it to find the precise timestamp in our local DB.
              const maxId = u.maxId as number | undefined;
              if (maxId != null && maxId > 0) {
                const db = getDb();
                const msgRow = db.all<{ timestamp: string }>(sql`
                  SELECT timestamp FROM telegram_messages
                  WHERE CAST(chat_id AS TEXT) = ${chatId} AND message_id <= ${maxId}
                  ORDER BY message_id DESC
                  LIMIT 1
                `)[0];
                if (msgRow?.timestamp) {
                  seedReadState([{ source: 'telegram', chatId, lastReadAt: msgRow.timestamp }]);
                  // Recompute and broadcast just this chat
                  const { broadcastUnreadForChat: bcastChat } = await import('./unread.js');
                  bcastChat('telegram', chatId);
                  return;
                }
              }

              // Fallback: mark as read at current time if no message found for maxId
              markChatRead('telegram', chatId);
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
   * Fetch mute state and read positions for all Telegram dialogs from the
   * platform, persist to chat_mute_state / chat_read_state, then broadcast
   * authoritative unread counts (DB-computed) to all clients.
   *
   * Uses dialog.dialog.readInboxMaxId — the message ID of the last message
   * the user has read in each dialog. We look up that message ID in the local
   * DB to get its timestamp and use that as the read cursor. This is more
   * accurate than counting backwards with ROW_NUMBER() and avoids the
   * ordering ambiguity of the previous approach.
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

      // Build dialog map: chatId → { isMuted, readInboxMaxId, unreadCount }
      // readInboxMaxId is the message ID of the last message the user read.
      const dialogMap = new Map<string, { isMuted: boolean; readInboxMaxId: number; unreadCount: number }>();
      for (const dialog of dialogs) {
        const entity = dialog.entity as { id?: { value?: unknown } } | null;
        if (!entity?.id) continue;
        const chatId = String(entity.id.value ?? entity.id);

        const muteUntil: number =
          (dialog as unknown as { dialog?: { notifySettings?: { muteUntil?: number } } })
            .dialog?.notifySettings?.muteUntil ?? 0;
        const isMuted = muteUntil === 2147483647 || muteUntil > now;

        // readInboxMaxId: the message ID up to which the user has read this dialog.
        // 0 means nothing has been read (or the field is unavailable).
        const readInboxMaxId: number =
          (dialog as unknown as { dialog?: { readInboxMaxId?: number } })
            .dialog?.readInboxMaxId ?? 0;

        const unreadCount: number = (dialog as unknown as { unreadCount?: number }).unreadCount ?? 0;

        muteUpdates.push({ source: 'telegram', chatId, isMuted });
        dialogMap.set(chatId, { isMuted, readInboxMaxId, unreadCount });
      }

      // Build read cursor updates by looking up readInboxMaxId in local DB.
      //
      // Strategy:
      //   - unreadCount === 0 → fully read, seed cursor to now.
      //   - readInboxMaxId > 0 → find the timestamp of that message in local DB.
      //     This gives the precise last-read position without any counting tricks.
      //   - readInboxMaxId === 0 and unreadCount > 0 → can't determine cursor,
      //     skip (all messages will count as unread).

      const nowIso = new Date().toISOString();
      const readUpdates: Array<{ source: string; chatId: string; lastReadAt: string }> = [];

      // Collect chatIds that need a DB lookup (have a readInboxMaxId > 0)
      const needsLookup: Array<{ chatId: string; readInboxMaxId: number }> = [];
      for (const [chatId, { unreadCount, readInboxMaxId }] of dialogMap) {
        if (unreadCount === 0) {
          // Fully read: seed to now
          readUpdates.push({ source: 'telegram', chatId, lastReadAt: nowIso });
        } else if (readInboxMaxId > 0) {
          needsLookup.push({ chatId, readInboxMaxId });
        }
        // else: unreadCount > 0 and readInboxMaxId === 0 → skip, leave cursor unset
      }

      // Bulk lookup: find the timestamp for each (chatId, messageId) pair.
      // Use a single query with CASE expressions or do a batch IN query grouped by chat.
      if (needsLookup.length > 0) {
        // For each chat with a readInboxMaxId, find the timestamp of the message
        // with that ID (or the closest message with id <= readInboxMaxId).
        // We do one query per chat to avoid complex cross-chat SQL; the list is
        // typically small (only chats with unread messages).
        for (const { chatId, readInboxMaxId } of needsLookup) {
          const row = db.all<{ timestamp: string }>(sql`
            SELECT timestamp FROM telegram_messages
            WHERE CAST(chat_id AS TEXT) = ${chatId}
              AND message_id <= ${readInboxMaxId}
            ORDER BY message_id DESC
            LIMIT 1
          `)[0];
          if (row?.timestamp) {
            readUpdates.push({ source: 'telegram', chatId, lastReadAt: row.timestamp });
          }
          // If no local message found (chat not synced yet), don't seed the cursor.
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
   * Mark a Telegram chat as read on the platform.
   * maxId: 0 means "mark all messages as read".
   */
  async markChatRead(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const { Api } = await import('telegram');
      const entity = await this.client.getEntity(Number(chatId));
      await this.client.invoke(new Api.messages.ReadHistory({ peer: entity as never, maxId: 0 }));
    } catch { /* mark-read is best-effort */ }
  }

  /**
   * Mark a Telegram chat as unread on the platform using the MarkDialogUnread
   * MTProto API (messages.markDialogUnread). This mirrors exactly what the
   * Telegram client does when the user long-presses a chat and chooses "Mark as unread".
   */
  async markChatUnread(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const { Api } = await import('telegram');
      const entity = await this.client.getEntity(Number(chatId));
      // Convert the resolved entity to an InputPeer for the MarkDialogUnread call.
      // getInputPeer is an internal GramJS helper that handles all entity types.
      const inputPeer = (this.client as unknown as {
        getInputEntity: (entity: unknown) => Promise<unknown>;
      }).getInputEntity(entity);
      const resolvedPeer = await inputPeer;
      const peer = new Api.InputDialogPeer({ peer: resolvedPeer as never });
      await this.client.invoke(new Api.messages.MarkDialogUnread({ unread: true, peer }));
    } catch { /* best-effort */ }
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
