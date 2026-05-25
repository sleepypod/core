CREATE TABLE `pump_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`type` text NOT NULL,
	`side` text,
	`rpm` integer,
	`flowrate_cd` integer,
	`duration_seconds` integer,
	`action` text DEFAULT 'none' NOT NULL,
	`restore_target_temperature` integer,
	`restore_duration_seconds` integer,
	`acknowledged_at` integer,
	`dismissed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_pump_alerts_timestamp` ON `pump_alerts` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_pump_alerts_acknowledged` ON `pump_alerts` (`acknowledged_at`);