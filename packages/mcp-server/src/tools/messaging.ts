/**
 * Chat-oriented tools: the chat tree, message history for one chat, and
 * contact lookup.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConduitClient } from '../client.js';
import { READ_ONLY, run } from './shared.js';

export function registerMessagingTools(server: McpServer, client: ConduitClient): void {
  server.registerTool(
    'conduit_list_chats',
    {
      title: 'List chats',
      description:
        'The chat tree for every connected messaging service (Slack, Discord, Telegram, Twitter/X DMs, Gmail), ' +
        'grouped into sections (DMs, servers, channels). Each chat gives id, name, source, messageCount, lastTs ' +
        'and an `unread` count. Use it to resolve a chat NAME the user mentioned into the chatId that ' +
        'conduit_read_messages and conduit_queue_action need. ' +
        'It takes no filters and returns the whole tree, so prefer conduit_digest when you only want to know ' +
        'where the unread messages are.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => run(() => client.get('/api/chats')),
  );

  server.registerTool(
    'conduit_read_messages',
    {
      title: 'Read chat messages',
      description:
        'Message history for ONE chat, newest first. Get chat_id from conduit_digest or conduit_list_chats. ' +
        'Bound every call: keep limit small (20-50 is usually enough to answer "what did they say") and page ' +
        'backwards with `before` rather than raising limit. ' +
        'There is no text-search or offset parameter here — use conduit_search to find a message, then read around it.',
      inputSchema: {
        source: z
          .enum(['slack', 'discord', 'telegram', 'twitter', 'gmail'])
          .optional()
          .describe('Service to read from. Omit only if you want every source (rarely useful).'),
        chat_id: z
          .string()
          .optional()
          .describe(
            'Channel / conversation id from conduit_digest (chatId) or conduit_list_chats. Omitting it reads across all chats — almost always wrong.',
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Max messages. Default 50, hard max 500. Prefer 20-50.'),
        before: z
          .string()
          .optional()
          .describe('ISO-8601 timestamp; return messages at or before this. Use for backwards paging.'),
        after: z
          .string()
          .optional()
          .describe('ISO-8601 timestamp; return messages at or after this.'),
        around: z
          .string()
          .optional()
          .describe('ISO-8601 timestamp; return a window centred on this moment (half before, half after).'),
        include_meta: z
          .boolean()
          .optional()
          .describe('Include extra per-message metadata. Costs tokens — leave off unless needed.'),
      },
      annotations: READ_ONLY,
    },
    async ({ source, chat_id, limit, before, after, around, include_meta }) =>
      run(() =>
        client.get('/api/messages', {
          source,
          chat_id,
          limit,
          before,
          after,
          around,
          include_meta: include_meta ? 'true' : undefined,
        }),
      ),
  );

  server.registerTool(
    'conduit_contacts',
    {
      title: 'Find contacts',
      description:
        'People the user talks to, across services, sorted by an activity score (most-engaged first). ' +
        'Use it to turn a name ("Priya") into the platform id needed to message someone, or to answer ' +
        '"who do I talk to most on Slack". Always pass `q` when you have a name — an unfiltered list is pure cost. ' +
        'For matching an external identity (lead, attendee) with name+domain+email, prefer conduit_resolve_identity.',
      inputSchema: {
        q: z.string().optional().describe('Case-insensitive substring matched against display name, username, first/last name, phone and email. Pass this whenever you know who you are looking for.'),
        source: z
          .enum(['slack', 'discord', 'telegram', 'twitter', 'gmail'])
          .optional()
          .describe('Restrict to one service.'),
        criteria: z
          .enum(['dm', 'owned', 'small', 'native'])
          .optional()
          .describe('Optional contact-class filter: dm | owned | small | native.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Max contacts. Default 50, hard max 500. Prefer 10-25 with a `q`.'),
        offset: z.number().int().min(0).optional().describe('Paging offset. Default 0.'),
      },
      annotations: READ_ONLY,
    },
    async ({ q, source, criteria, limit, offset }) =>
      run(() => client.get('/api/contacts', { q, source, criteria, limit, offset, fields: 'lean' })),
  );

  server.registerTool(
    'conduit_resolve_identity',
    {
      title: 'Resolve an identity to contacts',
      description:
        'Match an external person (a CRM lead, a meeting attendee, an email signature) to the contacts this hub ' +
        'knows, using any combination of name, email, domain, handle, phone and company. Returns ranked candidates ' +
        'with a confidence score, the fields that matched, DM availability and the sendable dmChatId where a direct ' +
        'conversation exists. An empty list explicitly means no connected account has seen that identity — ' +
        'check the coverage block before concluding the person is unknown.',
      inputSchema: {
        name: z.string().optional().describe('Person name, e.g. "Nathan".'),
        email: z.string().optional().describe('Email address (exact, case-insensitive).'),
        domain: z.string().optional().describe('Company domain, e.g. "symbiosis.finance".'),
        handle: z.string().optional().describe('Platform handle, with or without @.'),
        phone: z.string().optional().describe('Phone number in any format.'),
        company: z.string().optional().describe('Company name.'),
        sources: z
          .array(z.enum(['slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar']))
          .optional()
          .describe('Restrict to these services (default: all).'),
        limit: z.number().int().positive().max(25).optional().describe('Max candidates. Default 5.'),
      },
      annotations: READ_ONLY,
    },
    async (body) => run(() => client.post('/api/contacts/resolve', body)),
  );

  server.registerTool(
    'conduit_contact_chats',
    {
      title: 'List chats a contact participates in',
      description:
        'Every chat a contact participates in (chatId, chatType, last activity, message count), with direct DMs ' +
        'flagged isDm. Use the DM entry\'s chatId as the recipient_id for conduit_queue_action / the outbox. ' +
        'Get source + platformId from conduit_contacts or conduit_resolve_identity.',
      inputSchema: {
        source: z.enum(['slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar']).describe('Contact source platform.'),
        platform_id: z.string().describe('The contact\'s platformId on that source.'),
        limit: z.number().int().positive().max(200).optional().describe('Max chats. Default 50.'),
      },
      annotations: READ_ONLY,
    },
    async ({ source, platform_id, limit }) =>
      run(() =>
        client.get(
          `/api/contacts/${encodeURIComponent(source)}/${encodeURIComponent(platform_id)}/chats`,
          { limit },
        ),
      ),
  );
}
