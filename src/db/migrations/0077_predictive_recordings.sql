CREATE TABLE `predictive_recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`observed_at` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`session` text NOT NULL,
	`content_hash` text NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_predictive_recordings_side_recorded` ON `predictive_recordings` (`side`,`recorded_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_predictive_recordings_observation` ON `predictive_recordings` (`side`,`observed_at`);