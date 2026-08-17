-- Missing indexes for frequently-filtered columns.
-- Covers outbox/audit/sync-run dashboards, per-author/sender message lookups,
-- gmail account/from filters, meet-notes date + drive-file lookups, drive file
-- cache folder scans, account source lookups, and error log queries.
--
-- Already covered elsewhere (not repeated here):
--   twitter_dms (created_at)            → twitter_dms_created_idx   (0005)
--   discord/slack/telegram (chat, ts)   → *_channel_ts / *_chat_ts  (0015)
--   gmail_messages thread/date/read     → 0004

CREATE INDEX IF NOT EXISTS `outbox_status_idx` ON `outbox` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `outbox_batch_idx` ON `outbox` (`batch_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `outbox_created_idx` ON `outbox` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_timestamp_idx` ON `audit_log` (`timestamp`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_action_idx` ON `audit_log` (`action`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_service_idx` ON `audit_log` (`service`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_log_api_key_idx` ON `audit_log` (`api_key_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sync_runs_source_started_idx` ON `sync_runs` (`source`, `started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sync_runs_status_idx` ON `sync_runs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `discord_messages_author_idx` ON `discord_messages` (`author_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `discord_messages_timestamp_idx` ON `discord_messages` (`timestamp`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slack_messages_user_idx` ON `slack_messages` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `slack_messages_timestamp_idx` ON `slack_messages` (`timestamp`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `telegram_messages_sender_idx` ON `telegram_messages` (`sender_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `telegram_messages_timestamp_idx` ON `telegram_messages` (`timestamp`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_messages_from_idx` ON `gmail_messages` (`from_address`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_messages_account_idx` ON `gmail_messages` (`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `meet_notes_meeting_date_idx` ON `meet_notes` (`meeting_date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `meet_notes_drive_file_idx` ON `meet_notes` (`drive_file_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `google_drive_file_cache_folder_idx` ON `google_drive_file_cache` (`folder_config_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `accounts_source_idx` ON `accounts` (`source`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `error_log_source_created_idx` ON `error_log` (`source`, `created_at`);
