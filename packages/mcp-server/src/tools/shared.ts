/**
 * Shared plumbing for tool handlers: compact JSON results and uniform error
 * reporting.
 *
 * Results are serialised without indentation on purpose — these tools exist to
 * be token-efficient, and pretty-printing a digest costs ~15% more tokens for
 * no benefit to a model.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Wrap a successful payload as MCP text content. */
export function ok(data: unknown): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text: text || '(empty response)' }] };
}

/** Wrap a failure so the model sees the reason instead of a protocol error. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Run a tool body, converting thrown errors (including Conduit's 403 guidance)
 * into an `isError` result the agent can read and act on.
 */
export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Annotations for tools that only read. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Annotations for the outbox write path (queues, never sends). */
export const QUEUES_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
