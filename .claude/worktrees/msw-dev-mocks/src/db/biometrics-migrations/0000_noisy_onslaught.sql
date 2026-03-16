CREATE TABLE `movement` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`timestamp` integer NOT NULL,
	`total_movement` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_movement_side_timestamp` ON `movement` (`side`,`timestamp`);--> statement-breakpoint
CREATE TABLE `sleep_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`entered_bed_at` integer NOT NULL,
	`left_bed_at` integer NOT NULL,
	`sleep_duration_seconds` integer NOT NULL,
	`times_exited_bed` integer DEFAULT 0 NOT NULL,
	`present_intervals` text,
	`not_present_intervals` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sleep_records_side_entered` ON `sleep_records` (`side`,`entered_bed_at`);--> statement-breakpoint
CREATE TABLE `vitals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`timestamp` integer NOT NULL,
	`heart_rate` real,
	`hrv` real,
	`breathing_rate` real
);
--> statement-breakpoint
CREATE INDEX `idx_vitals_side_timestamp` ON `vitals` (`side`,`timestamp`);