CREATE TABLE `api_key_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`api_key_id` integer NOT NULL,
	`service` text NOT NULL,
	`read_enabled` integer,
	`send_enabled` integer,
	`require_approval` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_permissions_key_service_unique` ON `api_key_permissions` (`api_key_id`, `service`);
