/**
 * OpenAPI 3.0 spec for the Conduit API — agent-relevant endpoints only.
 *
 * This spec is designed for AI agents (Claude, OpenClaw, etc.) and covers
 * all read, search, send, and context-gathering endpoints. Admin/setup routes
 * (credentials, service resets, sync management) are intentionally excluded.
 */

import { Router } from 'express';
const router = Router();

router.get('/openapi.json', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  res.json({
    openapi: '3.0.0',
    info: {
      title: 'Conduit',
      version: '1.0.0',
      description: `Conduit is a personal messaging hub that aggregates Slack, Discord, Telegram, Twitter/X, Gmail, and Google Calendar into a single API. Use it to read message history, search conversations, understand contact relationships, send messages through an approval outbox, and manage email and calendar — all from one place. Base URL: ${baseUrl}/api`,
    },
    servers: [{ url: `${baseUrl}/api`, description: 'Conduit API' }],
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Generate an API key in Conduit Settings → Permissions. Pass it as the X-API-Key header on every request.',
        },
      },
      schemas: {
        Message: {
          type: 'object',
          description: 'A single message from any connected platform',
          properties: {
            source:        { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail'], description: 'The platform this message came from' },
            messageId:     { type: 'string', description: 'Platform-native message ID' },
            chatId:        { type: 'string', description: 'ID of the conversation/channel/thread this message belongs to' },
            chatName:      { type: 'string', nullable: true, description: 'Human-readable name of the conversation (channel name, DM partner name, email subject)' },
            content:       { type: 'string', description: 'Message text or email snippet' },
            senderName:    { type: 'string', description: 'Display name of the sender, resolved from contacts table when available' },
            senderAvatarUrl: { type: 'string', nullable: true },
            isMe:          { type: 'boolean', description: 'True when this message was sent by the authenticated Conduit user' },
            timestamp:     { type: 'string', format: 'date-time' },
          },
        },
        ActivityItem: {
          type: 'object',
          description: 'A single activity event — either a message or an email',
          properties: {
            type:       { type: 'string', enum: ['message', 'email'] },
            source:     { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail'] },
            timestamp:  { type: 'string', format: 'date-time' },
            messageId:  { type: 'string' },
            chatId:     { type: 'string' },
            chatName:   { type: 'string', nullable: true },
            content:    { type: 'string', description: 'Message text or email snippet' },
            senderName: { type: 'string' },
            isMe:       { type: 'boolean' },
            context:    { type: 'string', enum: ['dm', 'group', 'channel'], description: 'Whether this was in a DM, a group chat, or a channel' },
            subject:    { type: 'string', nullable: true, description: 'Email subject (only present for type=email)' },
            isRead:     { type: 'boolean', description: 'Email read state (only present for type=email)' },
          },
        },
        Contact: {
          type: 'object',
          description: 'A person you have communicated with across any connected platform',
          properties: {
            source:        { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail'] },
            platformId:    { type: 'string', description: 'The user\'s ID on their platform' },
            displayName:   { type: 'string', nullable: true },
            username:      { type: 'string', nullable: true },
            phone:         { type: 'string', nullable: true },
            avatarUrl:     { type: 'string', nullable: true },
            bio:           { type: 'string', nullable: true },
            mutualGroupIds: { type: 'array', items: { type: 'string' }, description: 'IDs of groups/channels you both participate in' },
            criteria: {
              type: 'object',
              properties: {
                hasDm:            { type: 'boolean', description: 'You have exchanged DMs with this person' },
                isFromSmallGroup: { type: 'boolean', description: 'You share a small group with this person' },
                isNativeContact:  { type: 'boolean', description: 'This person is in your platform contact list' },
              },
            },
            lastMessageAt:  { type: 'string', format: 'date-time', nullable: true },
            activityScore:  { type: 'number', description: 'Computed engagement score: DM messages × 3 + shared channel messages × 1. Higher = more active relationship.' },
            messageCount:   { type: 'number', description: 'Total messages from this contact in the local database' },
          },
        },
        Tweet: {
          type: 'object',
          description: 'A single tweet or retweet',
          properties: {
            id:          { type: 'string', description: 'Tweet ID — use for reply/quote/retweet/like actions' },
            text:        { type: 'string', description: 'Full tweet text' },
            authorName:  { type: 'string', description: 'Display name of the tweet author' },
            authorHandle:{ type: 'string', description: 'Twitter @handle of the author (without the @)' },
            authorId:    { type: 'string', description: 'Numeric Twitter user ID of the author' },
            timestamp:   { type: 'string', format: 'date-time' },
            likes:       { type: 'integer' },
            retweets:    { type: 'integer' },
            replies:     { type: 'integer' },
            isRetweet:   { type: 'boolean' },
            quotedTweetId: { type: 'string', nullable: true, description: 'If this is a quote tweet, the ID of the quoted tweet' },
            replyToId:   { type: 'string', nullable: true, description: 'If this is a reply, the ID of the parent tweet' },
            isMe:        { type: 'boolean', description: 'True if this tweet was posted by the authenticated user' },
          },
        },
        OutboxItem: {
          type: 'object',
          properties: {
            id:            { type: 'integer' },
            source:        { type: 'string' },
            recipientId:   { type: 'string' },
            recipientName: { type: 'string', nullable: true },
            content:       { type: 'string' },
            status:        { type: 'string', enum: ['pending', 'approved', 'sent', 'rejected', 'failed'] },
            createdAt:     { type: 'string', format: 'date-time' },
            sentAt:        { type: 'string', format: 'date-time', nullable: true },
          },
        },
      },
    },
    paths: {

      // ── Context & Activity ───────────────────────────────────────────────────

      '/activity': {
        get: {
          operationId: 'getActivity',
          summary: 'Get unified recent activity feed',
          description: 'Returns a chronological feed of recent messages and emails across all connected platforms. This is the primary endpoint for understanding what has been happening — use it to get context before taking action, identify conversations that need attention, or understand the user\'s recent communication patterns. Results are sorted newest-first and interleaved across all services.',
          parameters: [
            {
              name: 'since',
              in: 'query',
              description: 'Start of the time window (ISO 8601). Defaults to 24 hours ago. Use this to ask "what happened in the last week" or "what happened since Monday".',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-04-01T00:00:00Z',
            },
            {
              name: 'until',
              in: 'query',
              description: 'End of the time window (ISO 8601). Defaults to now.',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'limit',
              in: 'query',
              description: 'Maximum number of items to return. Default 50, max 200.',
              schema: { type: 'integer', default: 50, maximum: 200 },
            },
            {
              name: 'sources',
              in: 'query',
              description: 'Comma-separated list of platforms to include. Defaults to all. Options: slack, discord, telegram, twitter, gmail.',
              schema: { type: 'string' },
              example: 'slack,discord,telegram',
            },
          ],
          responses: {
            '200': {
              description: 'Unified activity feed sorted by timestamp descending',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      items:  { type: 'array', items: { $ref: '#/components/schemas/ActivityItem' } },
                      total:  { type: 'integer', description: 'Total items in the window before limit is applied' },
                      since:  { type: 'string', format: 'date-time' },
                      until:  { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/status': {
        get: {
          operationId: 'getStatus',
          summary: 'Get service connection status and message counts',
          description: 'Returns connection status for all platforms, total message counts in the local database, and information about any currently-running syncs. Use this to understand which platforms are active and how much data is available.',
          responses: {
            '200': {
              description: 'Status object with per-service message counts, chat counts, and sync state',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    description: 'Keys are platform names. Each value describes that service\'s connection and data state.',
                    additionalProperties: {
                      type: 'object',
                      properties: {
                        connected:     { type: 'boolean', description: 'Whether this service is currently connected and receiving messages' },
                        messageCount:  { type: 'integer', description: 'Total messages stored locally for this service' },
                        chatCount:     { type: 'integer', description: 'Number of distinct conversations stored for this service' },
                        lastSync:      { type: 'string', format: 'date-time', nullable: true, description: 'Timestamp of the most recent successful sync' },
                        activeSyncs:   { type: 'integer', description: 'Number of sync operations currently running for this service' },
                        error:         { type: 'string', nullable: true, description: 'Most recent error message, if any' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/connections': {
        get: {
          operationId: 'getConnections',
          summary: 'Get connection state for all services',
          description: 'Returns the live connection state for every configured platform. Use this before making platform-specific calls to confirm a service is connected. A service that is not connected will not return real-time data.',
          responses: {
            '200': {
              description: 'Connection states for all services',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        service:    { type: 'string', enum: ['slack', 'discord', 'telegram', 'gmail', 'calendar', 'twitter'], description: 'Platform name' },
                        connected:  { type: 'boolean', description: 'True if the service is actively connected' },
                        status:     { type: 'string', enum: ['connected', 'connecting', 'disconnected', 'error'], description: 'Detailed connection state' },
                        error:      { type: 'string', nullable: true, description: 'Error message when status=error' },
                        lastSync:   { type: 'string', format: 'date-time', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ── Messages ─────────────────────────────────────────────────────────────

      '/messages': {
        get: {
          operationId: 'getMessages',
          summary: 'Get messages from a specific conversation or across all conversations',
          description: 'Fetch messages from the local database. Can retrieve a specific conversation (use chat_id) or all recent messages across all platforms (omit chat_id). Supports cursor-based pagination with before/after. Sender information is enriched from the contacts database. Use `include_meta=true` to get participant information about the conversation.',
          parameters: [
            {
              name: 'source',
              in: 'query',
              description: 'Filter to a specific platform. If omitted, returns messages from all platforms.',
              schema: { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail'] },
            },
            {
              name: 'chat_id',
              in: 'query',
              description: 'The conversation/channel/thread ID to fetch messages from. Get these IDs from GET /chats. If omitted, returns messages across all conversations for the given time range.',
              schema: { type: 'string' },
              example: 'C04ABCD1234',
            },
            {
              name: 'limit',
              in: 'query',
              description: 'Number of messages to return. Default 50, max 500.',
              schema: { type: 'integer', default: 50, maximum: 500 },
            },
            {
              name: 'before',
              in: 'query',
              description: 'Return only messages before this ISO timestamp. Use for pagination: pass the timestamp of the oldest message in the previous page.',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'after',
              in: 'query',
              description: 'Return only messages after this ISO timestamp. Use to fetch everything since a specific date.',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-04-01T00:00:00Z',
            },
            {
              name: 'around',
              in: 'query',
              description: 'Return messages centred on this ISO timestamp (half before, half after). Used for navigating to a specific message.',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'include_meta',
              in: 'query',
              description: 'When true and chat_id is provided, includes a conversationMeta object with the conversation name, type (dm/group/channel), and participant list. Useful for providing context about who is in a conversation.',
              schema: { type: 'boolean' },
            },
          ],
          responses: {
            '200': {
              description: 'Messages from the requested conversation or time range',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
                      total:    { type: 'integer' },
                      conversationMeta: {
                        type: 'object',
                        nullable: true,
                        description: 'Present only when include_meta=true and chat_id is specified',
                        properties: {
                          chatId:   { type: 'string' },
                          chatName: { type: 'string', nullable: true },
                          source:   { type: 'string' },
                          type:     { type: 'string', enum: ['dm', 'group', 'channel'] },
                          participants: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                platformId:   { type: 'string' },
                                displayName:  { type: 'string' },
                                avatarUrl:    { type: 'string', nullable: true },
                                isMe:         { type: 'boolean' },
                                messageCount: { type: 'integer' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/search': {
        get: {
          operationId: 'searchMessages',
          summary: 'Full-text search across all messages',
          description: 'Search the local message database across all platforms by keyword. Returns matching messages sorted by recency. Use this to find conversations about a specific topic, locate a message you remember, or understand what has been discussed around a particular subject.',
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: true,
              description: 'Search query string. Searches message content/text across all platforms.',
              schema: { type: 'string' },
              example: 'project deadline',
            },
            {
              name: 'source',
              in: 'query',
              description: 'Filter to a specific platform.',
              schema: { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail'] },
            },
            {
              name: 'limit',
              in: 'query',
              description: 'Maximum results. Default 50, max 200.',
              schema: { type: 'integer', default: 50, maximum: 200 },
            },
          ],
          responses: {
            '200': {
              description: 'Matching messages from all platforms',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      results: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/chats': {
        get: {
          operationId: 'getChats',
          summary: 'Get all conversations organised by platform and type',
          description: 'Returns a structured tree of all synced conversations grouped by platform (Slack, Discord, Telegram, Twitter, Gmail) and then by type (DMs, Channels, Servers). Each conversation entry includes its ID, name, message count, and last activity timestamp. Use this to discover what conversations exist and get the chat_id values needed for GET /messages.',
          responses: {
            '200': {
              description: 'Conversation tree organised by platform and section type',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    description: 'Keys are platform names (slack, discord, telegram, twitter, gmail). Each value has a sections array.',
                    additionalProperties: {
                      type: 'object',
                      properties: {
                        source: { type: 'string' },
                        sections: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              label: { type: 'string', example: 'Direct Messages' },
                              type:  { type: 'string', enum: ['dms', 'channels', 'server', 'flat'] },
                              chats: {
                                type: 'array',
                                items: {
                                  type: 'object',
                                  properties: {
                                    id:           { type: 'string', description: 'Use as chat_id in GET /messages' },
                                    name:         { type: 'string' },
                                    source:       { type: 'string' },
                                    messageCount: { type: 'integer' },
                                    lastTs:       { type: 'string', format: 'date-time', nullable: true },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/unread/{service}/{chatId}/read': {
        post: {
          operationId: 'markChatRead',
          summary: 'Mark a conversation as read on the platform',
          description: 'Signals to the platform that all messages in this conversation have been read. This clears the unread badge in the platform app. Use this after an agent has processed and responded to a conversation to keep the user\'s read state clean.',
          parameters: [
            {
              name: 'service', in: 'path', required: true,
              schema: { type: 'string', enum: ['slack', 'discord', 'telegram'] },
              description: 'The platform that owns this conversation',
            },
            {
              name: 'chatId', in: 'path', required: true,
              schema: { type: 'string' },
              description: 'The conversation ID to mark as read (from GET /chats)',
            },
          ],
          responses: {
            '200': {
              description: 'Conversation marked as read',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ── Contacts ─────────────────────────────────────────────────────────────

      '/contacts': {
        get: {
          operationId: 'listContacts',
          summary: 'List contacts sorted by relationship strength',
          description: 'Returns contacts from all platforms sorted by activity score (DM messages × 3 + shared channel participation × 1). The most actively communicated-with people appear first. Use this to understand the user\'s key relationships, identify their closest collaborators, or find someone by name before looking up their conversation history.',
          parameters: [
            {
              name: 'source',
              in: 'query',
              description: 'Filter to a specific platform.',
              schema: { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail'] },
            },
            {
              name: 'q',
              in: 'query',
              description: 'Search by display name, username, first name, or last name.',
              schema: { type: 'string' },
              example: 'Alice',
            },
            {
              name: 'criteria',
              in: 'query',
              description: 'Filter by how the contact was discovered: dm (has a DM conversation), owned (from a group you own), small (from a small group), native (in your platform contacts list).',
              schema: { type: 'string', enum: ['dm', 'owned', 'small', 'native'] },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 50, maximum: 500 },
            },
            {
              name: 'offset',
              in: 'query',
              schema: { type: 'integer', default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'Contacts sorted by activity score',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      contacts: { type: 'array', items: { $ref: '#/components/schemas/Contact' } },
                      total:    { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/contacts/{source}/{platformId}': {
        get: {
          operationId: 'getContact',
          summary: 'Get a specific contact\'s full profile',
          description: 'Returns complete profile information for a contact, including all metadata, mutual groups, and relationship criteria. Use this when you have a platformId and need their display name, avatar, bio, or to understand what groups you share.',
          parameters: [
            {
              name: 'source',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail'] },
            },
            {
              name: 'platformId',
              in: 'path',
              required: true,
              description: 'The contact\'s platform-native user ID',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Contact profile',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Contact' } } },
            },
            '404': { description: 'Contact not found in local database' },
          },
        },
      },

      '/contacts/{source}/{platformId}/history': {
        get: {
          operationId: 'getContactHistory',
          summary: 'Get all messages from a specific contact',
          description: 'Returns every message from this person that exists in the local database — across DMs and any shared groups/channels. Sorted by most recent first. Use this to understand the full history of communication with a specific person, identify outstanding tasks or commitments, or get context before composing a reply.',
          parameters: [
            {
              name: 'source', in: 'path', required: true,
              schema: { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail'] },
            },
            {
              name: 'platformId', in: 'path', required: true,
              description: 'The contact\'s platform user ID',
              schema: { type: 'string' },
            },
            {
              name: 'limit', in: 'query',
              description: 'Maximum messages to return. Default 100, max 500.',
              schema: { type: 'integer', default: 100, maximum: 500 },
            },
            {
              name: 'after', in: 'query',
              description: 'Return only messages from this contact after this ISO timestamp. Use to get "what has this person said to me since last Monday".',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-01-01T00:00:00Z',
            },
            {
              name: 'before', in: 'query',
              description: 'Cursor for pagination — return messages older than this ISO timestamp.',
              schema: { type: 'string', format: 'date-time' },
            },
          ],
          responses: {
            '200': {
              description: 'Messages from this contact',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      messages:   { type: 'array', items: { $ref: '#/components/schemas/Message' } },
                      total:      { type: 'integer' },
                      source:     { type: 'string' },
                      platformId: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/contacts/{source}/{platformId}/message': {
        post: {
          operationId: 'messageContact',
          summary: 'Send a message to a contact',
          description: 'Creates an outbox item to send a message to this contact. The message goes through the approval outbox (status=pending) unless directSendFromUi is enabled in permissions (status=sent). Always check the returned status — a "pending" status means the message needs human approval before delivery.',
          parameters: [
            {
              name: 'source', in: 'path', required: true,
              schema: { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter'] },
            },
            {
              name: 'platformId', in: 'path', required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['content'],
                  properties: {
                    content: { type: 'string', description: 'The message text to send', example: 'Hi! Following up on our conversation about the project deadline.' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Outbox item created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success:     { type: 'boolean' },
                      status:      { type: 'string', enum: ['pending', 'approved', 'sent'], description: 'pending = awaiting human approval; sent = delivered immediately' },
                      outboxItemId: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '403': { description: 'Sending is not enabled for this service in permissions' },
          },
        },
      },

      // ── Outbox ────────────────────────────────────────────────────────────────

      '/outbox': {
        get: {
          operationId: 'listOutbox',
          summary: 'List outbox items (pending and sent messages)',
          description: 'Returns messages queued for sending. Pending items are awaiting human approval. Use this to check whether a message you previously submitted has been approved and sent.',
          parameters: [
            {
              name: 'status', in: 'query',
              schema: { type: 'string', enum: ['pending', 'approved', 'sent', 'rejected', 'failed'] },
            },
            {
              name: 'source', in: 'query',
              schema: { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar'] },
            },
          ],
          responses: {
            '200': {
              description: 'Outbox items',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      items:        { type: 'array', items: { $ref: '#/components/schemas/OutboxItem' } },
                      pendingCount: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createOutboxItem',
          summary: 'Send a message to any platform via the outbox',
          description: 'Queues a message for sending. The recipient_id is the platform-native channel or user ID. For DMs, use the contact\'s platformId. For channels, use the channel ID from GET /chats. Messages require sendEnabled permission for the service.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['source', 'recipient_id', 'content'],
                  properties: {
                    source:         { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter'] },
                    recipient_id:   { type: 'string', description: 'Platform-native channel ID or user ID' },
                    recipient_name: { type: 'string', description: 'Human-readable name for display in the outbox UI' },
                    content:        { type: 'string', description: 'Message text' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Outbox item created',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/OutboxItem' } } },
            },
          },
        },
      },

      // ── Gmail ─────────────────────────────────────────────────────────────────

      '/gmail/messages': {
        get: {
          operationId: 'listGmailMessages',
          summary: 'List Gmail messages (metadata + snippet)',
          description: 'Returns Gmail message metadata including sender, subject, snippet, labels, and read/starred state. Full email bodies are not included — use GET /gmail/messages/{id}/body for that. Filter by unread=true to find messages that need attention.',
          parameters: [
            {
              name: 'q', in: 'query',
              description: 'Search query (searches subject, from, snippet)',
              schema: { type: 'string' },
            },
            {
              name: 'label', in: 'query',
              description: 'Filter by Gmail label (e.g. INBOX, STARRED, UNREAD)',
              schema: { type: 'string' },
              example: 'INBOX',
            },
            {
              name: 'unread', in: 'query',
              description: 'If true, returns only unread messages',
              schema: { type: 'boolean' },
            },
            {
              name: 'limit', in: 'query',
              schema: { type: 'integer', default: 50, maximum: 200 },
            },
          ],
          responses: {
            '200': {
              description: 'Gmail messages with metadata and snippets',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      messages: {
                        type: 'array',
                        items: {
                          type: 'object',
                          description: 'Gmail message metadata (not the full body — use GET /gmail/messages/{id}/body for that)',
                          properties: {
                            gmailId:   { type: 'string', description: 'Gmail-native message ID — pass to GET /gmail/messages/{id}/body' },
                            threadId:  { type: 'string', description: 'Thread ID — pass to GET /gmail/threads/{threadId} to fetch the full conversation' },
                            from:      { type: 'string', description: 'Sender display name and email address, e.g. "Alice <alice@example.com>"' },
                            to:        { type: 'array', items: { type: 'string' }, description: 'Recipient addresses' },
                            subject:   { type: 'string' },
                            snippet:   { type: 'string', description: 'Short preview of the email body (up to ~160 characters)' },
                            labels:    { type: 'array', items: { type: 'string' }, description: 'Gmail label IDs, e.g. ["INBOX", "UNREAD"]' },
                            isRead:    { type: 'boolean', description: 'False when the UNREAD label is present' },
                            isStarred: { type: 'boolean' },
                            date:      { type: 'string', format: 'date-time', description: 'When the email was received' },
                            hasAttachments: { type: 'boolean' },
                          },
                        },
                      },
                      total: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/gmail/messages/{id}/body': {
        get: {
          operationId: 'getGmailBody',
          summary: 'Get the full body of a specific Gmail message',
          description: 'Fetches the complete HTML and plain-text body of an email from the Gmail API. Use this after listing messages when you need to read the full content of an email (e.g., to understand a long email chain or extract specific information).',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Gmail message ID (gmailId from list response)' },
          ],
          responses: {
            '200': {
              description: 'Email body',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      html:        { type: 'string', description: 'HTML body of the email' },
                      text:        { type: 'string', description: 'Plain text body' },
                      attachments: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, mimeType: { type: 'string' }, size: { type: 'integer' } } } },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/gmail/threads/{threadId}': {
        get: {
          operationId: 'getGmailThread',
          summary: 'Get all messages in an email thread',
          description: 'Returns all messages belonging to the same email thread, in chronological order. Use this to read the full context of an email conversation.',
          parameters: [
            { name: 'threadId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'All messages in the thread in chronological order',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      threadId: { type: 'string' },
                      messages: {
                        type: 'array',
                        description: 'Messages in the thread, oldest first',
                        items: {
                          type: 'object',
                          properties: {
                            gmailId:   { type: 'string' },
                            from:      { type: 'string' },
                            to:        { type: 'array', items: { type: 'string' } },
                            subject:   { type: 'string' },
                            snippet:   { type: 'string' },
                            labels:    { type: 'array', items: { type: 'string' } },
                            isRead:    { type: 'boolean' },
                            isStarred: { type: 'boolean' },
                            date:      { type: 'string', format: 'date-time' },
                            hasAttachments: { type: 'boolean' },
                          },
                        },
                      },
                      total: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/gmail/actions': {
        post: {
          operationId: 'gmailAction',
          summary: 'Perform an action on a Gmail message',
          description: 'All Gmail actions go through the outbox for human approval. Actions: reply, reply_all, forward, compose, archive, trash, spam, mark_read, mark_unread, star, unstar, unsubscribe.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action:    { type: 'string', enum: ['reply', 'reply_all', 'forward', 'compose', 'archive', 'trash', 'spam', 'mark_read', 'mark_unread', 'star', 'unstar', 'unsubscribe'] },
                    messageId: { type: 'string' },
                    threadId:  { type: 'string' },
                    to:        { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses (for reply/forward/compose)' },
                    subject:   { type: 'string' },
                    body:      { type: 'string', description: 'Email body text' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Action queued in outbox for human approval, or executed immediately if approval is not required',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success:      { type: 'boolean' },
                      outboxItemId: { type: 'integer', description: 'ID of the created outbox item — poll GET /outbox/{id} to track status' },
                      status:       { type: 'string', enum: ['pending', 'sent'], description: 'pending = awaiting human approval; sent = executed immediately' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ── Calendar ──────────────────────────────────────────────────────────────

      '/calendar/events': {
        get: {
          operationId: 'listCalendarEvents',
          summary: 'List upcoming calendar events',
          description: 'Returns calendar events for the specified time range. Defaults to today through the next 7 days. Events include attendees, location, Google Meet links, and RSVP status.',
          parameters: [
            {
              name: 'from', in: 'query',
              description: 'Start of the range (ISO 8601). Defaults to today.',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'to', in: 'query',
              description: 'End of the range (ISO 8601). Defaults to today + 7 days.',
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'calendarId', in: 'query',
              description: 'Filter to a specific calendar (defaults to all calendars)',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Calendar events in the requested time range',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      events: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            eventId:     { type: 'string', description: 'Google Calendar event ID — required for update/delete/rsvp actions' },
                            calendarId:  { type: 'string', description: 'Calendar this event belongs to (use "primary" for the main calendar)' },
                            title:       { type: 'string' },
                            description: { type: 'string', nullable: true },
                            location:    { type: 'string', nullable: true },
                            start:       { type: 'string', format: 'date-time' },
                            end:         { type: 'string', format: 'date-time' },
                            organizer:   { type: 'string', nullable: true, description: 'Email address of the event organizer' },
                            attendees: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  email:       { type: 'string' },
                                  displayName: { type: 'string', nullable: true },
                                  rsvpStatus:  { type: 'string', enum: ['accepted', 'declined', 'tentative', 'needsAction'], description: 'This attendee\'s RSVP response' },
                                  self:        { type: 'boolean', description: 'True if this attendee is the authenticated user' },
                                },
                              },
                            },
                            meetLink:    { type: 'string', nullable: true, description: 'Google Meet URL, if this event has a video conference attached' },
                            rsvpStatus:  { type: 'string', enum: ['accepted', 'declined', 'tentative', 'needsAction'], nullable: true, description: 'The authenticated user\'s own RSVP status for this event' },
                            isRecurring: { type: 'boolean', description: 'True if this is part of a recurring event series' },
                            status:      { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'] },
                          },
                        },
                      },
                      total: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/calendar/actions': {
        post: {
          operationId: 'calendarAction',
          summary: 'Create, update, delete, or RSVP to a calendar event',
          description: 'All calendar modifications go through the outbox for human approval. Use action=create to schedule a new event, action=rsvp to respond to an invitation (rsvpStatus: accepted, declined, or tentative).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action', 'calendarId'],
                  properties: {
                    action:      { type: 'string', enum: ['create', 'update', 'delete', 'rsvp'] },
                    calendarId:  { type: 'string', description: 'Use "primary" for the main calendar' },
                    eventId:     { type: 'string', description: 'Required for update/delete/rsvp' },
                    title:       { type: 'string' },
                    description: { type: 'string' },
                    location:    { type: 'string' },
                    start:       { type: 'string', format: 'date-time' },
                    end:         { type: 'string', format: 'date-time' },
                    attendees:   { type: 'array', items: { type: 'string' }, description: 'Email addresses of attendees' },
                    rsvpStatus:  { type: 'string', enum: ['accepted', 'declined', 'tentative'] },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Calendar action queued in outbox for human approval, or executed immediately if approval is not required',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success:      { type: 'boolean' },
                      outboxItemId: { type: 'integer', description: 'ID of the created outbox item' },
                      status:       { type: 'string', enum: ['pending', 'sent'] },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ── Twitter / X ───────────────────────────────────────────────────────────

      '/twitter/feed': {
        get: {
          operationId: 'getTwitterFeed',
          summary: 'Get the authenticated user\'s home timeline',
          description: 'Returns recent tweets from the home feed. Results are cached for 15 minutes server-side. Use this to understand what is trending in the user\'s network.',
          parameters: [
            { name: 'count', in: 'query', schema: { type: 'integer', default: 20 }, description: 'Number of tweets to return' },
          ],
          responses: {
            '200': {
              description: 'Recent tweets from the home timeline',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tweets: { type: 'array', items: { $ref: '#/components/schemas/Tweet' } },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/twitter/search': {
        get: {
          operationId: 'searchTwitter',
          summary: 'Search Twitter',
          description: 'Search Twitter for tweets (Latest, Top) or people. Use mode=People to find user profiles. Results are cached 15 minutes.',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
            { name: 'mode', in: 'query', schema: { type: 'string', enum: ['Latest', 'Top', 'People'], default: 'Latest' } },
            { name: 'count', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: {
            '200': {
              description: 'Search results — tweets when mode is Latest or Top, user profiles when mode is People',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      results: {
                        type: 'array',
                        description: 'Tweet objects (mode=Latest/Top) or profile objects (mode=People)',
                        items: {
                          oneOf: [
                            { $ref: '#/components/schemas/Tweet' },
                            {
                              type: 'object',
                              description: 'Twitter user profile (returned when mode=People)',
                              properties: {
                                userId:      { type: 'string' },
                                displayName: { type: 'string' },
                                handle:      { type: 'string', description: 'Twitter @handle without the @' },
                                bio:         { type: 'string', nullable: true },
                                followersCount: { type: 'integer' },
                                followingCount: { type: 'integer' },
                                avatarUrl:   { type: 'string', nullable: true },
                                verified:    { type: 'boolean' },
                              },
                            },
                          ],
                        },
                      },
                      mode: { type: 'string', enum: ['Latest', 'Top', 'People'] },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/twitter/notifications/mentions': {
        get: {
          operationId: 'getTwitterMentions',
          summary: 'Get recent @mentions',
          description: 'Returns tweets that mention the authenticated user. Use this to find conversations that need a response.',
          parameters: [
            { name: 'count', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: {
            '200': {
              description: 'Tweets that @mention the authenticated user',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      mentions: { type: 'array', items: { $ref: '#/components/schemas/Tweet' } },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/twitter/dms': {
        get: {
          operationId: 'listTwitterDMs',
          summary: 'List Twitter DM conversations',
          description: 'Returns all synced Twitter direct message conversations with participant info and last message.',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          ],
          responses: {
            '200': {
              description: 'Twitter DM conversations',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      conversations: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            conversationId: { type: 'string', description: 'Pass to GET /twitter/dms/{conversationId} for messages' },
                            participants: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  userId:      { type: 'string' },
                                  displayName: { type: 'string' },
                                  handle:      { type: 'string' },
                                  avatarUrl:   { type: 'string', nullable: true },
                                  isMe:        { type: 'boolean' },
                                },
                              },
                            },
                            lastMessage: {
                              type: 'object',
                              nullable: true,
                              properties: {
                                text:      { type: 'string' },
                                timestamp: { type: 'string', format: 'date-time' },
                                senderId:  { type: 'string' },
                              },
                            },
                            unreadCount: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/twitter/dms/{conversationId}': {
        get: {
          operationId: 'getTwitterDMConversation',
          summary: 'Get messages in a Twitter DM conversation',
          description: 'Returns all stored messages in a specific DM conversation.',
          parameters: [
            { name: 'conversationId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
          ],
          responses: {
            '200': {
              description: 'Messages in the specified Twitter DM conversation',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      conversationId: { type: 'string' },
                      messages: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id:           { type: 'string' },
                            text:         { type: 'string' },
                            senderId:     { type: 'string' },
                            senderHandle: { type: 'string' },
                            senderName:   { type: 'string' },
                            isMe:         { type: 'boolean' },
                            timestamp:    { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                      total: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/twitter/actions': {
        post: {
          operationId: 'twitterAction',
          summary: 'Perform a Twitter action',
          description: 'All Twitter actions go through the outbox for human approval. Actions: tweet (post a new tweet), reply (reply to a tweet), quote (quote-tweet), retweet, like, follow, dm (send a DM).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action:         { type: 'string', enum: ['tweet', 'reply', 'quote', 'retweet', 'like', 'follow', 'dm'] },
                    text:           { type: 'string', description: 'Tweet text (for tweet/reply/quote/dm)' },
                    replyToId:      { type: 'string', description: 'Tweet ID to reply to' },
                    quotedId:       { type: 'string', description: 'Tweet ID to quote' },
                    tweetId:        { type: 'string', description: 'Tweet ID (for retweet/like)' },
                    handle:         { type: 'string', description: 'Twitter handle to follow' },
                    conversationId: { type: 'string', description: 'DM conversation ID (for dm action)' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Twitter action queued in outbox for human approval, or executed immediately if approval is not required',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success:      { type: 'boolean' },
                      outboxItemId: { type: 'integer', description: 'ID of the created outbox item' },
                      status:       { type: 'string', enum: ['pending', 'sent'] },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/twitter/analytics': {
        get: {
          operationId: 'getTwitterAnalytics',
          summary: 'Get tweet performance analytics for the authenticated user',
          description: 'Returns engagement metrics (likes, retweets, replies) for the user\'s recent tweets, aggregated by day and sorted by performance. Includes summary statistics (totals, averages, best tweet). Cached for 15 minutes.',
          responses: {
            '200': {
              description: 'Tweet engagement analytics with per-day breakdown and summary statistics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      summary: {
                        type: 'object',
                        description: 'Aggregate statistics across all tweets in the analytics window',
                        properties: {
                          totalLikes:    { type: 'integer' },
                          totalRetweets: { type: 'integer' },
                          totalReplies:  { type: 'integer' },
                          totalTweets:   { type: 'integer' },
                          avgLikesPerTweet:    { type: 'number' },
                          avgRetweetsPerTweet: { type: 'number' },
                          bestTweet: {
                            type: 'object',
                            nullable: true,
                            description: 'The highest-performing tweet in the window',
                            properties: {
                              id:       { type: 'string' },
                              text:     { type: 'string' },
                              likes:    { type: 'integer' },
                              retweets: { type: 'integer' },
                              replies:  { type: 'integer' },
                              timestamp: { type: 'string', format: 'date-time' },
                            },
                          },
                        },
                      },
                      byDay: {
                        type: 'array',
                        description: 'Per-day engagement aggregation, sorted by date ascending',
                        items: {
                          type: 'object',
                          properties: {
                            date:     { type: 'string', format: 'date', description: 'ISO date, e.g. 2026-04-01' },
                            tweets:   { type: 'integer', description: 'Number of tweets posted this day' },
                            likes:    { type: 'integer' },
                            retweets: { type: 'integer' },
                            replies:  { type: 'integer' },
                          },
                        },
                      },
                      tweets: {
                        type: 'array',
                        description: 'Individual tweet performance, sorted by total engagement descending',
                        items: { $ref: '#/components/schemas/Tweet' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

    },
  });
});

export default router;
