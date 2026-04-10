CREATE TABLE `twitter_dms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`sender_handle` text,
	`sender_name` text,
	`recipient_id` text,
	`text` text,
	`created_at` text NOT NULL,
	`account_id` text,
	`raw_json` text,
	`synced_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `twitter_dms_msg_conv_unique` ON `twitter_dms` (`message_id`, `conversation_id`);
--> statement-breakpoint
CREATE INDEX `twitter_dms_conv_idx` ON `twitter_dms` (`conversation_id`);
--> statement-breakpoint
CREATE INDEX `twitter_dms_created_idx` ON `twitter_dms` (`created_at`);
