CREATE TABLE `reference_stages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`source` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`stage` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reference_stages_side_source_start` ON `reference_stages` (`side`,`source`,`start`);