CREATE TABLE `temperature_applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` text NOT NULL,
	`side` text NOT NULL,
	`attempted_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text NOT NULL,
	`request` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `temperature_applications_attempt` ON `temperature_applications` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `temperature_applications_side_id` ON `temperature_applications` (`side`,`id`);--> statement-breakpoint
CREATE INDEX `temperature_applications_retention` ON `temperature_applications` (`attempted_at`);