CREATE TABLE `curve_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`bedtime` text NOT NULL,
	`wake` text NOT NULL,
	`points` text NOT NULL,
	`reasoning` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_curve_templates_name` ON `curve_templates` (`name`);