CREATE TABLE `bedtime_routines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`day_of_week` text NOT NULL,
	`configuration` text NOT NULL,
	`schedule_ids` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bedtime_routines_side_day` ON `bedtime_routines` (`side`,`day_of_week`);