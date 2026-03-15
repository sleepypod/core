CREATE TABLE `bed_temp` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`ambient_temp` integer,
	`mcu_temp` integer,
	`humidity` integer,
	`left_outer_temp` integer,
	`left_center_temp` integer,
	`left_inner_temp` integer,
	`right_outer_temp` integer,
	`right_center_temp` integer,
	`right_inner_temp` integer
);
--> statement-breakpoint
CREATE INDEX `idx_bed_temp_timestamp` ON `bed_temp` (`timestamp`);--> statement-breakpoint
CREATE TABLE `freezer_temp` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`ambient_temp` integer,
	`heatsink_temp` integer,
	`left_water_temp` integer,
	`right_water_temp` integer
);
--> statement-breakpoint
CREATE INDEX `idx_freezer_temp_timestamp` ON `freezer_temp` (`timestamp`);