CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`platform_id` text NOT NULL,
	`account_id` text,
	`display_name` text,
	`username` text,
	`first_name` text,
	`last_name` text,
	`phone` text,
	`avatar_url` text,
	`bio` text,
	`status_text` text,
	`workspace_id` text,
	`mutual_group_ids` text,
	`has_dm` integer DEFAULT false,
	`is_from_owned_group` integer DEFAULT false,
	`is_from_small_group` integer DEFAULT false,
	`is_native_contact` integer DEFAULT false,
	`first_seen_at` text DEFAULT (datetime('now')),
	`last_seen_at` text,
	`last_message_at` text,
	`updated_at` text DEFAULT (datetime('now')),
	`raw_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_source_platform_unique` ON `contacts` (`source`, `platform_id`);
--> statement-breakpoint
CREATE INDEX `contacts_source_idx` ON `contacts` (`source`);
--> statement-breakpoint
CREATE INDEX `contacts_display_name_idx` ON `contacts` (`display_name`);
--> statement-breakpoint
CREATE INDEX `contacts_last_message_idx` ON `contacts` (`last_message_at`);
