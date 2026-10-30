CREATE TABLE `household_arrangement_approvals` (
	`request_id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`account_id` text NOT NULL,
	`device_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `household_arrangement_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `household_devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_household_arrangement_approval` ON `household_arrangement_approvals` (`review_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `household_arrangement_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`creator_account_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_household_arrangement_reviews` ON `household_arrangement_reviews` (`household_id`,`created_at`);