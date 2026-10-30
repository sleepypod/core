CREATE TABLE `side_stage_models` (
	`side` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`version` text NOT NULL,
	`model_hash` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`active` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stage_model_library` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`model` text NOT NULL,
	`version` text NOT NULL,
	`model_hash` text NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stage_model_library_side_idx` ON `stage_model_library` (`side`);--> statement-breakpoint
CREATE UNIQUE INDEX `stage_model_library_side_hash` ON `stage_model_library` (`side`,`model_hash`);