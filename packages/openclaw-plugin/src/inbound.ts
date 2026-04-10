/**
 * Inbound webhook handler for the Conduit OpenClaw channel plugin.
 *
 * Conduit POSTs a payload here whenever a user sends a message in the
 * Conduit AI chat UI. This module parses that payload, dispatches it into
 * the OpenClaw agent session, and returns the agent's reply by streaming
 * chunks back to Conduit's session stream endpoint.
 *
 * Payload shape (from packages/server/src/api/ai.ts):
 * {
 *   sessionId:       string,   // Conduit AI session UUID
 *   messageId:       string,   // Conduit message UUID
 *   role:            "user",
 *   content:         string,   // User's message text
 *   conduitBaseUrl:  string,   // e.g. http://localhost:3101
 *   streamUrl:       string,   // e.g. http://localhost:3101/api/ai/sessions/<id>/stream
 *   systemPrompt?:   string,   // Injected on first message of each session
 * }
 */

import { streamReplyToConduit } from './client.js';

export interface ConduitInboundPayload {
  sessionId: string;
  messageId: string;
  role: 'user';
  content: string;
  conduitBaseUrl: string;
  streamUrl: string;
  systemPrompt?: string;
}

export interface DispatchFn {
  (payload: ConduitInboundPayload): Promise<string>;
}

/**
 * Validate and parse the raw request body as a ConduitInboundPayload.
 * Throws if required fields are missing.
 */
export function parseInboundPayload(body: unknown): ConduitInboundPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;

  const required = ['sessionId', 'messageId', 'role', 'content', 'conduitBaseUrl', 'streamUrl'] as const;
  for (const field of required) {
    if (typeof b[field] !== 'string' || !(b[field] as string).length) {
      throw new Error(`Missing or invalid field: ${field}`);
    }
  }

  return {
    sessionId:      b['sessionId'] as string,
    messageId:      b['messageId'] as string,
    role:           'user',
    content:        b['content'] as string,
    conduitBaseUrl: b['conduitBaseUrl'] as string,
    streamUrl:      b['streamUrl'] as string,
    systemPrompt:   typeof b['systemPrompt'] === 'string' ? b['systemPrompt'] : undefined,
  };
}

/**
 * Verify the inbound request's Authorization header against the configured
 * webhook secret. Returns true if verification passes or no secret is set.
 */
export function verifyWebhookSecret(
  authHeader: string | undefined,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret) return true;
  if (!authHeader) return false;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  // Constant-time comparison to prevent timing attacks.
  if (token.length !== expectedSecret.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expectedSecret.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Handle one inbound Conduit message:
 * 1. Dispatch it to the OpenClaw agent via `dispatch`.
 * 2. Stream the agent's reply back to Conduit.
 *
 * `dispatch` is injected from the channel entry point and calls the
 * OpenClaw agent runtime to produce a reply string.
 */
export async function handleConduitInbound(
  payload: ConduitInboundPayload,
  apiKey: string,
  dispatch: DispatchFn,
): Promise<void> {
  let replyText: string;

  try {
    replyText = await dispatch(payload);
  } catch (err) {
    replyText = `Error generating response: ${err instanceof Error ? err.message : String(err)}`;
  }

  await streamReplyToConduit(payload.streamUrl, apiKey, replyText);
}
