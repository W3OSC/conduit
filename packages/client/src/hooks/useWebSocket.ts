import { useEffect } from 'react';
import {
  useConnectionStore, useOutboxStore, useSyncStore, useMessageStreamStore,
  useUnreadStore, useNotificationStore, useAiChatStore, useUpdateStore,
} from '../store';
import type { ConnectionStatus, Message } from '../lib/api';
import { api } from '../lib/api';

const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

interface WsEvent {
  type: string;
  data: unknown;
}

let globalWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let listeners = new Set<(event: WsEvent) => void>();

// ── Reconnect callbacks ───────────────────────────────────────────────────────
// Components can subscribe to be notified whenever the WebSocket successfully
// (re)connects.  This is used by the AI chat to trigger a re-fetch and recover
// any messages that were streamed while the connection was down.
let reconnectCallbacks = new Set<() => void>();

export function onWsReconnect(cb: () => void): () => void {
  reconnectCallbacks.add(cb);
  return () => { reconnectCallbacks.delete(cb); };
}

// ── Exponential backoff ───────────────────────────────────────────────────────
const BACKOFF_BASE_MS  = 1_000;
const BACKOFF_MAX_MS   = 30_000;
let   backoffAttempt   = 0;

function nextBackoffMs(): number {
  // 1 s, 2 s, 4 s, 8 s, 16 s, 30 s (capped), with ±20 % jitter
  const base = Math.min(BACKOFF_BASE_MS * 2 ** backoffAttempt, BACKOFF_MAX_MS);
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20 %
  return Math.round(base + jitter);
}

/** Fetch authoritative unread state from the server and replace the client store. */
async function syncUnreadFromServer(): Promise<void> {
  try {
    const entries = await api.getUnread();
    useUnreadStore.getState().setFromServer(entries);
  } catch { /* ignore — retries on next reconnect */ }
}

/** Fetch authoritative connection status from the server and seed the store.
 *  The server fires connection:status events at startup — if the browser
 *  connects after those events, it would never receive them. Polling the
 *  REST endpoint on every (re)connect ensures the UI is always up-to-date. */
async function syncConnectionStatusFromServer(): Promise<void> {
  try {
    const statuses = await api.connections();
    useConnectionStore.getState().setAllStatuses(statuses);
  } catch { /* ignore — retries on next reconnect */ }
}

function connectGlobal() {
  if (globalWs && globalWs.readyState === WebSocket.OPEN) return;
  if (globalWs && globalWs.readyState === WebSocket.CONNECTING) return;

  globalWs = new WebSocket(WS_URL);

  globalWs.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Reset backoff on successful connection
    backoffAttempt = 0;

    // Re-seed unread state from the server on every (re)connect.
    // This is the single authoritative load — no client-side counting, no localStorage.
    syncUnreadFromServer();
    // Seed connection status — server fires connection:status events at startup,
    // which the browser would miss if it connects after those events fired.
    syncConnectionStatusFromServer();

    // Notify all subscribers that the WebSocket (re)connected so they can
    // trigger any necessary data re-fetches (e.g. AI message recovery).
    for (const cb of reconnectCallbacks) {
      try { cb(); } catch { /* ignore */ }
    }
  };

  globalWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as WsEvent;
      for (const listener of listeners) listener(msg);
    } catch { /* ignore */ }
  };

  globalWs.onclose = () => {
    backoffAttempt += 1;
    const delay = nextBackoffMs();
    reconnectTimer = setTimeout(connectGlobal, delay);
  };

  globalWs.onerror = () => { globalWs?.close(); };
}

