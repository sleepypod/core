CREATE TABLE `schedule_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`day_of_week` text NOT NULL,
	`notes` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_schedule_notes_side_day` ON `schedule_notes` (`side`,`day_of_week`);