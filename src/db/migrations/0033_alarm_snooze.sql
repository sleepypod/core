ALTER TABLE `alarm_schedules` ADD `snooze_duration` integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE `alarm_schedules` ADD `snooze_taper` integer DEFAULT 0 NOT NULL;