export function useWebSocket() {
  const { setStatus, setAllStatuses } = useConnectionStore();
  const { setPendingCount, addItem, updateItem } = useOutboxStore();
  const { setProgress } = useSyncStore();
  const { addMessage } = useMessageStreamStore();

  useEffect(() => {
    connectGlobal();

    const handler = (event: WsEvent) => {
      switch (event.type) {

        case 'connection:status': {
          const d = event.data as { service: string } & ConnectionStatus;
          setStatus(d.service, d);
          break;
        }

        case 'sync:progress': {
          const d = event.data as {
            service: string; status: string;
            messagesSaved?: number; chatsVisited?: number; error?: string; type?: string;
          };
          setProgress(d.service, {
            service: d.service,
            status: d.status as 'running' | 'success' | 'error' | 'idle',
            type: d.type,
            messagesSaved: d.messagesSaved,
            chatsVisited: d.chatsVisited,
            error: d.error,
          });
          break;
        }

        case 'outbox:new': {
          const d = event.data as Record<string, unknown>;
          if (d.id) addItem(d as unknown as import('../lib/api').OutboxItem);
          break;
        }

        case 'outbox:updated': {
          const d = event.data as { id: number; status: string; recipientName?: string };
          updateItem(d.id, { status: d.status as import('../lib/api').OutboxItem['status'] });
          if (d.status === 'sent') {
            useNotificationStore.getState().add({
              type: 'outbox',
              title: 'Message sent',
              body: d.recipientName ? `Your message to ${d.recipientName} was sent.` : 'Your message was sent.',
              timestamp: new Date().toISOString(),
            });
          }
          break;
        }

        case 'unread:update': {
          // Server pushes updated counts after every new message, mark-read, or mute change.
          const d = event.data as { updates: Array<{ source: string; chatId: string; count: number; isMuted?: boolean }> };
          useUnreadStore.getState().applyUpdate(d.updates || []);
          break;
        }

        case 'message:new': {
          const msg = event.data as Message;
          addMessage(msg);

          // Notification for non-muted chats
          const src = msg.source;
          const msgData = msg as unknown as Record<string, unknown>;
          const cid = String(msgData.chatId || msgData.channelId || '');
          const isMuted = src && cid ? useUnreadStore.getState().getIsMuted(src, cid) : false;
          if (!isMuted && src && cid) {
            const senderName = String(msgData.authorName || msgData.userName || msgData.sender_name || 'Unknown');
            const channelName = String(msgData.channelName || msgData.chat_name || cid);
            useNotificationStore.getState().add({
              type: 'message',
              title: `${senderName} in ${channelName}`,
              body: String(msgData.content || '').slice(0, 120),
              source: src,
              chatId: cid,
              timestamp: String(msgData.timestamp || new Date().toISOString()),
            });
          }
          break;
        }

        case 'email:new': {
          const d = event.data as {
            gmailId?: string; subject?: string; fromName?: string;
            fromAddress?: string; snippet?: string; isUnread?: boolean;
          };
          if (d.isUnread !== false) {
            useNotificationStore.getState().add({
              type: 'email',
              title: d.fromName || d.fromAddress || 'New email',
              body: d.subject || '(no subject)',
              source: 'gmail',
              timestamp: new Date().toISOString(),
            });
          }
          break;
        }

        case 'calendar:updated': {
          const d = event.data as { eventId?: string; title?: string };
          useNotificationStore.getState().add({
            type: 'calendar',
            title: 'Calendar update',
            body: d.title || 'An event was updated',
            source: 'calendar',
            timestamp: new Date().toISOString(),
          });
          break;
        }

        case 'ai:token': {
          const d = event.data as {
            sessionId: string; messageId: string; delta: string; done: boolean;
          };
          const store = useAiChatStore.getState();
          // Always append the delta first (the final chunk may carry the last token)
          store.appendToken(d.sessionId, d.messageId, d.delta);
          if (store.waiting[d.sessionId]) store.setWaiting(d.sessionId, false);
          if (d.done) {
            store.finalizeStream(d.sessionId, d.messageId);
          }
          break;
        }

        case 'ai:toolcall': {
          const d = event.data as { sessionId: string; toolCall: import('../lib/api').AiToolCall };
          useAiChatStore.getState().addToolCall(d.sessionId, d.toolCall);
          break;
        }

        case 'ai:message': {
          const d = event.data as { sessionId: string; message: import('../lib/api').AiMessage };
          const store = useAiChatStore.getState();
          if (d.message.role === 'user') {
            // Replace any optimistic placeholder for this user message
            store.replaceOptimisticMessage(d.sessionId, d.message);
          } else {
            const existing = store.messages[d.sessionId] || [];
            if (!existing.some((m) => m.id === d.message.id)) store.addMessage(d.sessionId, d.message);
          }
          break;
        }

        case 'ai:error': {
          const d = event.data as { sessionId: string; error: string };
          useAiChatStore.getState().setError(d.sessionId, d.error);
          useAiChatStore.getState().setWaiting(d.sessionId, false);
          break;
        }

        case 'update:available': {
          const d = event.data as import('../lib/api').UpdateStatus;
          useUpdateStore.getState().set(d);
          break;
        }
      }
    };

    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, [setStatus, setAllStatuses, setPendingCount, addItem, updateItem, setProgress, addMessage]);
}

export function sendWsMessage(data: unknown) {
  if (globalWs?.readyState === WebSocket.OPEN) {
    globalWs.send(JSON.stringify(data));
  }
}
