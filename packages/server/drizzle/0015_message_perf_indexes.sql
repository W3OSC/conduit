-- Performance indexes for unread count queries.
-- computeAllUnreads() and countUnreadForChat() do:
--   COUNT(*) WHERE channelId = ? AND timestamp > ?
-- Without indexes on (channelId, timestamp) SQLite does a full table scan
-- for every chat, making fetchUnreadCounts() O(N * tableSize).

CREATE INDEX IF NOT EXISTS `discord_messages_channel_ts`
  ON `discord_messages` (`channel_id`, `timestamp`);

CREATE INDEX IF NOT EXISTS `slack_messages_channel_ts`
  ON `slack_messages` (`channel_id`, `timestamp`);

CREATE INDEX IF NOT EXISTS `telegram_messages_chat_ts`
  ON `telegram_messages` (`chat_id`, `timestamp`);

CREATE INDEX IF NOT EXISTS `twitter_dms_conv_ts`
  ON `twitter_dms` (`conversation_id`, `created_at`);
