CREATE TABLE `morning_reports` (
	`scope_key` text NOT NULL,
	`report_id` text NOT NULL,
	`created_at` integer,
	`received_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` text NOT NULL,
	`original_hash` text,
	`document_hash` text,
	`payload` text,
	`deleted_at` integer,
	PRIMARY KEY(`scope_key`, `report_id`)
);
--> statement-breakpoint
CREATE INDEX `morning_reports_recent` ON `morning_reports` (`scope_key`,`created_at`);