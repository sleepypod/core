CREATE TABLE `reference_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`source` text NOT NULL,
	`metric` text NOT NULL,
	`timestamp` integer NOT NULL,
	`value` real NOT NULL,
	`created_at` integer NOT NULL,
	`import_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reference_samples_side_metric_timestamp_source` ON `reference_samples` (`side`,`metric`,`timestamp`,`source`);