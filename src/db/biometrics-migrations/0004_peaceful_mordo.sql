CREATE TABLE IF NOT EXISTS `ambient_light` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`lux` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_ambient_light_timestamp` ON `ambient_light` (`timestamp`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `water_level_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`started_at` integer NOT NULL,
	`dismissed_at` integer,
	`message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_water_level_alerts_dismissed` ON `water_level_alerts` (`dismissed_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `water_level_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`level` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_water_level_timestamp` ON `water_level_readings` (`timestamp`);
