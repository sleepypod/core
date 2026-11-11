CREATE TABLE `household_history_sources` (
	`household_id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`review_receipt_id` text NOT NULL,
	`reviewed_by` text NOT NULL,
	`bound_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_history_sources_dataset_id_unique` ON `household_history_sources` (`dataset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `household_history_sources_review_receipt_id_unique` ON `household_history_sources` (`review_receipt_id`);