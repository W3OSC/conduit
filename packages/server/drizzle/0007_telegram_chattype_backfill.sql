-- Backfill chatType for existing Telegram messages using numeric ID conventions:
--   Positive IDs < 1_000_000_000_000 = private (DM)
--   Negative IDs = group
--   IDs >= 1_000_000_000_000 = channel/supergroup
UPDATE telegram_messages
SET chat_type = CASE
  WHEN chat_id > 0 AND chat_id < 1000000000000 THEN 'private'
  WHEN chat_id < 0                              THEN 'group'
  ELSE                                               'channel'
END
WHERE chat_type IS NULL;
