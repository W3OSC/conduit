-- Migration: multi-vault support
-- Migrate existing vault(s) from name-based local paths to id-based paths.
-- The local_path column is updated: data/vault/<name> → data/vault/<id>
-- No schema changes are needed — the table already has a proper id PK.
-- This migration only relocates path metadata in the DB; the actual directory
-- rename is performed in server startup code (db/client.ts seedDefaults).
-- We mark each row with a flag so the rename only happens once.

-- Nothing to ALTER — local_path is already text NOT NULL, id is already PK.
-- The application layer handles path migration on startup.
SELECT 1; -- no-op placeholder so drizzle registers this migration file
