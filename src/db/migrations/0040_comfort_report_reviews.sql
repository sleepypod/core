CREATE TABLE `comfort_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`report_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`review` text NOT NULL,
	`snapshot` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_comfort_reviews_side_report` ON `comfort_reviews` (`side`,`report_id`,`id`);--> statement-breakpoint
ALTER TABLE `comfort_events` ADD `report_id` text;--> statement-breakpoint
CREATE INDEX `idx_comfort_events_side_report` ON `comfort_events` (`side`,`report_id`,`id`);