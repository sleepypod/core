CREATE TABLE `comfort_moments` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_comfort_moments_side_recorded` ON `comfort_moments` (`side`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `temporary_cooling` (
	`side` text PRIMARY KEY NOT NULL,
	`record` text NOT NULL
);
