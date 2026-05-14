-- Add ai_tool_call_id to outbox so we can link a failed action back to the
-- original AI API request that created it.
ALTER TABLE `outbox` ADD `ai_tool_call_id` text;
