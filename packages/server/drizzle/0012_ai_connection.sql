-- Recreate ai_sessions without webhook_url and api_key_id columns
-- (SQLite requires table recreation to drop columns)
CREATE TABLE IF NOT EXISTS `ai_sessions_new` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL DEFAULT 'New Chat',
  `system_prompt_sent` integer NOT NULL DEFAULT 0,
  `created_at` text DEFAULT (datetime('now')),
  `updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
INSERT INTO `ai_sessions_new` (`id`, `title`, `system_prompt_sent`, `created_at`, `updated_at`)
SELECT `id`, `title`, `system_prompt_sent`, `created_at`, `updated_at`
FROM `ai_sessions`;
--> statement-breakpoint
DROP TABLE `ai_sessions`;
--> statement-breakpoint
ALTER TABLE `ai_sessions_new` RENAME TO `ai_sessions`;
