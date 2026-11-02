CREATE TABLE `comfort_models` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`created_at` integer NOT NULL,
	`dataset_hash` text NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_comfort_models_side_created` ON `comfort_models` (`side`,`created_at`);