CREATE TABLE `room_context_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision` integer NOT NULL,
	`metric` text NOT NULL,
	`entity_id` text NOT NULL,
	`unit` text NOT NULL,
	`measured_at` integer,
	`reported_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`value` real,
	`available` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `room_context_history_received` ON `room_context_history` (`received_at`);--> statement-breakpoint
CREATE TABLE `room_context_latest` (
	`metric` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`measured_at` integer,
	`last_measured_at` integer,
	`reported_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`value` real,
	`available` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `room_context_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`config` text NOT NULL
);
