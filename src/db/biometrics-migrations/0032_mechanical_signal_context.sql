CREATE TABLE `biometric_mechanical_spans` (
	`id` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mechanical_span_window` ON `biometric_mechanical_spans` (`end_ms`,`start_ms`);--> statement-breakpoint
CREATE TABLE `biometric_mechanical_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
