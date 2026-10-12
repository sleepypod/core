CREATE TABLE `reference_vitals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`source` text NOT NULL,
	`timestamp` integer NOT NULL,
	`heart_rate` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reference_vitals_side_timestamp_source` ON `reference_vitals` (`side`,`timestamp`,`source`);