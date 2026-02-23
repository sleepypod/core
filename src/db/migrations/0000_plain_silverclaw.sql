CREATE TABLE `alarm_schedules` (
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
CREATE TABLE `device_settings` (
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
CREATE TABLE `device_state` (
	`side` text PRIMARY KEY NOT NULL,
	`current_temperature` real,
	`target_temperature` real,
	`is_powered` integer DEFAULT false NOT NULL,
	`is_alarm_vibrating` integer DEFAULT false NOT NULL,
	`water_level` text DEFAULT 'unknown',
	`last_updated` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `movement` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`timestamp` integer NOT NULL,
	`total_movement` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `power_schedules` (
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
CREATE TABLE `side_settings` (
	`side` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'Left' NOT NULL,
	`away_mode` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sleep_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`entered_bed_at` integer NOT NULL,
	`left_bed_at` integer NOT NULL,
	`sleep_duration_seconds` integer NOT NULL,
	`times_exited_bed` integer DEFAULT 0 NOT NULL,
	`present_intervals` text,
	`not_present_intervals` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `system_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`component` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`message` text,
	`last_checked` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tap_gestures` (
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
CREATE TABLE `temperature_schedules` (
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
CREATE TABLE `vitals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`timestamp` integer NOT NULL,
	`heart_rate` real,
	`hrv` real,
	`breathing_rate` real
);
