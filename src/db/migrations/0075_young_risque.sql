CREATE TABLE `comfort_experiment_admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_key` text NOT NULL,
	`plan_id` text NOT NULL,
	`admitted_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`revoked_at` integer,
	`record` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `comfort_experiment_execution_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `comfort_experiments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_experiment_admissions_subject_plan` ON `comfort_experiment_admissions` (`subject_key`,`plan_id`);--> statement-breakpoint
CREATE TABLE `comfort_experiment_execution_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_key` text NOT NULL,
	`scope_hash` text NOT NULL,
	`plan_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`record` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `comfort_experiments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_experiment_execution_reviews_subject_expiry` ON `comfort_experiment_execution_reviews` (`subject_key`,`expires_at`);--> statement-breakpoint
CREATE TABLE `comfort_experiment_zone_claims` (
	`side` text PRIMARY KEY NOT NULL,
	`admission_id` text NOT NULL,
	FOREIGN KEY (`admission_id`) REFERENCES `comfort_experiment_admissions`(`id`) ON UPDATE no action ON DELETE no action
);
