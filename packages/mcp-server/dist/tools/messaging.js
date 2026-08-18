/**
 * Chat-oriented tools: the chat tree, message history for one chat, and
 * contact lookup.
 */
import { z } from 'zod';
import { READ_ONLY, run } from './shared.js';
export function registerMessagingTools(server, client) {
    server.registerTool('conduit_list_chats', {
        title: 'List chats',
        description: 'The chat tree for every connected messaging service (Slack, Discord, Telegram, Twitter/X DMs, Gmail), ' +
            'grouped into sections (DMs, servers, channels). Each chat gives id, name, source, messageCount, lastTs ' +
            'and an `unread` count. Use it to resolve a chat NAME the user mentioned into the chatId that ' +
            'conduit_read_messages and conduit_queue_action need. ' +
            'It takes no filters and returns the whole tree, so prefer conduit_digest when you only want to know ' +
            'where the unread messages are.',
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => run(() => client.get('/api/chats')));
    server.registerTool('conduit_read_messages', {
        title: 'Read chat messages',
        description: 'Message history for ONE chat, newest first. Get chat_id from conduit_digest or conduit_list_chats. ' +
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
                .describe('Channel / conversation id from conduit_digest (chatId) or conduit_list_chats. Omitting it reads across all chats — almost always wrong.'),
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
    }, async ({ source, chat_id, limit, before, after, around, include_meta }) => run(() => client.get('/api/messages', {
        source,
        chat_id,
        limit,
        before,
        after,
        around,
        include_meta: include_meta ? 'true' : undefined,
    })));
    server.registerTool('conduit_contacts', {
        title: 'Find contacts',
        description: 'People the user talks to, across services, sorted by an activity score (most-engaged first). ' +
            'Use it to turn a name ("Priya") into the platform id needed to message someone, or to answer ' +
            '"who do I talk to most on Slack". Always pass `q` when you have a name — an unfiltered list is pure cost.',
        inputSchema: {
            q: z.string().optional().describe('Name or handle substring to match. Pass this whenever you know who you are looking for.'),
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
    }, async ({ q, source, criteria, limit, offset }) => run(() => client.get('/api/contacts', { q, source, criteria, limit, offset })));
}
//# sourceMappingURL=messaging.js.map