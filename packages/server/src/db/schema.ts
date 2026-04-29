import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

// ─── Accounts ────────────────────────────────────────────────────────────────

export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  accountId: text('account_id').notNull(),
  displayName: text('display_name'),
  sessionData: text('session_data'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  lastSync: text('last_sync'),
});

// ─── Messages ────────────────────────────────────────────────────────────────

export const telegramMessages = sqliteTable('telegram_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  messageId: integer('message_id').notNull(),
  chatId: integer('chat_id').notNull(),
  chatName: text('chat_name'),
  chatType: text('chat_type'),
  senderId: integer('sender_id'),
  senderName: text('sender_name'),
  content: text('content'),
  mediaType: text('media_type'),
  mediaPath: text('media_path'),
  replyToId: integer('reply_to_id'),
  timestamp: text('timestamp').notNull(),
  rawJson: text('raw_json'),
}, (t) => ({
  uniqMsg: unique().on(t.messageId, t.chatId),
}));

export const discordMessages = sqliteTable('discord_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  messageId: text('message_id').notNull(),
  channelId: text('channel_id').notNull(),
  channelName: text('channel_name'),
  guildId: text('guild_id'),
  guildName: text('guild_name'),
  authorId: text('author_id'),
  authorName: text('author_name'),
  content: text('content'),
  attachments: text('attachments'),
  embeds: text('embeds'),
  timestamp: text('timestamp').notNull(),
  editedAt: text('edited_at'),
  rawJson: text('raw_json'),
}, (t) => ({
  uniqMsg: unique().on(t.messageId, t.channelId),
}));

export const slackMessages = sqliteTable('slack_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  messageId: text('message_id').notNull(),
  channelId: text('channel_id').notNull(),
  channelName: text('channel_name'),
  userId: text('user_id'),
  userName: text('user_name'),
  content: text('content'),
  attachments: text('attachments'),
  threadTs: text('thread_ts'),
  timestamp: text('timestamp').notNull(),
  rawJson: text('raw_json'),
}, (t) => ({
  uniqMsg: unique().on(t.messageId, t.channelId),
}));

// ─── Sync infrastructure ─────────────────────────────────────────────────────

export const syncRuns = sqliteTable('sync_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  syncType: text('sync_type').notNull().default('incremental'),
  status: text('status').notNull().default('running'),
  chatsVisited: integer('chats_visited').default(0),
  chatsWithNew: integer('chats_with_new').default(0),
  messagesSaved: integer('messages_saved').default(0),
  requestsMade: integer('requests_made').default(0),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
});

export const syncState = sqliteTable('sync_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  accountId: text('account_id'),
  chatId: text('chat_id').notNull(),
  chatName: text('chat_name'),
  lastMessageTs: text('last_message_ts'),
  lastFetchedAt: text('last_fetched_at'),
  isFullSync: integer('is_full_sync', { mode: 'boolean' }).default(false),
  messageCount: integer('message_count').default(0),
}, (t) => ({
  uniqSourceChatAccount: unique().on(t.source, t.chatId, t.accountId),
}));

