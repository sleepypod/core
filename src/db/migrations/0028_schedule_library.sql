ALTER TABLE `curve_templates` ADD `end_action` text DEFAULT 'turn_off' NOT NULL;--> statement-breakpoint
ALTER TABLE `curve_templates` ADD `left_days` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `curve_templates` ADD `right_days` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `curve_templates` ADD `active` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- One-time marker, deliberately not in schema.ts: runMigrations (src/db/migrate.ts)
-- adds the schedules that predate the library to it and drops this table in the
-- same transaction, so an attempt that fails is retried on the next start.
CREATE TABLE `schedule_library_adoption` (`id` integer PRIMARY KEY NOT NULL);--> statement-breakpoint
INSERT INTO `schedule_library_adoption` (`id`) VALUES (1);
