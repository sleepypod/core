CREATE TABLE `comfort_experiment_observation_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_key` text NOT NULL,
	`admission_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`night_date` text NOT NULL,
	`window_end` integer NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`tail_digest` text NOT NULL,
	`finalized_at` integer,
	`binding` text NOT NULL,
	FOREIGN KEY (`admission_id`) REFERENCES `comfort_experiment_admissions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `comfort_experiments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_experiment_observation_window` ON `comfort_experiment_observation_windows` (`admission_id`,`night_date`);--> statement-breakpoint
CREATE INDEX `idx_experiment_observation_subject_end` ON `comfort_experiment_observation_windows` (`subject_key`,`window_end`);--> statement-breakpoint
CREATE TABLE `comfort_experiment_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`window_id` text NOT NULL,
	`position` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`digest` text NOT NULL,
	`record` text NOT NULL,
	FOREIGN KEY (`window_id`) REFERENCES `comfort_experiment_observation_windows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_experiment_observation_position` ON `comfort_experiment_observations` (`window_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_experiment_observation_clock` ON `comfort_experiment_observations` (`window_id`,`observed_at`);