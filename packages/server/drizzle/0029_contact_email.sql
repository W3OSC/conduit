-- Workspace email for a contact, captured from the platform profile where a
-- scope allows it (Slack: users.list profile.email via users:read.email).
-- Gives agent consumers a uid -> email map for identity bridging.
ALTER TABLE `contacts` ADD `email` text;
