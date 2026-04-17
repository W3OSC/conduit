import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { createHash } from 'crypto';
import { parse as parseCookie } from 'cookie';
import { hashKey } from '../auth/middleware.js';
import { getDb } from '../db/client.js';
import { apiKeys, settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface WsEvent {
  type:
    | 'message:new'       // new chat message (discord/slack/telegram)
    | 'email:new'         // new Gmail message
    | 'calendar:updated'  // calendar event created/updated
    | 'unread:update'     // unread count + mute state push
    | 'sync:progress'     // sync job progress
    | 'outbox:new'        // new outbox item
    | 'outbox:updated'    // outbox item status change
    | 'connection:status' // service connection state change
    | 'test:result'       // connection test step result
    | 'ai:token'          // AI streaming token
    | 'ai:message'        // AI message complete
    | 'ai:error'          // AI error
    | 'update:available'  // new git commits available upstream
    | 'ping'
    | 'error';
  data: unknown;
}

/** Broadcast authoritative unread counts + mute state to all connected clients. */
export function broadcastUnread(updates: Array<{ source: string; chatId: string; count: number; isMuted?: boolean }>): void {
  if (updates.length === 0) return;
  broadcast({ type: 'unread:update', data: { updates } });
}

interface AuthedWsClient {
  ws: WebSocket;
  authenticated: boolean;
  id: string;
}

let wss: WebSocketServer | null = null;
const clients = new Map<string, AuthedWsClient>();
let clientCounter = 0;

export function initWebSocketServer(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const id = `ws_${++clientCounter}`;
    const client: AuthedWsClient = { ws, authenticated: false, id };

    const url = new URL(req.url || '/', `http://localhost`);

    // Auth option 1: API key in query string (?key=sk-arb-...)
    const queryKey = url.searchParams.get('key');
    if (queryKey && authenticateKey(queryKey)) {
      client.authenticated = true;
    }

    // Auth option 2: UI session token in cookie (for browser UI connections)
    if (!client.authenticated) {
      const cookieHeader = req.headers['cookie'] || '';
      const cookies = parseCookie(cookieHeader);
      const sessionToken = cookies['conduit-session'] || url.searchParams.get('session') || '';
      if (sessionToken && authenticateUiSession(sessionToken)) {
        client.authenticated = true;
      }
    }

    // Auth option 3: UI login disabled → allow all connections (consistent with HTTP behaviour)
    if (!client.authenticated && isUiAuthDisabled()) {
      client.authenticated = true;
    }

    clients.set(id, client);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'auth') {
          // Post-connection auth: accept API key OR UI session token
          const authenticated =
            (msg.key && authenticateKey(msg.key)) ||
            (msg.sessionToken && authenticateUiSession(msg.sessionToken)) ||
            isUiAuthDisabled();
          if (authenticated) {
            client.authenticated = true;
            ws.send(JSON.stringify({ type: 'auth', data: { success: true } }));
          } else {
            ws.send(JSON.stringify({ type: 'auth', data: { success: false } }));
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'ping', data: { pong: true } }));
        }
      } catch { /* ignore malformed messages */ }
    });

    ws.on('close', () => { clients.delete(id); });
    ws.on('error', () => { clients.delete(id); });

    ws.send(JSON.stringify({ type: 'connected', data: { id } }));
  });

  console.log('[ws] WebSocket server initialized');
}

function authenticateKey(raw: string): boolean {
  const db = getDb();
  const hash = hashKey(raw);
  const key = db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).get();
  return !!(key && !key.revokedAt);
}

function authenticateUiSession(token: string): boolean {
  try {
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.key, 'ui.auth')).get();
    if (!row) return false;
    const cfg = JSON.parse(row.value) as {
      enabled: boolean;
      sessionTokenHash?: string;
      sessionExpiry?: string;
    };
    if (!cfg.enabled || !cfg.sessionTokenHash || !cfg.sessionExpiry) return false;
    if (new Date(cfg.sessionExpiry) < new Date()) return false;
    const hash = createHash('sha256').update(token).digest('hex');
    return hash === cfg.sessionTokenHash;
  } catch {
    return false;
  }
}

function isUiAuthDisabled(): boolean {
  try {
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.key, 'ui.auth')).get();
    if (!row) return true; // no config → auth not set up → open
    const cfg = JSON.parse(row.value) as { enabled: boolean };
    return !cfg.enabled;
  } catch {
    return true;
  }
}

// ── Internal server-side broadcast listeners ──────────────────────────────────
// Allow server code (e.g. the test runner) to subscribe to broadcast events
// without going through a WebSocket client connection.

const internalListeners = new Set<(event: WsEvent) => void>();

export function broadcast(event: WsEvent): void {
  if (!wss) return;
  const payload = JSON.stringify(event);
  for (const client of clients.values()) {
    if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
  for (const fn of internalListeners) {
    try { fn(event); } catch { /* ignore */ }
  }
}

/**
 * Returns a Promise that resolves with the first broadcast event matching
 * the given predicate, or rejects after timeoutMs ms.
 * Used by the connection test runner.
 */
export function onNextBroadcast(
  predicate: (event: WsEvent) => boolean,
  timeoutMs = 10000,
): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      internalListeners.delete(fn);
      reject(new Error('Timed out waiting for realtime event'));
    }, timeoutMs);

    function fn(event: WsEvent) {
      if (predicate(event)) {
        clearTimeout(timer);
        internalListeners.delete(fn);
        resolve(event);
      }
    }

    internalListeners.add(fn);
  });
}

/**
 * Collects broadcast events matching `predicate` until `isDone` returns true
 * for one of the collected events, then resolves with the full array.
 * Rejects after timeoutMs ms if `isDone` is never satisfied.
 */
export function collectBroadcast(
  predicate: (event: WsEvent) => boolean,
  isDone: (event: WsEvent) => boolean,
  timeoutMs = 15000,
): Promise<WsEvent[]> {
  return new Promise((resolve, reject) => {
    const collected: WsEvent[] = [];

    const timer = setTimeout(() => {
      internalListeners.delete(fn);
      reject(new Error('Timed out waiting for realtime event'));
    }, timeoutMs);

    function fn(event: WsEvent) {
      if (predicate(event)) {
        collected.push(event);
        if (isDone(event)) {
          clearTimeout(timer);
          internalListeners.delete(fn);
          resolve(collected);
        }
      }
    }

    internalListeners.add(fn);
  });
}

export function getConnectedCount(): number {
  return clients.size;
}
