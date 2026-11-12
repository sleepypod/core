CREATE TABLE `comfort_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_key` text NOT NULL,
	`revision` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_comfort_experiments_subject_created` ON `comfort_experiments` (`subject_key`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_comfort_experiments_open_subject` ON `comfort_experiments` (`subject_key`) WHERE "comfort_experiments"."status" = 'planned';