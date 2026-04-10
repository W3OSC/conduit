CREATE UNIQUE INDEX IF NOT EXISTS `sync_state_source_chat_account_unique` ON `sync_state` (`source`, `chat_id`, `account_id`);
