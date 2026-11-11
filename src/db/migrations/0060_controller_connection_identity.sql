CREATE TABLE `controller_connection_identity` (
	`id` integer PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `controller_connection_identity_installation_id_unique` ON `controller_connection_identity` (`installation_id`);