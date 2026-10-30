CREATE TABLE `journal_entries` (
	`side` text NOT NULL,
	`local_date` text NOT NULL,
	`revision` text NOT NULL,
	`record` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_journal_entries_side_date` ON `journal_entries` (`side`,`local_date`);