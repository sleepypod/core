CREATE TABLE IF NOT EXISTS `calibration_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`sensor_type` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`parameters` text NOT NULL,
	`quality_score` real,
	`source_window_start` integer,
	`source_window_end` integer,
	`samples_used` integer,
	`error_message` text,
	`created_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cal_type_status` ON `calibration_profiles` (`sensor_type`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_cal_side_type_active` ON `calibration_profiles` (`side`,`sensor_type`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `calibration_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`sensor_type` text NOT NULL,
	`status` text NOT NULL,
	`parameters` text,
	`quality_score` real,
	`source_window_start` integer,
	`source_window_end` integer,
	`samples_used` integer,
	`error_message` text,
	`duration_ms` integer,
	`triggered_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cal_runs_side_type` ON `calibration_runs` (`side`,`sensor_type`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vitals_quality` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vitals_id` integer NOT NULL,
	`side` text NOT NULL,
	`timestamp` integer NOT NULL,
	`quality_score` real NOT NULL,
	`flags` text,
	`hr_raw` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vq_vitals_id` ON `vitals_quality` (`vitals_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vq_side_ts` ON `vitals_quality` (`side`,`timestamp`);
