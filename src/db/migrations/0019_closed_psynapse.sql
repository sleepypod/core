ALTER TABLE `device_settings` ADD `bed_mode` text DEFAULT 'two' NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `unused_zone_mode` text DEFAULT 'off' NOT NULL;