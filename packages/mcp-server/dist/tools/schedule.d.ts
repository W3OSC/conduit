/**
 * Calendar and Google Meet notes.
 *
 * Meet-note "summaries" are full meeting transcripts, so this module defaults
 * to a much smaller page size than the API's own default and requires a `from`
 * bound — an unbounded pull here is the single most expensive thing an agent
 * can do against Conduit.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConduitClient } from '../client.js';
export declare function registerScheduleTools(server: McpServer, client: ConduitClient): void;
//# sourceMappingURL=schedule.d.ts.map