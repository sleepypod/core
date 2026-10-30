CREATE TABLE `notification_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`acknowledged_at` integer
);
--> statement-breakpoint
CREATE INDEX `notification_inbox_fingerprint_created` ON `notification_inbox` (`fingerprint`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_inbox_created` ON `notification_inbox` (`created_at`);