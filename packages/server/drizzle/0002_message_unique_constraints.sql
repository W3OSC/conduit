CREATE UNIQUE INDEX IF NOT EXISTS `telegram_messages_msg_chat_unique` ON `telegram_messages` (`message_id`, `chat_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `discord_messages_msg_channel_unique` ON `discord_messages` (`message_id`, `channel_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `slack_messages_msg_channel_unique` ON `slack_messages` (`message_id`, `channel_id`);
