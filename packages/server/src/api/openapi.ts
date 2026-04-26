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
        TwitterProfile: {
          type: 'object',
          description: 'A Twitter/X user profile',
          properties: {
            userId:        { type: 'string', description: 'Numeric Twitter user ID' },
            displayName:   { type: 'string', description: 'Display name of the user' },
            handle:        { type: 'string', description: 'Twitter @handle without the @' },
            bio:           { type: 'string', nullable: true, description: 'User biography/description' },
            followersCount: { type: 'integer', description: 'Number of followers' },
            followingCount: { type: 'integer', description: 'Number of accounts this user follows' },
            avatarUrl:     { type: 'string', nullable: true, description: 'Profile image URL' },
            verified:      { type: 'boolean', description: 'Whether the account has a verified badge' },
            tweetCount:    { type: 'integer', nullable: true, description: 'Total number of tweets posted' },
            isMe:          { type: 'boolean', nullable: true, description: 'True if this is the authenticated user\'s own profile' },
          },
        },
        ObsidianVaultConfig: {
          type: 'object',
          description: 'Obsidian vault configuration (secrets are omitted)',
          properties: {
            id:             { type: 'integer' },
            name:           { type: 'string', description: 'Friendly name for this vault' },
            remoteUrl:      { type: 'string', description: 'Git remote URL of the vault repository' },
            authType:       { type: 'string', enum: ['https', 'ssh'], description: 'Authentication method used to access the remote' },
            branch:         { type: 'string', description: 'Git branch to track (default: main)' },
            localPath:      { type: 'string', description: 'Absolute path to the local git clone on the server' },
            syncStatus:     { type: 'string', enum: ['idle', 'syncing', 'error'], description: 'Current sync state' },
            lastSyncedAt:   { type: 'string', format: 'date-time', nullable: true },
            lastCommitHash: { type: 'string', nullable: true, description: 'Most recent git commit hash after sync' },
            syncError:      { type: 'string', nullable: true, description: 'Error message from the last failed sync' },
            hasHttpsToken:  { type: 'boolean', description: 'Whether an HTTPS personal access token is stored' },
            hasSshPrivateKey: { type: 'boolean', description: 'Whether an SSH private key is stored' },
          },
        },
        ObsidianFileEntry: {
          type: 'object',
          description: 'A file or directory entry in the vault',
          properties: {
            name:     { type: 'string', description: 'File or directory name' },
            path:     { type: 'string', description: 'Relative path from the vault root — use this with GET /obsidian/files/{path}' },
            type:     { type: 'string', enum: ['file', 'directory'] },
            children: { type: 'array', description: 'Child entries (only present for type=directory)', items: { $ref: '#/components/schemas/ObsidianFileEntry' } },
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
                        service:    { type: 'string', enum: ['slack', 'discord', 'telegram', 'gmail', 'calendar', 'twitter', 'notion', 'obsidian'], description: 'Platform name' },
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

      '/contacts/{source}/{platformId}/dm-channel': {
        get: {
          operationId: 'getContactDmChannel',
          summary: 'Look up the DM channel ID for a contact',
          description: 'Returns the platform-native DM channel ID for a contact on Slack, Discord, or Telegram. Use this to get the channelId needed for POST /outbox when you want to send a DM and only have the contact\'s platformId.',
          parameters: [
            {
              name: 'source', in: 'path', required: true,
              schema: { type: 'string', enum: ['slack', 'discord', 'telegram'] },
              description: 'Platform (only slack, discord, and telegram support DM channel lookup)',
            },
            {
              name: 'platformId', in: 'path', required: true,
              schema: { type: 'string' },
              description: 'The contact\'s platform-native user ID',
            },
          ],
          responses: {
            '200': {
              description: 'DM channel ID for this contact',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      channelId:   { type: 'string', description: 'Use this as recipient_id in POST /outbox' },
                      channelName: { type: 'string' },
                    },
                  },
                },
              },
            },
            '404': { description: 'No DM channel found for this contact' },
            '503': { description: 'The platform is not connected' },
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
          summary: 'Queue an action to any platform via the outbox',
          description: `Queues a message or file action for sending. For messaging platforms (slack, discord, telegram, twitter), content is plain text. For structured platforms (gmail, calendar, notion, obsidian), content must be a JSON string encoding the action payload — see below.

**Obsidian vault writes** — set source to "obsidian" and JSON-encode one of these action objects as the content field:

- \`create_file\` — Create a new file (fails if it already exists):
  \`{"action":"create_file","path":"Notes/example.md","content":"# Hello\\nFile body here."}\`

- \`patch_file\` — Edit an existing file with one or more targeted operations. **Prefer this over write_file whenever editing an existing file.** Each edit locates an exact anchor string (must match exactly once) and applies one of three operations via the optional \`position\` field:
  - \`position: "replace"\` (default) — replaces the matched text with \`replace\`. To delete a block set \`replace\` to \`""\`.
    \`{"search":"old text","replace":"new text"}\`
  - \`position: "after"\` — inserts \`content\` immediately after the anchor; the anchor itself is unchanged. Use this to append to a section, add a list item, etc.
    \`{"search":"## Action Items","position":"after","content":"\\n- New task here"}\`
  - \`position: "before"\` — inserts \`content\` immediately before the anchor; the anchor itself is unchanged.
    \`{"search":"## Next Section","position":"before","content":"New paragraph above.\\n\\n"}\`
  Edits are applied in sequence; each operates on the result of the previous. Full example:
  \`{"action":"patch_file","path":"Notes/example.md","edits":[{"search":"## Old Heading","replace":"## New Heading"},{"search":"## Action Items","position":"after","content":"\\n- Follow up with Alice"}]}\`

- \`write_file\` — Overwrite an entire file (or create it if absent). **Only use this for new content or when replacing the entire file is intentional.** For targeted edits use patch_file instead.
  \`{"action":"write_file","path":"Notes/example.md","content":"# Replaced\\nEntire content."}\`

- \`rename_file\` — Move or rename a file:
  \`{"action":"rename_file","oldPath":"Notes/old.md","newPath":"Notes/new.md"}\`

- \`delete_file\` — Delete a file:
  \`{"action":"delete_file","path":"Notes/example.md"}\`

The recipient_id field should be set to the vault file path for obsidian actions (same as the path field in the JSON content). All writes require sendEnabled permission for the obsidian service.`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['source', 'recipient_id', 'content'],
                  properties: {
                    source:         { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar', 'notion', 'obsidian'], description: 'Platform to send on' },
                    recipient_id:   { type: 'string', description: 'Platform-native channel ID, user ID, or vault file path (obsidian)' },
                    recipient_name: { type: 'string', description: 'Human-readable name for display in the outbox UI' },
                    content:        { type: 'string', description: 'Plain text for messaging platforms; JSON-encoded action object for obsidian, gmail, calendar, notion' },
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

      '/outbox/{id}': {
        get: {
          operationId: 'getOutboxItem',
          summary: 'Get a single outbox item by ID',
          description: 'Returns the current state of a single outbox item. Use this to poll for status changes after creating an item (e.g. check whether a pending message has been approved and sent).',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Outbox item ID' },
          ],
          responses: {
            '200': { description: 'Outbox item', content: { 'application/json': { schema: { $ref: '#/components/schemas/OutboxItem' } } } },
            '404': { description: 'Outbox item not found' },
          },
        },
        patch: {
          operationId: 'updateOutboxItem',
          summary: 'Approve, reject, or edit a pending outbox item',
          description: 'Acts on a pending outbox item. Use action=approve to send the message immediately, action=reject to discard it, or action=edit to change the content before approval (pass the updated text as content).',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Outbox item ID' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action:  { type: 'string', enum: ['approve', 'reject', 'edit'], description: 'approve → send now; reject → discard; edit → update content (supply new content field)' },
                    content: { type: 'string', description: 'Updated message text (only used with action=edit)' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Updated outbox item or action result', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Item is not in a state that allows this action' },
            '404': { description: 'Outbox item not found' },
          },
        },
        delete: {
          operationId: 'deleteOutboxItem',
          summary: 'Delete an outbox item',
          description: 'Permanently removes an outbox item from the queue. This does not send the message — use PATCH with action=approve to send.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Outbox item ID' },
          ],
          responses: {
            '200': { description: 'Item deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
          },
        },
      },

      '/outbox/batch': {
        post: {
          operationId: 'createOutboxBatch',
          summary: 'Queue the same message to multiple recipients on the same platform',
          description: 'Creates one outbox item per recipient, all sharing the same batchId. Useful for sending the same announcement or update to several people at once. All items are pending until approved.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['source', 'recipient_ids', 'content'],
                  properties: {
                    source:        { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter'], description: 'Platform to send on' },
                    recipient_ids: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id'],
                        properties: {
                          id:   { type: 'string', description: 'Platform-native channel or user ID' },
                          name: { type: 'string', description: 'Human-readable label for the outbox UI' },
                        },
                      },
                    },
                    content: { type: 'string', description: 'Message text to send to all recipients' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Batch created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      batchId: { type: 'string', format: 'uuid' },
                      items:   { type: 'array', items: { $ref: '#/components/schemas/OutboxItem' } },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/outbox/batch/multi': {
        post: {
          operationId: 'createOutboxBatchMulti',
          summary: 'Queue a heterogeneous batch of messages across multiple platforms',
          description: 'Creates multiple outbox items across different services and recipients in a single request. All items share a batchId for coordinated review and approval. Each operation is permission-checked independently. Use this to queue related messages that should be reviewed and sent together (e.g. notifying the same person on Slack and sending them an email).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['operations'],
                  properties: {
                    operations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['source', 'recipient_id', 'content'],
                        properties: {
                          source:         { type: 'string', enum: ['slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar', 'notion'] },
                          recipient_id:   { type: 'string', description: 'Platform-native channel, user, or resource ID' },
                          recipient_name: { type: 'string', description: 'Human-readable label for the outbox UI' },
                          content:        { type: 'string', description: 'Message text for messaging services; JSON payload string for structured services (gmail, calendar, notion)' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Batch created — all items pending approval',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      batchId: { type: 'string', format: 'uuid' },
                      items:   { type: 'array', items: { $ref: '#/components/schemas/OutboxItem' } },
                    },
                  },
                },
              },
            },
            '403': { description: 'Sending is not enabled for one of the specified services' },
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

      '/gmail/messages/{id}': {
        get: {
          operationId: 'getGmailMessage',
          summary: 'Get a single Gmail message by ID',
          description: 'Returns the full metadata for a single Gmail message — sender, recipients, subject, labels, read/starred state, and snippet. Use GET /gmail/messages/{id}/body to fetch the full email body.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Gmail message ID (gmailId from list response)' },
          ],
          responses: {
            '200': { description: 'Gmail message metadata', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': { description: 'Message not found in local database' },
            '503': { description: 'Gmail not connected' },
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

      '/gmail/labels': {
        get: {
          operationId: 'listGmailLabels',
          summary: 'List all Gmail labels',
          description: 'Returns all Gmail labels available on the account, including system labels (INBOX, SENT, TRASH, etc.) and any custom labels. Use label names/IDs with GET /gmail/messages?label= to filter messages.',
          responses: {
            '200': {
              description: 'Gmail labels',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      labels: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id:   { type: 'string', description: 'Label ID (use this with the label query param)' },
                            name: { type: 'string', description: 'Human-readable label name' },
                            type: { type: 'string', enum: ['system', 'user'], description: 'System labels are built-in; user labels are custom' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '503': { description: 'Gmail not connected' },
          },
        },
      },

      // ── Calendar ──────────────────────────────────────────────────────────────

      '/calendar/calendars': {
        get: {
          operationId: 'listCalendars',
          summary: 'List all Google Calendars on the account',
          description: 'Returns all calendars the user has access to, including their primary calendar and any shared or subscribed calendars. Use the returned calendar IDs with GET /calendar/events?calendarId= to filter events to a specific calendar.',
          responses: {
            '200': {
              description: 'List of calendars',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      calendars: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id:          { type: 'string', description: 'Calendar ID — use "primary" for the user\'s main calendar' },
                            summary:     { type: 'string', description: 'Calendar display name' },
                            description: { type: 'string', nullable: true },
                            primary:     { type: 'boolean', description: 'True for the user\'s main calendar' },
                            accessRole:  { type: 'string', description: 'Access level: owner, writer, reader, freeBusyReader' },
                            color:       { type: 'string', nullable: true, description: 'Hex color code used in the UI' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '503': { description: 'Calendar not connected' },
          },
        },
      },

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

      '/calendar/events/{id}': {
        get: {
          operationId: 'getCalendarEvent',
          summary: 'Get a single calendar event by ID',
          description: 'Returns the full details of a specific calendar event including all attendees, RSVP statuses, Google Meet link, description, and recurrence info. Use this when you have an eventId from GET /calendar/events and need the complete event data.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Google Calendar event ID (eventId from list response)' },
          ],
          responses: {
            '200': { description: 'Calendar event', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': { description: 'Event not found in local database' },
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
          description: 'Search Twitter for tweets (Latest, Top) or people. Use mode=People to find user profiles. Results are cached 15 minutes. When mode=People the response key is `profiles` instead of `tweets`.',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
            { name: 'mode', in: 'query', schema: { type: 'string', enum: ['Latest', 'Top', 'People'], default: 'Latest' } },
            { name: 'count', in: 'query', schema: { type: 'integer', default: 20 } },
          ],
          responses: {
            '200': {
              description: 'Search results — `tweets` array when mode is Latest or Top; `profiles` array when mode is People',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tweets: {
                        type: 'array',
                        description: 'Tweet objects (present when mode=Latest or mode=Top)',
                        items: { $ref: '#/components/schemas/Tweet' },
                      },
                      profiles: {
                        type: 'array',
                        description: 'User profile objects (present when mode=People)',
                        items: { $ref: '#/components/schemas/TwitterProfile' },
                      },
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

      '/twitter/trends': {
        get: {
          operationId: 'getTwitterTrends',
          summary: 'Get current Twitter/X trending topics',
          description: 'Returns the current list of trending topics on Twitter/X. Results are cached 15 minutes server-side.',
          responses: {
            '200': {
              description: 'List of trending topics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      trends: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name:       { type: 'string', description: 'Trend name or hashtag' },
                            tweetCount: { type: 'string', nullable: true, description: 'Approximate tweet volume (e.g. "12.4K")' },
                            url:        { type: 'string', nullable: true, description: 'Twitter search URL for this trend' },
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

      '/twitter/tweet/{id}': {
        get: {
          operationId: 'getTwitterTweet',
          summary: 'Get a single tweet by ID',
          description: 'Fetches a specific tweet by its ID. Results are cached 15 minutes. Returns 404 if the tweet is not found or has been deleted.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Tweet ID' },
          ],
          responses: {
            '200': { description: 'Tweet object', content: { 'application/json': { schema: { $ref: '#/components/schemas/Tweet' } } } },
            '404': { description: 'Tweet not found' },
          },
        },
      },

      '/twitter/tweet/{id}/thread': {
        get: {
          operationId: 'getTwitterTweetThread',
          summary: 'Get a tweet thread (tweet + all replies in the chain)',
          description: 'Returns the full thread for a given tweet ID — the tweet itself plus all upstream and downstream replies in conversation order.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Tweet ID to fetch the thread for' },
          ],
          responses: {
            '200': {
              description: 'Ordered list of tweets forming the thread',
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

      '/twitter/me': {
        get: {
          operationId: 'getTwitterMe',
          summary: 'Get the authenticated user\'s own Twitter profile',
          description: 'Returns the full profile of the currently authenticated Twitter/X account. Results are cached 15 minutes.',
          responses: {
            '200': { description: 'Authenticated user\'s profile', content: { 'application/json': { schema: { $ref: '#/components/schemas/TwitterProfile' } } } },
            '503': { description: 'Twitter not connected' },
          },
        },
      },

      '/twitter/user/{handle}': {
        get: {
          operationId: 'getTwitterUserProfile',
          summary: 'Get a Twitter user\'s profile by handle',
          description: 'Returns the full public profile for any Twitter/X user by their @handle. Results are cached 15 minutes. Returns 404 if the account does not exist or is private.',
          parameters: [
            { name: 'handle', in: 'path', required: true, schema: { type: 'string' }, description: 'Twitter @handle without the @ (e.g. "alice")' },
          ],
          responses: {
            '200': { description: 'User profile', content: { 'application/json': { schema: { $ref: '#/components/schemas/TwitterProfile' } } } },
            '404': { description: 'User not found' },
          },
        },
      },

      '/twitter/user/{handle}/tweets': {
        get: {
          operationId: 'getTwitterUserTweets',
          summary: 'Get recent tweets from a specific user',
          description: 'Returns the most recent tweets posted by the given @handle. Results are cached 15 minutes.',
          parameters: [
            { name: 'handle', in: 'path', required: true, schema: { type: 'string' }, description: 'Twitter @handle without the @' },
            { name: 'count', in: 'query', schema: { type: 'integer', default: 20 }, description: 'Number of tweets to return' },
          ],
          responses: {
            '200': {
              description: 'The user\'s recent tweets',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { tweets: { type: 'array', items: { $ref: '#/components/schemas/Tweet' } } } },
                },
              },
            },
          },
        },
      },

      '/twitter/user/{handle}/followers': {
        get: {
          operationId: 'getTwitterUserFollowers',
          summary: 'Get a user\'s followers',
          description: 'Returns a list of Twitter/X profiles that follow the given @handle. Results are cached 15 minutes.',
          parameters: [
            { name: 'handle', in: 'path', required: true, schema: { type: 'string' }, description: 'Twitter @handle without the @' },
            { name: 'count', in: 'query', schema: { type: 'integer', default: 50 }, description: 'Number of followers to return' },
          ],
          responses: {
            '200': {
              description: 'Follower profiles',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { profiles: { type: 'array', items: { $ref: '#/components/schemas/TwitterProfile' } } } },
                },
              },
            },
          },
        },
      },

      '/twitter/user/{handle}/following': {
        get: {
          operationId: 'getTwitterUserFollowing',
          summary: 'Get accounts a user follows',
          description: 'Returns a list of Twitter/X profiles that the given @handle is following. Results are cached 15 minutes.',
          parameters: [
            { name: 'handle', in: 'path', required: true, schema: { type: 'string' }, description: 'Twitter @handle without the @' },
            { name: 'count', in: 'query', schema: { type: 'integer', default: 50 }, description: 'Number of following accounts to return' },
          ],
          responses: {
            '200': {
              description: 'Following profiles',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { profiles: { type: 'array', items: { $ref: '#/components/schemas/TwitterProfile' } } } },
                },
              },
            },
          },
        },
      },

      '/twitter/analytics': {
        get: {
          operationId: 'getTwitterTrends',
          summary: 'Get current Twitter/X trending topics',
          description: 'Returns the current list of trending topics on Twitter/X. Results are cached 15 minutes server-side.',
          responses: {
            '200': {
              description: 'List of trending topics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      trends: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name:       { type: 'string', description: 'Trend name or hashtag' },
                            tweetCount: { type: 'string', nullable: true, description: 'Approximate tweet volume (e.g. "12.4K")' },
                            url:        { type: 'string', nullable: true, description: 'Twitter search URL for this trend' },
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

      // ── Notion ────────────────────────────────────────────────────────────────

      '/notion/pages': {
        post: {
          operationId: 'createNotionPage',
          summary: 'Create a new Notion page',
          description: 'Creates a new Notion page by proxying the request body directly to the Notion POST /v1/pages API. The body is passed through as-is — supply a Notion-compatible parent, properties, and optional children blocks. Requires sendEnabled permission for the notion service.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['parent', 'properties'],
                  properties: {
                    parent: {
                      type: 'object',
                      description: 'Parent container — either a database or a page',
                      properties: {
                        database_id: { type: 'string', description: 'ID of the parent database (use this to create a database row)' },
                        page_id:     { type: 'string', description: 'ID of the parent page (use this to create a sub-page)' },
                      },
                    },
                    properties: { type: 'object', description: 'Page properties matching the parent database schema (or { title } for a plain page)' },
                    children:   { type: 'array', items: { type: 'object' }, description: 'Optional array of block objects to add as page content' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created Notion page object (raw Notion API response)', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Notion write access is not enabled' },
            '503': { description: 'Notion not connected' },
          },
        },
      },

      '/notion/pages/{pageId}': {
        get: {
          operationId: 'getNotionPage',
          summary: 'Retrieve a Notion page by ID',
          description: 'Fetches a Notion page object by its page ID using the Notion API. Returns the page metadata and properties. Use GET /notion/blocks/{blockId}/children to get the page content. Requires readEnabled permission for the notion service.',
          parameters: [
            { name: 'pageId', in: 'path', required: true, schema: { type: 'string' }, description: 'Notion page ID (UUID format, dashes optional)' },
          ],
          responses: {
            '200': { description: 'Notion page object (raw Notion API response)', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Notion read access is not enabled' },
            '503': { description: 'Notion not connected' },
          },
        },
        patch: {
          operationId: 'updateNotionPage',
          summary: 'Update an existing Notion page',
          description: 'Updates a Notion page by proxying the request body directly to the Notion PATCH /v1/pages/:id API. The body is passed through as-is — supply properties to update and optionally in_trash to archive the page. Requires sendEnabled permission for the notion service.',
          parameters: [
            { name: 'pageId', in: 'path', required: true, schema: { type: 'string' }, description: 'Notion page ID (UUID format, dashes optional)' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    properties: { type: 'object', description: 'Page properties to update (only include fields you want to change)' },
                    in_trash:   { type: 'boolean', description: 'Set to true to move the page to trash (archive it)' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Updated Notion page object (raw Notion API response)', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Notion write access is not enabled' },
            '503': { description: 'Notion not connected' },
          },
        },
      },

      '/notion/databases': {
        get: {
          operationId: 'listNotionDatabases',
          summary: 'List all Notion databases accessible to the integration',
          description: 'Returns all Notion databases that have been shared with the Conduit integration token. Use the returned database IDs with POST /notion/databases/{databaseId}/query to read rows. Requires readEnabled permission.',
          responses: {
            '200': { description: 'List of accessible Notion databases (raw Notion API response)', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Notion read access is not enabled' },
            '503': { description: 'Notion not connected' },
          },
        },
      },

      '/notion/databases/{databaseId}/query': {
        post: {
          operationId: 'queryNotionDatabase',
          summary: 'Query a Notion database',
          description: 'Queries a Notion database and returns matching pages (rows). Supports Notion filter and sort syntax. Use this to read structured data from Notion databases (e.g. task lists, CRMs, project trackers). Requires readEnabled permission.',
          parameters: [
            { name: 'databaseId', in: 'path', required: true, schema: { type: 'string' }, description: 'Notion database ID' },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    filter:       { type: 'object', description: 'Notion filter object (see Notion API docs)' },
                    sorts:        { type: 'array', items: { type: 'object' }, description: 'Notion sort objects' },
                    page_size:    { type: 'integer', description: 'Max results per page (max 100)', default: 100 },
                    start_cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Database query results (raw Notion API response with results array and pagination)', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Notion read access is not enabled' },
            '503': { description: 'Notion not connected' },
          },
        },
      },

      '/notion/search': {
        post: {
          operationId: 'searchNotion',
          summary: 'Search the Notion workspace',
          description: 'Searches across all pages and databases in the Notion workspace that are accessible to the integration. Use this to find a page by title when you don\'t know its ID. Requires readEnabled permission.',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    query:        { type: 'string', description: 'Text to search for in page/database titles' },
                    filter: {
                      type: 'object',
                      description: 'Restrict to object type',
                      properties: {
                        value: { type: 'string', enum: ['page', 'database'] },
                        property: { type: 'string', enum: ['object'] },
                      },
                    },
                    sort: {
                      type: 'object',
                      description: 'Sort order for results',
                      properties: {
                        direction:  { type: 'string', enum: ['ascending', 'descending'] },
                        timestamp:  { type: 'string', enum: ['last_edited_time'] },
                      },
                    },
                    page_size:    { type: 'integer', default: 100 },
                    start_cursor: { type: 'string', description: 'Pagination cursor' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Search results (raw Notion API response)', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Notion read access is not enabled' },
            '503': { description: 'Notion not connected' },
          },
        },
      },

      '/notion/blocks/{blockId}': {
        get: {
          operationId: 'getNotionBlock',
          summary: 'Retrieve a single Notion block',
          description: 'Fetches a specific Notion block by its ID. Blocks are the building blocks of Notion pages (paragraphs, headings, lists, etc.). Use GET /notion/blocks/{blockId}/children to fetch a page\'s content. Requires readEnabled permission.',
          parameters: [
            { name: 'blockId', in: 'path', required: true, schema: { type: 'string' }, description: 'Notion block ID (same as page ID for page-level blocks)' },
          ],
          responses: {
            '200': { description: 'Block object (raw Notion API response)', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Notion read access is not enabled' },
            '503': { description: 'Notion not connected' },
          },
        },
      },

      '/notion/blocks/{blockId}/children': {
        get: {
          operationId: 'getNotionBlockChildren',
          summary: 'Get the children of a Notion block (page content)',
          description: 'Retrieves the child blocks of a given block ID. For a page, pass the page ID as blockId to get all content blocks. This is the primary way to read the body of a Notion page. Supports pagination. Requires readEnabled permission.',
          parameters: [
            { name: 'blockId', in: 'path', required: true, schema: { type: 'string' }, description: 'Block ID whose children to retrieve (use page ID to get page content)' },
            { name: 'page_size', in: 'query', schema: { type: 'integer', default: 100 }, description: 'Max children to return (max 100)' },
            { name: 'start_cursor', in: 'query', schema: { type: 'string' }, description: 'Pagination cursor from a previous response' },
          ],
          responses: {
            '200': { description: 'Child block list (raw Notion API response with results and pagination)', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Notion read access is not enabled' },
            '503': { description: 'Notion not connected' },
          },
        },
      },

      // ── Obsidian ──────────────────────────────────────────────────────────────

      '/obsidian/config': {
        get: {
          operationId: 'getObsidianConfig',
          summary: 'Get Obsidian vault configuration',
          description: 'Returns the current vault configuration (secrets like tokens and private keys are excluded). Check `configured: true` before calling file or sync endpoints.',
          responses: {
            '200': {
              description: 'Vault configuration or not-configured state',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      configured: { type: 'boolean', description: 'Whether a vault has been configured' },
                      vault: { $ref: '#/components/schemas/ObsidianVaultConfig', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: 'setObsidianConfig',
          summary: 'Create or update Obsidian vault configuration',
          description: 'Saves vault connection details (remote URL, auth credentials, branch). After saving, call POST /obsidian/config/test to verify access, then POST /obsidian/config/clone to clone the repository. For SSH auth, first call POST /obsidian/config/generate-ssh-key to get a deploy key.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'remote_url'],
                  properties: {
                    name:            { type: 'string', description: 'Friendly name for the vault (used as directory name; alphanumeric and hyphens only)' },
                    remote_url:      { type: 'string', description: 'Git remote URL — HTTPS (e.g. https://github.com/user/vault.git) or SSH (git@github.com:user/vault.git)' },
                    auth_type:       { type: 'string', enum: ['https', 'ssh'], default: 'https', description: 'Authentication method. Use https with a personal access token, or ssh with a generated deploy key.' },
                    https_token:     { type: 'string', description: 'Personal access token for HTTPS auth (stored encrypted, not returned on GET)' },
                    ssh_private_key: { type: 'string', description: 'SSH private key for SSH auth. Omit to use a previously generated key.' },
                    branch:          { type: 'string', default: 'main', description: 'Git branch to track' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Saved vault configuration (secrets excluded)',
              content: { 'application/json': { schema: { type: 'object', properties: { configured: { type: 'boolean' }, vault: { $ref: '#/components/schemas/ObsidianVaultConfig' } } } } },
            },
          },
        },
        delete: {
          operationId: 'deleteObsidianConfig',
          summary: 'Remove Obsidian vault configuration',
          description: 'Deletes the vault configuration and disconnects the sync. Optionally deletes the local git clone from disk.',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    delete_local: { type: 'boolean', default: false, description: 'If true, deletes the local git clone from the server disk' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Config deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
            '404': { description: 'No vault configured' },
          },
        },
      },

      '/obsidian/config/test': {
        post: {
          operationId: 'testObsidianConnection',
          summary: 'Test vault git remote access without cloning',
          description: 'Runs `git ls-remote` against the configured remote to verify credentials are valid. Use this after saving config and before triggering a clone.',
          responses: {
            '200': {
              description: 'Connection test result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      error:   { type: 'string', nullable: true, description: 'Error message if test failed' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/obsidian/config/generate-ssh-key': {
        post: {
          operationId: 'generateObsidianSshKey',
          summary: 'Generate an SSH key pair for vault access',
          description: 'Generates a new ed25519 SSH key pair and stores it in the vault config. Returns the public key — add this as a deploy key in your git hosting provider (GitHub, GitLab, etc.) before cloning with SSH auth.',
          responses: {
            '200': {
              description: 'Generated SSH public key and fingerprint',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      publicKey:   { type: 'string', description: 'SSH public key to add as a deploy key in your git host' },
                      fingerprint: { type: 'string', description: 'SHA256 fingerprint of the public key' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/obsidian/config/ssh-key': {
        get: {
          operationId: 'getObsidianSshKey',
          summary: 'Get the current SSH public key',
          description: 'Returns the SSH public key that was previously generated. Add this as a read-only deploy key in your git repository to enable SSH cloning.',
          responses: {
            '200': {
              description: 'SSH public key',
              content: { 'application/json': { schema: { type: 'object', properties: { publicKey: { type: 'string' } } } } },
            },
            '404': { description: 'No SSH key generated yet — call POST /obsidian/config/generate-ssh-key first' },
          },
        },
      },

      '/obsidian/config/clone': {
        post: {
          operationId: 'cloneObsidianVault',
          summary: 'Clone the vault git repository',
          description: 'Triggers an initial `git clone` of the configured remote repository into the server\'s local data directory. This is a one-time setup step — run it after saving config and verifying the connection. The clone runs asynchronously; monitor progress via GET /obsidian/sync/status.',
          responses: {
            '200': {
              description: 'Clone started (runs asynchronously)',
              content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } },
            },
          },
        },
      },

      '/obsidian/sync/status': {
        get: {
          operationId: 'getObsidianSyncStatus',
          summary: 'Get the current vault sync status',
          description: 'Returns the vault\'s current synchronisation state including last sync time, latest commit hash, and any error. Poll this to track clone and sync progress.',
          responses: {
            '200': {
              description: 'Sync status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      configured:     { type: 'boolean' },
                      syncStatus:     { type: 'string', enum: ['idle', 'syncing', 'error'], nullable: true },
                      lastSyncedAt:   { type: 'string', format: 'date-time', nullable: true },
                      lastCommitHash: { type: 'string', nullable: true },
                      error:          { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/obsidian/sync': {
        post: {
          operationId: 'syncObsidianVault',
          summary: 'Trigger a manual vault sync (git fetch + pull)',
          description: 'Runs `git fetch` followed by `git pull --ff-only` to pull the latest changes from the remote. The sync runs asynchronously — monitor progress via GET /obsidian/sync/status. The vault also auto-syncs every 5 minutes.',
          responses: {
            '200': {
              description: 'Sync started (runs asynchronously)',
              content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } },
            },
            '400': { description: 'No vault configured or vault not cloned yet' },
          },
        },
      },

      '/obsidian/files': {
        get: {
          operationId: 'listObsidianFiles',
          summary: 'List all files in the vault',
          description: 'Returns the full file tree of the Obsidian vault as a recursive directory structure. Use the `path` field from any entry with GET /obsidian/files/{path} to read file contents. Hidden directories (.git, .obsidian, .trash) are excluded.',
          responses: {
            '200': {
              description: 'Vault file tree',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      files: { type: 'array', items: { $ref: '#/components/schemas/ObsidianFileEntry' } },
                    },
                  },
                },
              },
            },
            '503': { description: 'Vault not connected (clone it first)' },
          },
        },
      },

      '/obsidian/files/{path}': {
        get: {
          operationId: 'readObsidianFile',
          summary: 'Read a file from the vault',
          description: 'Returns the raw text content of a file in the vault by its relative path. The vault is auto-synced before reading if the last sync was more than 4 minutes ago. Use GET /obsidian/files to list available paths.',
          parameters: [
            {
              name: 'path', in: 'path', required: true,
              schema: { type: 'string' },
              description: 'Relative path from the vault root (e.g. "Daily Notes/2026-04-13.md"). URL-encode any special characters.',
            },
          ],
          responses: {
            '200': {
              description: 'File contents',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      path:    { type: 'string', description: 'Relative path that was read' },
                      content: { type: 'string', description: 'Raw file content (UTF-8 text)' },
                    },
                  },
                },
              },
            },
            '404': { description: 'File not found in vault' },
            '503': { description: 'Vault not connected' },
          },
        },
      },


    },
  });
});

export default router;
