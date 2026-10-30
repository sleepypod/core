CREATE TABLE `comfort_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`observed_at` integer NOT NULL,
	`event` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_comfort_events_side_time` ON `comfort_events` (`side`,`observed_at`);--> statement-breakpoint
CREATE TABLE `comfort_feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`local_date` text NOT NULL,
	`comfort` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_comfort_feedback_side_date` ON `comfort_feedback` (`side`,`local_date`);--> statement-breakpoint
CREATE TABLE `comfort_states` (
	`side` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL
);
