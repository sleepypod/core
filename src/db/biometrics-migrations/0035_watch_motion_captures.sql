CREATE TABLE `watch_motion_captures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`version` text NOT NULL,
	`recorded_from` integer NOT NULL,
	`recorded_to` integer NOT NULL,
	`bins` integer NOT NULL,
	`trimmed_bins` integer NOT NULL,
	`sha256` text NOT NULL,
	`file` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_watch_motion_captures_side_recorded_from` ON `watch_motion_captures` (`side`,`recorded_from`);