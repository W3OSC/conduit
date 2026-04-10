CREATE TABLE IF NOT EXISTS `meet_notes` (
  `id`               integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `note_id`          text NOT NULL UNIQUE,
  `source`           text NOT NULL DEFAULT 'meet',
  `account_id`       text,
  `conference_id`    text,
  `title`            text,
  `summary`          text,
  `docs_url`         text,
  `drive_file_id`    text,
  `meeting_date`     text,
  `calendar_event_id` text,
  `attendees`        text,
  `state`            text,
  `raw_json`         text,
  `synced_at`        text DEFAULT (datetime('now')),
  `updated_at`       text
);
