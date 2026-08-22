/**
 * The write path — which is not really a write path.
 *
 * Everything an agent "sends" is queued as a pending outbox item and executes
 * only after the user approves it in the Conduit UI. Each POST carries a fresh
 * Idempotency-Key so a retry after a timeout returns the original item instead
 * of queueing a duplicate.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConduitClient } from '../client.js';
export declare function registerOutboxTools(server: McpServer, client: ConduitClient): void;
//# sourceMappingURL=outbox.d.ts.map