CREATE TABLE `household_learning_archives` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`sleeper_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`captured_at` integer NOT NULL,
	`binding` text NOT NULL,
	`source_schemas` text NOT NULL,
	`record_count` integer NOT NULL,
	`payload_bytes` integer NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `household_arrangement_transitions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_household_learning_owner` ON `household_learning_archives` (`household_id`,`account_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `household_learning_records` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`source_table` text NOT NULL,
	`source_key` text NOT NULL,
	`source_side` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`payload_bytes` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`record_hash` text NOT NULL,
	`redaction` text,
	FOREIGN KEY (`operation_id`) REFERENCES `household_learning_archives`(`operation_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_household_learning_order` ON `household_learning_records` (`operation_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_household_learning_source` ON `household_learning_records` (`operation_id`,`source_table`,`source_key`);