CREATE TABLE `household_processing_receipts` (
	`operation_id` text NOT NULL,
	`component` text NOT NULL,
	`process_id` text NOT NULL,
	`intent_hash` text NOT NULL,
	`first_sample_ms` integer NOT NULL,
	`latest_sample_ms` integer NOT NULL,
	`heartbeat_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_household_processing_receipt` ON `household_processing_receipts` (`operation_id`,`component`);