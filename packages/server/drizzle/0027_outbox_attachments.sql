-- Outbound file attachments: JSON array of {filename, mime, data(base64)}.
-- Stored on the row so approval/retry re-dispatch delivers the same bytes.
ALTER TABLE `outbox` ADD `attachments` text;
