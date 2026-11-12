CREATE TABLE `household_quiet_requests` (
	`account_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`revision` text NOT NULL,
	`updated_at` integer NOT NULL,
	`quiet_until` integer,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
