CREATE TABLE `obsidian_vault_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`remote_url` text NOT NULL,
	`auth_type` text NOT NULL DEFAULT 'https',
	`https_token` text,
	`ssh_private_key` text,
	`ssh_public_key` text,
	`local_path` text NOT NULL,
	`branch` text NOT NULL DEFAULT 'main',
	`last_synced_at` text,
	`last_commit_hash` text,
	`sync_status` text NOT NULL DEFAULT 'idle',
	`sync_error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
