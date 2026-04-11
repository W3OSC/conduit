-- AI Chat Sessions
CREATE TABLE IF NOT EXISTS `ai_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL DEFAULT 'New Chat',
  `webhook_url` text,
  `api_key_id` integer,
  `system_prompt_sent` integer NOT NULL DEFAULT 0,
  `created_at` text DEFAULT (datetime('now')),
  `updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
-- AI Chat Messages
CREATE TABLE IF NOT EXISTS `ai_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `role` text NOT NULL,
  `content` text NOT NULL DEFAULT '',
  `tool_calls` text,
  `streaming` integer NOT NULL DEFAULT 0,
  `created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_messages_session_idx` ON `ai_messages` (`session_id`);
