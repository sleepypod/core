CREATE TABLE `thermal_forecasts` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`created_at` integer NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_thermal_forecasts_side_created` ON `thermal_forecasts` (`side`,`created_at`);