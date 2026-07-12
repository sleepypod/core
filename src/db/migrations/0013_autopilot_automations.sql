CREATE TABLE `automation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`automation_id` integer NOT NULL,
	`fired_at` integer DEFAULT (unixepoch()) NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_automation_runs_automation_fired` ON `automation_runs` (`automation_id`,`fired_at`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`side` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`dry_run` integer DEFAULT true NOT NULL,
	`cooldown_min` integer,
	`trigger` text NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_automations_enabled` ON `automations` (`enabled`);