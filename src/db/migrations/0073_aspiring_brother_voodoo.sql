CREATE TABLE `comfort_experiment_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_key` text NOT NULL,
	`scope_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`plan` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_comfort_experiment_reviews_subject_expiry` ON `comfort_experiment_reviews` (`subject_key`,`expires_at`);