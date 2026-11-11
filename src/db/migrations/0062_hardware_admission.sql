CREATE TABLE `hardware_admission` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`hold_id` text,
	`held_at` integer
);
--> statement-breakpoint
INSERT INTO `hardware_admission` (`id`, `revision`, `hold_id`, `held_at`) VALUES (1, 1, NULL, NULL);