export const errorLog = sqliteTable('error_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  accountId: text('account_id'),
  chatId: text('chat_id'),
  errorType: text('error_type').notNull(),
  message: text('message').notNull(),
  detailsJson: text('details_json'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

// ─── Outbox ───────────────────────────────────────────────────────────────────

export const outbox = sqliteTable('outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchId: text('batch_id'),
  source: text('source').notNull(),
  recipientId: text('recipient_id').notNull(),
  recipientName: text('recipient_name'),
  content: text('content').notNull(),
  editedContent: text('edited_content'),
  status: text('status').notNull().default('pending'),
  requester: text('requester').notNull().default('ui'),
  apiKeyId: integer('api_key_id'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  approvedAt: text('approved_at'),
  sentAt: text('sent_at'),
});

// ─── Permissions ─────────────────────────────────────────────────────────────

export const permissions = sqliteTable('permissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service: text('service').notNull().unique(),
  readEnabled: integer('read_enabled', { mode: 'boolean' }).notNull().default(true),
  sendEnabled: integer('send_enabled', { mode: 'boolean' }).notNull().default(false),
  requireApproval: integer('require_approval', { mode: 'boolean' }).notNull().default(true),
  directSendFromUi: integer('direct_send_from_ui', { mode: 'boolean' }).notNull().default(false),
  // When true, opening a conversation marks it as read on the platform API.
  // When false (default), read state is only tracked in the client store.
  markReadEnabled: integer('mark_read_enabled', { mode: 'boolean' }).notNull().default(false),
  // JSON blob with per-service fine-grained read/write allowlists.
  // Shape: { readChannelIds?: string[], writeChannelIds?: string[], ... } (service-specific)
  // NULL = unrestricted (all resources allowed).
  fineGrainedConfig: text('fine_grained_config'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ─── Audit Log ────────────────────────────────────────────────────────────────

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  action: text('action').notNull(),
  service: text('service'),
  actor: text('actor').notNull().default('ui'),
  apiKeyId: integer('api_key_id'),
  targetId: text('target_id'),
  detail: text('detail'),
  timestamp: text('timestamp').default(sql`(datetime('now'))`),
});

// ─── API Keys ─────────────────────────────────────────────────────────────────

export const apiKeys = sqliteTable('api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

// ─── API Key Permissions ──────────────────────────────────────────────────────
// Per-key permission overrides. NULL = inherit from global permissions table.

export const apiKeyPermissions = sqliteTable('api_key_permissions', {
  id:              integer('id').primaryKey({ autoIncrement: true }),
  apiKeyId:        integer('api_key_id').notNull(),
  service:         text('service').notNull(),
  readEnabled:     integer('read_enabled',      { mode: 'boolean' }),  // null = inherit
  sendEnabled:     integer('send_enabled',      { mode: 'boolean' }),  // null = inherit
  requireApproval: integer('require_approval',  { mode: 'boolean' }),  // null = inherit
  // JSON blob with per-service fine-grained read/write allowlists.
  // NULL = inherit from global permissions table.
  fineGrainedConfig: text('fine_grained_config'),
}, (t) => ({
  uniq: unique().on(t.apiKeyId, t.service),
}));

// ─── Settings ─────────────────────────────────────────────────────────────────

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ─── Passkey Credentials ──────────────────────────────────────────────────────
// One row per registered WebAuthn/passkey authenticator.

export const passkeyCredentials = sqliteTable('passkey_credentials', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  credentialId: text('credential_id').notNull().unique(),
  publicKey:    text('public_key').notNull(),          // base64url-encoded COSE key
  counter:      integer('counter').notNull().default(0),
  aaguid:       text('aaguid'),
  name:         text('name'),                          // user-supplied nickname
  createdAt:    text('created_at').default(sql`(datetime('now'))`),
  lastUsedAt:   text('last_used_at'),
});

// ─── Gmail ───────────────────────────────────────────────────────────────────

export const gmailMessages = sqliteTable('gmail_messages', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  gmailId:       text('gmail_id').notNull().unique(),
  threadId:      text('thread_id').notNull(),
  accountId:     text('account_id'),
  fromAddress:   text('from_address'),
  fromName:      text('from_name'),
  toAddresses:   text('to_addresses'),   // JSON array
  ccAddresses:   text('cc_addresses'),   // JSON array
  bccAddresses:  text('bcc_addresses'),  // JSON array
  subject:       text('subject'),
  snippet:       text('snippet'),
  labels:        text('labels'),         // JSON array e.g. ["INBOX","UNREAD"]
  hasAttachments:integer('has_attachments', { mode: 'boolean' }).default(false),
  isRead:        integer('is_read', { mode: 'boolean' }).default(false),
  isStarred:     integer('is_starred', { mode: 'boolean' }).default(false),
  internalDate:  text('internal_date'),
  sizeEstimate:  integer('size_estimate'),
  rawHeaders:    text('raw_headers'),    // JSON of important headers
  syncedAt:      text('synced_at').default(sql`(datetime('now'))`),
});

// ─── Google Calendar ──────────────────────────────────────────────────────────

export const calendarEvents = sqliteTable('calendar_events', {
  id:             integer('id').primaryKey({ autoIncrement: true }),
  eventId:        text('event_id').notNull(),
  calendarId:     text('calendar_id').notNull(),
  accountId:      text('account_id'),
  title:          text('title'),
  description:    text('description'),
  location:       text('location'),
  startTime:      text('start_time').notNull(),
  endTime:        text('end_time'),
  allDay:         integer('all_day', { mode: 'boolean' }).default(false),
  status:         text('status'),        // confirmed | tentative | cancelled
  attendees:      text('attendees'),     // JSON array of {email, name, responseStatus}
  organizerEmail: text('organizer_email'),
  organizerName:  text('organizer_name'),
  recurrence:     text('recurrence'),   // JSON recurrence rules
  htmlLink:       text('html_link'),
  meetLink:       text('meet_link'),
  colorId:        text('color_id'),
  rawJson:        text('raw_json'),
  syncedAt:       text('synced_at').default(sql`(datetime('now'))`),
  updatedAt:      text('updated_at'),
}, (t) => ({
  uniq: unique().on(t.eventId, t.calendarId),
}));

// ─── Twitter DMs ──────────────────────────────────────────────────────────────

export const twitterDms = sqliteTable('twitter_dms', {
  id:             integer('id').primaryKey({ autoIncrement: true }),
  conversationId: text('conversation_id').notNull(),
  messageId:      text('message_id').notNull(),
  senderId:       text('sender_id').notNull(),
  senderHandle:   text('sender_handle'),
  senderName:     text('sender_name'),
  recipientId:    text('recipient_id'),
  text:           text('text'),
  createdAt:      text('created_at').notNull(),
  accountId:      text('account_id'),
  rawJson:        text('raw_json'),
  syncedAt:       text('synced_at').default(sql`(datetime('now'))`),
}, (t) => ({
  uniq: unique().on(t.messageId, t.conversationId),
}));

// ─── Contacts ─────────────────────────────────────────────────────────────────

export const contacts = sqliteTable('contacts', {
  id:              integer('id').primaryKey({ autoIncrement: true }),
  source:          text('source').notNull(),          // 'slack' | 'discord' | 'telegram'
  platformId:      text('platform_id').notNull(),     // user ID on that platform
  accountId:       text('account_id'),                // which of our accounts they belong to

  // Core identity
  displayName:     text('display_name'),
  username:        text('username'),                  // handle/tag
  firstName:       text('first_name'),
  lastName:        text('last_name'),
  phone:           text('phone'),                     // Telegram only

  // Avatar & profile
  avatarUrl:       text('avatar_url'),
  bio:             text('bio'),
  statusText:      text('status_text'),

  // Platform context
  workspaceId:     text('workspace_id'),              // JSON array of workspace/guild IDs
  mutualGroupIds:  text('mutual_group_ids'),          // JSON array of shared channel/group IDs

  // Criteria flags — OR logic on upsert (once set, stays set)
  hasDm:           integer('has_dm', { mode: 'boolean' }).default(false),
  isFromOwnedGroup:integer('is_from_owned_group', { mode: 'boolean' }).default(false),
  isFromSmallGroup:integer('is_from_small_group', { mode: 'boolean' }).default(false),
  isNativeContact: integer('is_native_contact', { mode: 'boolean' }).default(false),

  // Timestamps
  firstSeenAt:     text('first_seen_at').default(sql`(datetime('now'))`),
  lastSeenAt:      text('last_seen_at'),
  lastMessageAt:   text('last_message_at'),
  updatedAt:       text('updated_at').default(sql`(datetime('now'))`),

  // Full platform-specific JSON
  rawJson:         text('raw_json'),
}, (t) => ({
  uniq: unique().on(t.source, t.platformId),
}));

// ─── Meet Notes ───────────────────────────────────────────────────────────────

export const meetNotes = sqliteTable('meet_notes', {
  id:              integer('id').primaryKey({ autoIncrement: true }),
  noteId:          text('note_id').notNull().unique(), // conferenceRecords/…/smartNotes/… or Drive file ID
  source:          text('source').notNull().default('meet'), // 'meet' | 'drive'
  accountId:       text('account_id'),                // which Google account email
  conferenceId:    text('conference_id'),             // conferenceRecords/{id}
  title:           text('title'),
  summary:         text('summary'),                   // full plaintext content of the Google Doc
  docsUrl:         text('docs_url'),                  // link to the Google Doc (webViewLink)
  driveFileId:     text('drive_file_id'),             // Google Drive file ID
  meetingDate:     text('meeting_date'),              // ISO — conference startTime or Drive createdTime
  calendarEventId: text('calendar_event_id'),         // matched calendar_events.event_id (if found)
  attendees:       text('attendees'),                 // JSON array of { name, email } participant objects
  state:           text('state'),                     // 'ACTIVE' | 'ENDED' | 'PROCESSING' | 'STATE_UNSPECIFIED'
  rawJson:         text('raw_json'),
  syncedAt:        text('synced_at').default(sql`(datetime('now'))`),
  updatedAt:       text('updated_at'),
});

// ─── Chat read state ──────────────────────────────────────────────────────────
// Server-side "last read" cursor per conversation. Written when the user opens
// a chat (via POST /api/unread/:source/:chatId/read). Used to compute unread
// counts as COUNT(messages WHERE timestamp > last_read_at).

export const chatReadState = sqliteTable('chat_read_state', {
  source:     text('source').notNull(),
  chatId:     text('chat_id').notNull(),
  lastReadAt: text('last_read_at').notNull(),
  updatedAt:  text('updated_at').default(sql`(datetime('now'))`),
}, (t) => ({
  pk: unique().on(t.source, t.chatId),
}));

// ─── Chat mute state ──────────────────────────────────────────────────────────
// Persisted authoritative mute state for all service chats.
// Discord: written by fetchUnreadCounts() / userGuildSettingsUpdate.
// Slack:   written by fetchUnreadCounts() from conversations.info.
// Telegram: written by fetchUnreadCounts() from dialog notifySettings.

export const chatMuteState = sqliteTable('chat_mute_state', {
  source:    text('source').notNull(),
  chatId:    text('chat_id').notNull(),
  isMuted:   integer('is_muted', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (t) => ({
  pk: unique().on(t.source, t.chatId),
}));

// ─── Discord channel mute state (legacy — kept for migration compat) ──────────
// New code writes to chat_mute_state. This table is no longer written to but
// may exist in deployed databases from earlier versions.

export const discordChannelMuteState = sqliteTable('discord_channel_mute_state', {
  channelId: text('channel_id').primaryKey(),
  guildId:   text('guild_id'),
  isMuted:   integer('is_muted', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ─── AI Chat Sessions ─────────────────────────────────────────────────────────

export const aiSessions = sqliteTable('ai_sessions', {
  id:               text('id').primaryKey(),                        // nanoid
  title:            text('title').notNull().default('New Chat'),
  systemPromptSent: integer('system_prompt_sent', { mode: 'boolean' }).notNull().default(false),
  createdAt:        text('created_at').default(sql`(datetime('now'))`),
  updatedAt:        text('updated_at').default(sql`(datetime('now'))`),
});

export const aiMessages = sqliteTable('ai_messages', {
  id:        text('id').primaryKey(),                              // nanoid
  sessionId: text('session_id').notNull(),                        // FK → ai_sessions
  role:      text('role').notNull(),                              // 'user' | 'assistant' | 'system' | 'tool'
  content:   text('content').notNull().default(''),
  toolCalls: text('tool_calls'),                                  // JSON array of { name, input, output }
  streaming: integer('streaming', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

// ─── Obsidian Vault ───────────────────────────────────────────────────────────

export const obsidianVaultConfig = sqliteTable('obsidian_vault_config', {
  id:              integer('id').primaryKey({ autoIncrement: true }),
  name:            text('name').notNull(),
  remoteUrl:       text('remote_url').notNull(),
  authType:        text('auth_type').notNull().default('https'),  // 'https' | 'ssh'
  httpsToken:      text('https_token'),                          // PAT for HTTPS auth
  sshPrivateKey:   text('ssh_private_key'),                      // PEM private key for SSH
  sshPublicKey:    text('ssh_public_key'),                       // Public key to add to remote
  localPath:       text('local_path').notNull(),                 // absolute path on disk
  branch:          text('branch').notNull().default('main'),
  lastSyncedAt:    text('last_synced_at'),
  lastCommitHash:  text('last_commit_hash'),
  syncStatus:      text('sync_status').notNull().default('idle'), // 'idle' | 'syncing' | 'error'
  syncError:       text('sync_error'),
  createdAt:       text('created_at').default(sql`(datetime('now'))`),
  updatedAt:       text('updated_at').default(sql`(datetime('now'))`),
});

// ─── SMB File Share ───────────────────────────────────────────────────────────

export const smbShareConfig = sqliteTable('smb_share_config', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  name:      text('name').notNull(),                   // friendly name, e.g. "NAS Documents"
  host:      text('host').notNull(),                   // e.g. "192.168.1.10"
  share:     text('share').notNull(),                  // share name, e.g. "documents"
  domain:    text('domain'),                           // optional Windows domain
  username:  text('username').notNull(),
  password:  text('password').notNull(),               // stored in server DB (not settings key/value)
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

// ─── Fine-grained permission config types ─────────────────────────────────────
// Stored as JSON in `permissions.fine_grained_config` and
// `api_key_permissions.fine_grained_config`.
// Each service only uses the fields relevant to it.
// An absent or null field = unrestricted (all resources allowed).

export interface SlackFineGrained {
  readChannelIds?: string[];   // DM/channel IDs the key may read from
  writeChannelIds?: string[];  // DM/channel IDs the key may send to
}

export interface DiscordFineGrained {
  readGuildIds?: string[];
  readChannelIds?: string[];
  writeGuildIds?: string[];
  writeChannelIds?: string[];
}

export interface TelegramFineGrained {
  readChatIds?: string[];
  readFolderIds?: string[];
  writeChatIds?: string[];
}

export interface GmailFineGrained {
  readLabelIds?: string[];
  writeLabelIds?: string[];
}

export interface CalendarFineGrained {
  readCalendarIds?: string[];
  writeCalendarIds?: string[];
}

export interface TwitterFineGrained {
  readDms?: boolean;       // can read DM conversations
  readTimeline?: boolean;  // can read home timeline / feed
  allowTweets?: boolean;   // can post tweets
  allowDmReplies?: boolean; // can send DM replies
}

export interface NotionFineGrained {
  readDatabaseIds?: string[];
  readPageIds?: string[];
  writeDatabaseIds?: string[];
  writePageIds?: string[];
}

export interface ObsidianFineGrained {
  readPaths?: string[];   // path prefixes the key may read
  writePaths?: string[];  // path prefixes the key may write to
}

export interface SmbFineGrained {
  readEnabled?: boolean;   // global read toggle for this share
  writeEnabled?: boolean;  // global write toggle for this share
  readPaths?: string[];    // path prefixes the key may read (null = all paths)
  writePaths?: string[];   // path prefixes the key may write to (null = all paths)
}

export type ServiceFineGrained =
  | SlackFineGrained
  | DiscordFineGrained
  | TelegramFineGrained
  | GmailFineGrained
  | CalendarFineGrained
  | TwitterFineGrained
  | NotionFineGrained
  | ObsidianFineGrained
  | SmbFineGrained;

// ─── Type exports ─────────────────────────────────────────────────────────────

export type Account = typeof accounts.$inferSelect;
export type TelegramMessage = typeof telegramMessages.$inferSelect;
export type DiscordMessage = typeof discordMessages.$inferSelect;
export type SlackMessage = typeof slackMessages.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type SyncState = typeof syncState.$inferSelect;
export type ErrorLog = typeof errorLog.$inferSelect;
export type Outbox = typeof outbox.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type ApiKeyPermission = typeof apiKeyPermissions.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type InsertContact = typeof contacts.$inferInsert;
export type GmailMessage = typeof gmailMessages.$inferSelect;
export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type TwitterDm = typeof twitterDms.$inferSelect;

export type InsertOutbox = typeof outbox.$inferInsert;
export type InsertAuditLog = typeof auditLog.$inferInsert;
export type MeetNote = typeof meetNotes.$inferSelect;
export type InsertMeetNote = typeof meetNotes.$inferInsert;
export type DiscordChannelMuteState = typeof discordChannelMuteState.$inferSelect;
export type ChatReadState = typeof chatReadState.$inferSelect;
export type ChatMuteState = typeof chatMuteState.$inferSelect;

export type AiSession = typeof aiSessions.$inferSelect;
export type InsertAiSession = typeof aiSessions.$inferInsert;
export type AiMessage = typeof aiMessages.$inferSelect;
export type InsertAiMessage = typeof aiMessages.$inferInsert;

export type ObsidianVaultConfig = typeof obsidianVaultConfig.$inferSelect;
export type SmbShareConfig = typeof smbShareConfig.$inferSelect;
export type InsertSmbShareConfig = typeof smbShareConfig.$inferInsert;
export type InsertObsidianVaultConfig = typeof obsidianVaultConfig.$inferInsert;
