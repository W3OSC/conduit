-- Google Drive connection support.
-- Stores one row per whitelisted Drive folder (multi-folder, like Obsidian vaults).
CREATE TABLE `google_drive_folder_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`drive_type` text NOT NULL DEFAULT 'personal',
	`folder_id` text NOT NULL,
	`folder_name` text NOT NULL,
	`drive_id` text,
	`sync_status` text NOT NULL DEFAULT 'idle',
	`sync_error` text,
	`last_change_id` text,
	`last_synced_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
-- 1-hour metadata cache for Drive files (reduces API quota usage).
CREATE TABLE `google_drive_file_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`folder_config_id` integer NOT NULL,
	`file_id` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer DEFAULT 0,
	`modified_time` text,
	`created_time` text,
	`is_folder` integer DEFAULT false,
	`parent_id` text,
	`web_view_link` text,
	`drive_id` text,
	`depth` integer DEFAULT 0,
	`indexed_at` text DEFAULT (datetime('now')),
	UNIQUE(`folder_config_id`, `file_id`)
);
--> statement-breakpoint
-- Seed default permissions row for Google Drive.
-- sendEnabled defaults to false (writes require explicit opt-in via permissions UI).
INSERT OR IGNORE INTO `permissions` (`service`, `read_enabled`, `send_enabled`, `require_approval`, `direct_send_from_ui`, `mark_read_enabled`)
VALUES ('gdrive', 1, 0, 1, 0, 0);
