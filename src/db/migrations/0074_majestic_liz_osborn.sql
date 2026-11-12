CREATE TABLE `comfort_experiment_applications` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`plan_id` text NOT NULL,
	`side` text NOT NULL,
	`outcome` text NOT NULL,
	`reserved_at` integer NOT NULL,
	`record` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `comfort_experiments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comfort_experiment_applications_id_unique` ON `comfort_experiment_applications` (`id`);--> statement-breakpoint
CREATE INDEX `idx_experiment_applications_side_sequence` ON `comfort_experiment_applications` (`side`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_experiment_application_unresolved_side` ON `comfort_experiment_applications` (`side`) WHERE "comfort_experiment_applications"."outcome" IN ('attempting', 'unknown');