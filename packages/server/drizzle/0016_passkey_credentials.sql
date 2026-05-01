-- Passkey (WebAuthn) credentials for UI login.
-- Each row is one registered authenticator/passkey device.

CREATE TABLE IF NOT EXISTS `passkey_credentials` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `credential_id` text NOT NULL UNIQUE,
  `public_key` text NOT NULL,
  `counter` integer NOT NULL DEFAULT 0,
  `aaguid` text,
  `name` text,
  `created_at` text DEFAULT (datetime('now')),
  `last_used_at` text
);
