DROP INDEX `base_schedules_day_time`;--> statement-breakpoint
ALTER TABLE `base_schedules` ADD `side` text DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE `base_schedules` ADD `preset_name` text DEFAULT 'Custom' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `base_schedules_day_time_side` ON `base_schedules` (`day_of_week`,`time`,`side`);