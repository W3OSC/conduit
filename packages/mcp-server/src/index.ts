#!/usr/bin/env node
/**
 * Conduit MCP server (stdio).
 *
 * Exposes the user's Conduit hub — Slack, Discord, Telegram, Gmail, Calendar,
 * Meet notes, Twitter/X, Notion, Obsidian, Drive and SMB — to tool-native
 * agents, as an alternative to the REST + SKILL.md path.
 *
 * stdout belongs to the MCP protocol: everything we log goes to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { ConduitClient } from './client.js';
import { registerAllTools } from './tools/index.js';

const INSTRUCTIONS = [
  'Conduit is the user\'s self-hosted hub: it aggregates their Slack, Discord, Telegram, Gmail,',
  'Google Calendar/Meet/Drive, Twitter/X, Notion, Obsidian and SMB accounts behind one API.',
  '',
  'How to work with it:',
  '1. Start with conduit_digest. One call answers most "what needs my attention / catch me up"',
  '   questions; only drill into other tools for items it surfaces.',
  '2. Bound every list call — pass since/from/to and keep limit small. conduit_meet_notes is the',
  '   most expensive tool here (summaries are full transcripts) and requires a from window.',
  '3. Reads are direct, but EVERY write goes through conduit_queue_action, which only QUEUES the',
  '   action for the user to approve in the Conduit UI. Never claim you sent, posted or emailed',
  '   anything — say what you queued and that it is awaiting their approval.',
  '4. Read a file with conduit_read_file before proposing edits to it, and prefer a patch over a',
  '   full overwrite.',
  '5. Permissions are enforced per API key. A permission error means the user has not granted that',
  '   access — report it instead of retrying.',
  '6. All timestamps are ISO-8601 UTC.',
].join('\n');

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer(
    { name: 'conduit', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  registerAllTools(server, new ConduitClient(config));

  await server.connect(new StdioServerTransport());

  console.error(
    `[conduit-mcp] ready — hub ${config.baseUrl}, session ${config.sessionId}`,
  );
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) {
    console.error(`[conduit-mcp] configuration error\n\n${e.message}`);
    process.exit(1);
  }
  console.error('[conduit-mcp] fatal:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
