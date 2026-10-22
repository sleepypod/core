CREATE TABLE `heartbeats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`timestamp` integer NOT NULL,
	`beats` text NOT NULL,
	`quality` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_heartbeats_side_timestamp` ON `heartbeats` (`side`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_heartbeats_timestamp` ON `heartbeats` (`timestamp`);