CREATE TABLE `run_once_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`set_points` text NOT NULL,
	`wake_time` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_run_once_side_status` ON `run_once_sessions` (`side`,`status`);