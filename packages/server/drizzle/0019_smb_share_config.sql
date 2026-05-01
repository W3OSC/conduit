-- SMB file share connection support.
-- Stores one row per configured SMB share (multi-share, like Obsidian vaults).
CREATE TABLE `smb_share_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`share` text NOT NULL,
	`domain` text,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
-- Seed default permissions row for SMB.
-- sendEnabled defaults to false (writes require explicit opt-in via permissions UI).
INSERT OR IGNORE INTO `permissions` (`service`, `read_enabled`, `send_enabled`, `require_approval`, `direct_send_from_ui`, `mark_read_enabled`)
VALUES ('smb', 1, 0, 1, 0, 0);
