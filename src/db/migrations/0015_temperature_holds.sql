CREATE TABLE `temperature_holds` (
	`side` text PRIMARY KEY NOT NULL,
	`temperature` real NOT NULL,
	`started_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
