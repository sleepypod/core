CREATE TABLE `household_journal_entries` (
	`account_id` text NOT NULL,
	`sleeper_id` text NOT NULL,
	`local_date` text NOT NULL,
	`revision` text NOT NULL,
	`time_zone` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`fields` text,
	PRIMARY KEY(`account_id`, `local_date`),
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
