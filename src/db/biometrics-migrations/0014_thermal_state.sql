CREATE TABLE `thermal_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`side` text NOT NULL,
	`is_powered` integer NOT NULL,
	`target_temp_f` real,
	`current_temp_f` real
);
--> statement-breakpoint
CREATE INDEX `idx_thermal_state_timestamp` ON `thermal_state` (`timestamp`);