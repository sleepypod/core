CREATE TABLE `alarm_occurrences` (
	`side` text NOT NULL,
	`schedule_id` integer NOT NULL,
	`original_at` integer NOT NULL,
	`effective_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`attempted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alarm_occurrences_identity` ON `alarm_occurrences` (`side`,`schedule_id`,`original_at`);--> statement-breakpoint
CREATE INDEX `idx_alarm_occurrences_retention` ON `alarm_occurrences` (`attempted_at`);--> statement-breakpoint
CREATE TABLE `alarm_overrides` (
	`side` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`record` text
);
