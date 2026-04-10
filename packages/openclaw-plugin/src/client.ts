/**
 * Conduit API client used by the OpenClaw channel plugin.
 *
 * Responsibilities:
 * - Verify the Conduit server is reachable and the API key is valid.
 * - Stream reply token chunks back to Conduit's session stream endpoint.
 */

export interface ConduitClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface StreamChunk {
  delta?: string;
  done: boolean;
  messageId?: string;
  toolCalls?: Array<{ name: string; input: unknown; output?: unknown }>;
}

export interface StreamChunkResponse {
  success: boolean;
  messageId: string;
}

/**
 * POST a single token chunk to Conduit's session stream endpoint.
 *
 * On the first chunk, omit `messageId` — Conduit returns one.
 * Pass the returned `messageId` on all subsequent chunks.
 * Send `{ done: true }` as the final chunk.
 */
export async function postStreamChunk(
  streamUrl: string,
  apiKey: string,
  chunk: StreamChunk,
): Promise<StreamChunkResponse> {
  const res = await fetch(streamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(chunk),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Conduit stream endpoint returned ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<StreamChunkResponse>;
}

/**
 * Send the full agent reply to Conduit as a stream of chunks.
 *
 * Splits `text` into ~200-character chunks so the Conduit UI renders
 * streaming output progressively. A final `{ done: true }` chunk closes
 * the stream.
 */
export async function streamReplyToConduit(
  streamUrl: string,
  apiKey: string,
  text: string,
): Promise<void> {
  const CHUNK_SIZE = 200;
  let messageId: string | undefined;

  // Split into chunks; keep at least one iteration for empty/done responses.
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }
  if (chunks.length === 0) chunks.push('');

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body: StreamChunk = {
      delta: chunks[i],
      done: isLast,
      ...(messageId ? { messageId } : {}),
    };
    const result = await postStreamChunk(streamUrl, apiKey, body);
    if (!messageId) messageId = result.messageId;
  }
}

/**
 * Verify that Conduit is reachable and the API key is valid.
 * Returns `{ ok: true }` on success, `{ ok: false, error }` on failure.
 */
export async function verifyConnection(config: ConduitClientConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${config.baseUrl}/api/connections`, {
      headers: { 'X-API-Key': config.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `Conduit returned ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
