CREATE TABLE IF NOT EXISTS `alarm_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`day_of_week` text NOT NULL,
	`time` text NOT NULL,
	`vibration_intensity` integer NOT NULL,
	`vibration_pattern` text DEFAULT 'rise' NOT NULL,
	`duration` integer NOT NULL,
	`alarm_temperature` real NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_alarm_schedules_side_day` ON `alarm_schedules` (`side`,`day_of_week`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `device_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`timezone` text DEFAULT 'America/Los_Angeles' NOT NULL,
	`temperature_unit` text DEFAULT 'F' NOT NULL,
	`reboot_daily` integer DEFAULT false NOT NULL,
	`reboot_time` text DEFAULT '03:00',
	`prime_pod_daily` integer DEFAULT false NOT NULL,
	`prime_pod_time` text DEFAULT '14:00',
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `device_state` (
	`side` text PRIMARY KEY NOT NULL,
	`current_temperature` real,
	`target_temperature` real,
	`is_powered` integer DEFAULT false NOT NULL,
	`is_alarm_vibrating` integer DEFAULT false NOT NULL,
	`water_level` text DEFAULT 'unknown',
	`powered_on_at` integer,
	`last_updated` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `power_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`day_of_week` text NOT NULL,
	`on_time` text NOT NULL,
	`off_time` text NOT NULL,
	`on_temperature` real NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_power_schedules_side_day` ON `power_schedules` (`side`,`day_of_week`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `side_settings` (
	`side` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`away_mode` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `system_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`component` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`message` text,
	`last_checked` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `system_health_component_unique` ON `system_health` (`component`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tap_gestures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`tap_type` text NOT NULL,
	`action_type` text NOT NULL,
	`temperature_change` text,
	`temperature_amount` integer,
	`alarm_behavior` text,
	`alarm_snooze_duration` integer,
	`alarm_inactive_behavior` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `temperature_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`day_of_week` text NOT NULL,
	`time` text NOT NULL,
	`temperature` real NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_temp_schedules_side_day_time` ON `temperature_schedules` (`side`,`day_of_week`,`time`);