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
export declare function ok(data: unknown): CallToolResult;
/** Wrap a failure so the model sees the reason instead of a protocol error. */
export declare function fail(message: string): CallToolResult;
/**
 * Run a tool body, converting thrown errors (including Conduit's 403 guidance)
 * into an `isError` result the agent can read and act on.
 */
export declare function run(fn: () => Promise<unknown>): Promise<CallToolResult>;
/** Annotations for tools that only read. */
export declare const READ_ONLY: {
    readonly readOnlyHint: true;
    readonly destructiveHint: false;
    readonly idempotentHint: true;
    readonly openWorldHint: true;
};
/** Annotations for the outbox write path (queues, never sends). */
export declare const QUEUES_WRITE: {
    readonly readOnlyHint: false;
    readonly destructiveHint: false;
    readonly idempotentHint: false;
    readonly openWorldHint: true;
};
//# sourceMappingURL=shared.d.ts.map