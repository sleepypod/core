CREATE TABLE `stage_classifier_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`before` text,
	`after` text,
	`summary` text NOT NULL,
	`agreement_before` real,
	`agreement_after` real
);
--> statement-breakpoint
CREATE INDEX `idx_stage_classifier_changes_side_changed_at` ON `stage_classifier_changes` (`side`,`changed_at`);