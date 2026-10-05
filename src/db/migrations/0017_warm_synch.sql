CREATE TABLE `base_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_of_week` text NOT NULL,
	`time` text NOT NULL,
	`head` integer NOT NULL,
	`feet` integer NOT NULL,
	`feed_rate` integer DEFAULT 50 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `base_schedules_day_time` ON `base_schedules` (`day_of_week`,`time`);