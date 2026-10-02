CREATE TABLE `prime_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_prime_events_timestamp` ON `prime_events` (`timestamp`);