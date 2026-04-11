CREATE TABLE IF NOT EXISTS `chat_read_state` (
	`source` text NOT NULL,
	`chat_id` text NOT NULL,
	`last_read_at` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')),
	UNIQUE(`source`, `chat_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `chat_mute_state` (
	`source` text NOT NULL,
	`chat_id` text NOT NULL,
	`is_muted` integer NOT NULL DEFAULT false,
	`updated_at` text DEFAULT (datetime('now')),
	UNIQUE(`source`, `chat_id`)
);
