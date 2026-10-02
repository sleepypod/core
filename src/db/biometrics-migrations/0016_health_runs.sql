CREATE TABLE `health_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`check_id` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`started_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_health_runs_check_started` ON `health_runs` (`check_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_health_runs_last_seen` ON `health_runs` (`last_seen_at`);