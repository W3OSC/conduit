-- Add fine_grained_config JSON column to the global permissions table (UI user).
-- Stores per-service read/write allowlists as a JSON blob.
-- NULL = unrestricted (all channels/labels/etc. allowed).
ALTER TABLE `permissions` ADD COLUMN `fine_grained_config` TEXT;
--> statement-breakpoint
-- Add fine_grained_config JSON column to the per-API-key permissions table.
-- NULL = inherit fine_grained_config from the global permissions table.
ALTER TABLE `api_key_permissions` ADD COLUMN `fine_grained_config` TEXT;
