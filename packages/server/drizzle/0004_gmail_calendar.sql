CREATE TABLE `gmail_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gmail_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`account_id` text,
	`from_address` text,
	`from_name` text,
	`to_addresses` text,
	`cc_addresses` text,
	`bcc_addresses` text,
	`subject` text,
	`snippet` text,
	`labels` text,
	`has_attachments` integer DEFAULT false,
	`is_read` integer DEFAULT false,
	`is_starred` integer DEFAULT false,
	`internal_date` text,
	`size_estimate` integer,
	`raw_headers` text,
	`synced_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_messages_gmail_id_unique` ON `gmail_messages` (`gmail_id`);
--> statement-breakpoint
CREATE INDEX `gmail_messages_thread_idx` ON `gmail_messages` (`thread_id`);
--> statement-breakpoint
CREATE INDEX `gmail_messages_date_idx` ON `gmail_messages` (`internal_date`);
--> statement-breakpoint
CREATE INDEX `gmail_messages_read_idx` ON `gmail_messages` (`is_read`);
--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`account_id` text,
	`title` text,
	`description` text,
	`location` text,
	`start_time` text NOT NULL,
	`end_time` text,
	`all_day` integer DEFAULT false,
	`status` text,
	`attendees` text,
	`organizer_email` text,
	`organizer_name` text,
	`recurrence` text,
	`html_link` text,
	`meet_link` text,
	`color_id` text,
	`raw_json` text,
	`synced_at` text DEFAULT (datetime('now')),
	`updated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_events_unique` ON `calendar_events` (`event_id`, `calendar_id`);
--> statement-breakpoint
CREATE INDEX `calendar_events_start_idx` ON `calendar_events` (`start_time`);
--> statement-breakpoint
CREATE INDEX `calendar_events_calendar_idx` ON `calendar_events` (`calendar_id`);
