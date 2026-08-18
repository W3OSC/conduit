/** Registers every Conduit tool on an MCP server instance. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConduitClient } from '../client.js';
import { registerBriefingTools } from './briefing.js';
import { registerMessagingTools } from './messaging.js';
import { registerScheduleTools } from './schedule.js';
import { registerFileTools } from './files.js';
import { registerOutboxTools } from './outbox.js';

export function registerAllTools(server: McpServer, client: ConduitClient): void {
  registerBriefingTools(server, client);
  registerMessagingTools(server, client);
  registerScheduleTools(server, client);
  registerFileTools(server, client);
  registerOutboxTools(server, client);
}
