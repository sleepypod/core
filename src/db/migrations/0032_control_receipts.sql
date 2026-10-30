CREATE TABLE `control_receipts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`request` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`received_at` integer NOT NULL,
	`finished_at` integer,
	`dispatch_count` integer DEFAULT 0 NOT NULL,
	`last_dispatch_at` integer,
	`run_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `control_receipts_received_idx` ON `control_receipts` (`received_at`);