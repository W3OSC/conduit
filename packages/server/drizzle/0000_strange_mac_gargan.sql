CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`account_id` text NOT NULL,
	`display_name` text,
	`session_data` text,
	`created_at` text DEFAULT (datetime('now')),
	`last_sync` text
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`service` text,
	`actor` text DEFAULT 'ui' NOT NULL,
	`api_key_id` integer,
	`target_id` text,
	`detail` text,
	`timestamp` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `discord_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_name` text,
	`guild_id` text,
	`guild_name` text,
	`author_id` text,
	`author_name` text,
	`content` text,
	`attachments` text,
	`embeds` text,
	`timestamp` text NOT NULL,
	`edited_at` text,
	`raw_json` text
);
--> statement-breakpoint
CREATE TABLE `error_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`account_id` text,
	`chat_id` text,
	`error_type` text NOT NULL,
	`message` text NOT NULL,
	`details_json` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text,
	`source` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_name` text,
	`content` text NOT NULL,
	`edited_content` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`requester` text DEFAULT 'ui' NOT NULL,
	`api_key_id` integer,
	`error_message` text,
	`created_at` text DEFAULT (datetime('now')),
	`approved_at` text,
	`sent_at` text
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service` text NOT NULL,
	`read_enabled` integer DEFAULT true NOT NULL,
	`send_enabled` integer DEFAULT false NOT NULL,
	`require_approval` integer DEFAULT true NOT NULL,
	`direct_send_from_ui` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_service_unique` ON `permissions` (`service`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `slack_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_name` text,
	`user_id` text,
	`user_name` text,
	`content` text,
	`attachments` text,
	`thread_ts` text,
	`timestamp` text NOT NULL,
	`raw_json` text
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`sync_type` text DEFAULT 'incremental' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`chats_visited` integer DEFAULT 0,
	`chats_with_new` integer DEFAULT 0,
	`messages_saved` integer DEFAULT 0,
	`requests_made` integer DEFAULT 0,
	`error_message` text,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`account_id` text,
	`chat_id` text NOT NULL,
	`chat_name` text,
	`last_message_ts` text,
	`last_fetched_at` text,
	`is_full_sync` integer DEFAULT false,
	`message_count` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `telegram_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`chat_name` text,
	`chat_type` text,
	`sender_id` integer,
	`sender_name` text,
	`content` text,
	`media_type` text,
	`media_path` text,
	`reply_to_id` integer,
	`timestamp` text NOT NULL,
	`raw_json` text
);
