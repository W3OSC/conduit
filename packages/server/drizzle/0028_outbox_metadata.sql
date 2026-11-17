-- Opaque caller-supplied JSON bag on outbox rows, e.g. {"cloudJobId": "..."}
-- stamped by Meridian's home-agent bridge on outbox creates. Used to dedupe
-- at-least-once redelivery from the cloud's durable queue (see
-- findByCloudJobId in api/outbox.ts).
ALTER TABLE `outbox` ADD `metadata` text;
