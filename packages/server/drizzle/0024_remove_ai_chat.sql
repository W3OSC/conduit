-- The in-app AI chat was removed: agents now integrate via the REST API only.
-- ai_tool_calls stays — it records agent API access (X-Session-Id is an
-- agent-supplied grouping id, no longer a foreign key to ai_sessions).
DROP TABLE IF EXISTS `ai_sessions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `ai_messages`;
--> statement-breakpoint
DELETE FROM `settings` WHERE `key` LIKE 'ai.%';
