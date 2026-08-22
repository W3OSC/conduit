/**
 * Cross-service orientation tools: digest (the cheap first call), the raw
 * activity feed, and text search.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConduitClient } from '../client.js';
import { READ_ONLY, run } from './shared.js';

export function registerBriefingTools(server: McpServer, client: ConduitClient): void {
  server.registerTool(
    'conduit_digest',
    {
      title: 'Attention digest',
      description:
        'THE CHEAP FIRST CALL — start here for "what needs my attention", "what should I follow up on", ' +
        '"catch me up", or any open-ended question about the user\'s inbox and day. ' +
        'One bounded response (~2k tokens) that replaces the 6-20 raw list pulls it would otherwise take, containing: ' +
        'needsReply (chats whose latest message is from someone else and is newer than the read cursor, max 15), ' +
        'unreadEmail (count + top senders + latest subjects), ' +
        'upcomingEvents (next 7 days, max 10), ' +
        'recentMeetings (meeting-note excerpts, max 10), ' +
        'pendingOutbox (actions awaiting the user\'s approval), and unreadBySource (per-service unread totals). ' +
        'Only drill into the other tools for specific items the digest surfaced — do NOT open by pulling raw message lists. ' +
        'Results are already scoped to what the user granted this API key.',
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe(
            'ISO-8601 timestamp bounding the needs-reply scan. Default: 24 hours ago. Widen only if the user asks about a longer period.',
          ),
        meetings_days: z
          .number()
          .int()
          .positive()
          .max(60)
          .optional()
          .describe('How many days back to include meeting notes. Default 14, max 60.'),
      },
      annotations: READ_ONLY,
    },
    async ({ since, meetings_days }) =>
      run(() => client.get('/api/digest', { since, meetings_days })),
  );

  server.registerTool(
    'conduit_activity',
    {
      title: 'Activity feed',
      description:
        'Chronological cross-service feed of chat messages and email in a time window, newest first. ' +
        'Call conduit_digest FIRST — use this only when the user genuinely wants a raw timeline ("what happened while I was out") ' +
        'rather than a summary of what needs action. Always bound it: keep the since/until window tight and the limit small, ' +
        'then fetch more if needed. Each item includes source, timestamp, chatId, chatName, senderName, content and isMe.',
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe('ISO-8601 start of the window. Default: 24 hours ago.'),
        until: z.string().optional().describe('ISO-8601 end of the window. Default: now.'),
        sources: z
          .string()
          .optional()
          .describe(
            'Comma-separated subset of: slack, discord, telegram, twitter, gmail. Default: all the key may read. ' +
              'Sources the key cannot read are silently omitted rather than erroring.',
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('Max items. Default 50, hard max 200. Prefer 20-50.'),
      },
      annotations: READ_ONLY,
    },
    async ({ since, until, sources, limit }) =>
      run(() => client.get('/api/activity', { since, until, sources, limit })),
  );

  server.registerTool(
    'conduit_search',
    {
      title: 'Search messages and email',
      description:
        'Substring search across chat messages and email. Use it to find a specific known thing ' +
        '(a person\'s name, a project, an order number) — not to browse. ' +
        'Matching is plain substring (LIKE), not semantic: use short distinctive keywords, not sentences, ' +
        'and retry with a different keyword rather than a longer one if nothing matches. ' +
        'Each result carries its source plus that service\'s message fields.',
      inputSchema: {
        q: z.string().min(1).describe('Required. Short distinctive keyword or phrase to match.'),
        source: z
          .enum(['slack', 'discord', 'telegram', 'twitter', 'gmail'])
          .optional()
          .describe('Restrict to one service. Omit to search all the key may read.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('Max results. Default 50, hard max 200.'),
      },
      annotations: READ_ONLY,
    },
    async ({ q, source, limit }) => run(() => client.get('/api/search', { q, source, limit })),
  );
}
