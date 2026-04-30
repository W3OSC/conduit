-- AI tool calls: server-side tracking of every Conduit API call made by the AI agent.
-- Populated automatically when the AI passes X-Session-Id on its requests.
CREATE TABLE IF NOT EXISTS `ai_tool_calls` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `name` text NOT NULL,
  `input` text NOT NULL,
  `output` text,
  `created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_tool_calls_session_idx` ON `ai_tool_calls` (`session_id`);
