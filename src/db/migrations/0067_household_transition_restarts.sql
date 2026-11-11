CREATE TABLE `household_arrangement_restarts` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`request` text NOT NULL,
	`controller` text NOT NULL,
	`receipt` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `household_arrangement_transitions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_arrangement_restarts_request_id_unique` ON `household_arrangement_restarts` (`request_id`);