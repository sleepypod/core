CREATE TABLE `target_response_models` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`created_at` integer NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_target_response_models_side_created` ON `target_response_models` (`side`,`created_at`);