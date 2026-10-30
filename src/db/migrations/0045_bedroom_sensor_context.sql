CREATE TABLE `bedroom_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision` integer NOT NULL,
	`source_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`source` text NOT NULL,
	`report` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bedroom_history_received` ON `bedroom_history` (`received_at`);--> statement-breakpoint
CREATE INDEX `bedroom_history_source` ON `bedroom_history` (`source_id`,`id`);--> statement-breakpoint
CREATE TABLE `bedroom_latest` (
	`source_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`last_measured_at` integer,
	`report` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bedroom_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`config` text NOT NULL
);
