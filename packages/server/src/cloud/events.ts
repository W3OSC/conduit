/**
 * Event relay slimming — forwards broadcasts whose topic starts with
 * "outbox:", "message:" or "reaction:" over the cloud socket as accelerants
 * for the cloud's 300s reconciliation poll. The payload must never carry a
 * message body: only identifiers and status. Reaction events are the one
 * self-contained case — they are not pullable afterwards (reactions are not
 * stored), so their full-but-tiny payload (channel, ts, emoji, uid) rides
 * the relay directly.
 */

import type { WsEvent } from '../websocket/hub.js';

const RELAYED_PREFIXES = ['outbox:', 'message:', 'reaction:'];

/** Identifier/status fields only — deliberately excludes content/text/body. */
const ALLOWED_PAYLOAD_KEYS = [
  'id', 'batchId', 'count', 'status', 'source', 'messageId', 'channelId', 'error',
  'threadTs', 'messageTs', 'emoji', 'userId', 'itemUserId',
] as const;

export function shouldRelayEvent(event: WsEvent): boolean {
  return RELAYED_PREFIXES.some((prefix) => event.type.startsWith(prefix));
}

export function slimEventPayload(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_PAYLOAD_KEYS) {
    if (key in src) out[key] = src[key];
  }
  return out;
}
