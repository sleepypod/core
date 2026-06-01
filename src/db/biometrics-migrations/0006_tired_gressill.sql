CREATE TABLE `flow_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`left_flowrate_cd` integer,
	`right_flowrate_cd` integer,
	`left_pump_rpm` integer,
	`right_pump_rpm` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_flow_readings_timestamp` ON `flow_readings` (`timestamp`);