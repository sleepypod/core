CREATE TABLE `stage_model_library` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`model` text NOT NULL,
	`version` text NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stage_model_library_side_idx` ON `stage_model_library` (`side`);
--> statement-breakpoint
INSERT INTO `stage_model_library` (`side`, `model`, `version`, `uploaded_at`)
SELECT `side`, `model`, `version`, `uploaded_at` FROM `side_stage_models`;
