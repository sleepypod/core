CREATE TABLE `household_attribution_epochs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`mode` text NOT NULL,
	`assignments` text NOT NULL,
	`basis` text NOT NULL,
	`review_receipt_id` text NOT NULL,
	`reviewed_by` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_attribution_epochs_review_receipt_id_unique` ON `household_attribution_epochs` (`review_receipt_id`);--> statement-breakpoint
CREATE INDEX `idx_household_attribution_time` ON `household_attribution_epochs` (`household_id`,`dataset_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `household_history_state` (
	`household_id` text PRIMARY KEY NOT NULL,
	`attribution_revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `household_person_records` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`household_id` text NOT NULL,
	`sleeper_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_record_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`recorded_side` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`invalidated_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sleeper_id`) REFERENCES `household_accounts`(`sleeper_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`epoch_id`) REFERENCES `household_attribution_epochs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_person_records_id_unique` ON `household_person_records` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_household_source_record` ON `household_person_records` (`dataset_id`,`source_kind`,`source_record_key`);--> statement-breakpoint
CREATE INDEX `idx_household_person_history` ON `household_person_records` (`household_id`,`sleeper_id`,`starts_at`);