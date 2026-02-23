PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_side_settings` (
	`side` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`away_mode` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_side_settings`("side", "name", "away_mode", "created_at", "updated_at") SELECT "side", "name", "away_mode", "created_at", "updated_at" FROM `side_settings`;--> statement-breakpoint
DROP TABLE `side_settings`;--> statement-breakpoint
ALTER TABLE `__new_side_settings` RENAME TO `side_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_alarm_schedules_side_day` ON `alarm_schedules` (`side`,`day_of_week`);--> statement-breakpoint
CREATE INDEX `idx_movement_side_timestamp` ON `movement` (`side`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_power_schedules_side_day` ON `power_schedules` (`side`,`day_of_week`);--> statement-breakpoint
CREATE INDEX `idx_sleep_records_side_entered` ON `sleep_records` (`side`,`entered_bed_at`);--> statement-breakpoint
CREATE INDEX `idx_temp_schedules_side_day_time` ON `temperature_schedules` (`side`,`day_of_week`,`time`);--> statement-breakpoint
CREATE INDEX `idx_vitals_side_timestamp` ON `vitals` (`side`,`timestamp`);