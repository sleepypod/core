CREATE TABLE `biometric_history_identity` (
	`id` integer PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `biometric_history_identity_dataset_id_unique` ON `biometric_history_identity` (`dataset_id`);