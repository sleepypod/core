ALTER TABLE `device_settings` ADD `led_night_mode_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `led_day_brightness` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `led_night_brightness` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `led_night_start_time` text DEFAULT '22:00';--> statement-breakpoint
ALTER TABLE `device_settings` ADD `led_night_end_time` text DEFAULT '07:00';--> statement-breakpoint
ALTER TABLE `side_settings` ADD `away_start` text;--> statement-breakpoint
ALTER TABLE `side_settings` ADD `away_return` text;