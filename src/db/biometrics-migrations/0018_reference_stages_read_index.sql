DROP INDEX `uq_reference_stages_side_source_start`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reference_stages_side_start_source` ON `reference_stages` (`side`,`start`,`source`);