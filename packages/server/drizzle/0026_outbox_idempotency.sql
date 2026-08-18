-- Client-supplied idempotency key for outbox creation. Partial unique index:
-- NULL keys (the default) stay unconstrained.
ALTER TABLE `outbox` ADD `idempotency_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `outbox_idempotency_key_idx` ON `outbox` (`idempotency_key`) WHERE `idempotency_key` IS NOT NULL;
