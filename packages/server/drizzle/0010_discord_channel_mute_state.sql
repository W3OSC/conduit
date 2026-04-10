CREATE TABLE `discord_channel_mute_state` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`guild_id` text,
	`is_muted` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (datetime('now'))
);
