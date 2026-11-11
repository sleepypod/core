CREATE TABLE `household_arrangement_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`review_id` text NOT NULL,
	`account_id` text NOT NULL,
	`device_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`request` text NOT NULL,
	`run_id` text NOT NULL,
	`admission_revision` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`committed_at` integer,
	`context` text NOT NULL,
	`archive` text,
	`committed_hash` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`review_id`) REFERENCES `household_arrangement_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `household_devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_arrangement_transitions_review_id_unique` ON `household_arrangement_transitions` (`review_id`);--> statement-breakpoint
CREATE INDEX `idx_household_arrangement_transitions` ON `household_arrangement_transitions` (`household_id`,`created_at`);