DROP INDEX `idx_water_level_timestamp`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_water_level_timestamp` ON `water_level_readings` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_water_level_alerts_dismissed` ON `water_level_alerts` (`dismissed_at`);