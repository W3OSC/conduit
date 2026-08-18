import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  useConnectionStore, useSyncStore, useMessageStreamStore,
  useNotificationStore, useUpdateStore,
} from '../store';
import { api } from '../lib/api';
import type { ConnectionStatus, Message } from '../lib/api';

const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

interface WsEvent {
  type: string;
  data: unknown;
}

let globalWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let listeners = new Set<(event: WsEvent) => void>();
let hadConnection = false;

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

// ── Throttled query invalidation ──────────────────────────────────────────────
// Realtime events mark query data stale so TanStack Query refetches whatever is
// currently on screen — but a busy channel or a running sync can fire dozens of
// events per second, so invalidations are coalesced per key prefix.

const INVALIDATE_THROTTLE_MS = 2_000;
const pendingInvalidations = new Map<string, ReturnType<typeof setTimeout>>();

function throttledInvalidate(queryClient: QueryClient, keyPrefix: readonly string[]): void {
  const mapKey = keyPrefix.join('/');
  if (pendingInvalidations.has(mapKey)) return; // already scheduled
  pendingInvalidations.set(mapKey, setTimeout(() => {
    pendingInvalidations.delete(mapKey);
    queryClient.invalidateQueries({ queryKey: keyPrefix as string[] });
  }, INVALIDATE_THROTTLE_MS));
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

    // Seed connection status — server fires connection:status events at startup,
    // which the browser would miss if it connects after those events fired.
    syncConnectionStatusFromServer();

    // Reconnect after a gap: anything may have changed while events were missed.
    if (hadConnection) {
      for (const listener of listeners) listener({ type: 'ws:reconnected', data: null });
    }
    hadConnection = true;
  };

  globalWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as WsEvent;
      for (const listener of listeners) {
        try { listener(msg); } catch { /* one bad listener must not block the rest */ }
      }
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
  const queryClient = useQueryClient();

  useEffect(() => {
    connectGlobal();

    // NOTE: all store writes go through getState() — this hook mounts at the
    // app root, and store *subscriptions* here would re-render the entire tree
    // on every event (the old behaviour: a full-tree render storm during sync).
    const handler = (event: WsEvent) => {
      switch (event.type) {

        case 'ws:reconnected': {
          // Synthetic local event fired after a dropped socket reconnects —
          // refresh the caches that realtime events normally keep current.
          queryClient.invalidateQueries({ queryKey: ['chats'] });
          queryClient.invalidateQueries({ queryKey: ['outbox'] });
          queryClient.invalidateQueries({ queryKey: ['inbox-gmail'] });
          queryClient.invalidateQueries({ queryKey: ['gmail-messages'] });
          queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
          break;
        }

        case 'connection:status': {
          const d = event.data as { service: string } & ConnectionStatus;
          useConnectionStore.getState().setStatus(d.service, d);
          throttledInvalidate(queryClient, ['connections']);
          break;
        }

        case 'sync:progress': {
          const d = event.data as {
            service: string; status: string;
            messagesSaved?: number; chatsVisited?: number; error?: string; type?: string;
          };
          useSyncStore.getState().setProgress(d.service, {
            service: d.service,
            status: d.status as 'running' | 'success' | 'error' | 'idle',
            type: d.type,
            messagesSaved: d.messagesSaved,
            chatsVisited: d.chatsVisited,
            error: d.error,
          });
          // A finished sync means new data — refresh the trees that show it.
          if (d.status === 'success') {
            throttledInvalidate(queryClient, ['chats']);
            throttledInvalidate(queryClient, ['status']);
          }
          break;
        }

        case 'outbox:new':
        case 'outbox:updated': {
          throttledInvalidate(queryClient, ['outbox']);
          if (event.type === 'outbox:updated') {
            const d = event.data as { id: number; status: string; recipientName?: string };
            if (d.status === 'sent') {
              useNotificationStore.getState().add({
                type: 'outbox',
                title: 'Message sent',
                body: d.recipientName ? `Your message to ${d.recipientName} was sent.` : 'Your message was sent.',
                timestamp: new Date().toISOString(),
              });
            }
          }
          break;
        }

        case 'message:new': {
          const msg = event.data as Message;
          useMessageStreamStore.getState().addMessage(msg);
          // Chat tree ordering + unread badges change with every message.
          throttledInvalidate(queryClient, ['chats']);

          const src = msg.source;
          const msgData = msg as unknown as Record<string, unknown>;
          const cid = String(msgData.chatId || msgData.channelId || '');
          if (src && cid) {
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

        case 'chat:read': {
          // Read cursor moved (this tab or another) — unread badges are stale.
          throttledInvalidate(queryClient, ['chats']);
          break;
        }

        case 'email:new': {
          const d = event.data as {
            gmailId?: string; subject?: string; fromName?: string;
            fromAddress?: string; snippet?: string; isUnread?: boolean;
          };
          // The notification used to fire while the list stayed stale for up
          // to a minute — now the visible email queries refresh too.
          throttledInvalidate(queryClient, ['inbox-gmail']);
          throttledInvalidate(queryClient, ['gmail-messages']);
          throttledInvalidate(queryClient, ['gmail-status']);
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

        case 'email:unread': {
          // Unread counts changed (sync or external read) — refresh badges.
          throttledInvalidate(queryClient, ['inbox-gmail']);
          throttledInvalidate(queryClient, ['gmail-status']);
          break;
        }

        case 'calendar:updated': {
          const d = event.data as { eventId?: string; title?: string };
          throttledInvalidate(queryClient, ['calendar-events']);
          throttledInvalidate(queryClient, ['inbox-calendar']);
          useNotificationStore.getState().add({
            type: 'calendar',
            title: 'Calendar update',
            body: d.title || 'An event was updated',
            source: 'calendar',
            timestamp: new Date().toISOString(),
          });
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
  }, [queryClient]);
}
