CREATE TABLE `comfort_activations` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`created_at` integer NOT NULL,
	`snapshot` text NOT NULL,
	`revoked_at` integer,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `comfort_activations_side` ON `comfort_activations` (`side`,`created_at`);--> statement-breakpoint
CREATE TABLE `comfort_owner_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`review` text NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `comfort_owner_reviews_expiry` ON `comfort_owner_reviews` (`expires_at`);--> statement-breakpoint
CREATE TABLE `comfort_qualifications` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`side` text NOT NULL,
	`kind` text NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comfort_qualifications_id_unique` ON `comfort_qualifications` (`id`);--> statement-breakpoint
CREATE INDEX `comfort_qualifications_side_kind` ON `comfort_qualifications` (`side`,`kind`,`sequence`);--> statement-breakpoint
CREATE TABLE `comfort_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`side` text NOT NULL,
	`created_at` integer NOT NULL,
	`snapshot` text NOT NULL,
	`note` text NOT NULL
);
