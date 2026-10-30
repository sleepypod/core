CREATE TABLE `household_control_receipts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`personal_request` text NOT NULL,
	`resolved_zones` text NOT NULL,
	`fingerprint` text NOT NULL,
	`request` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`received_at` integer NOT NULL,
	`finished_at` integer,
	`dispatch_count` integer DEFAULT 0 NOT NULL,
	`last_dispatch_at` integer,
	`run_id` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_household_control_account` ON `household_control_receipts` (`account_id`,`received_at`);