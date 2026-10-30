CREATE TABLE `household_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`sleeper_id` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`session_revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_accounts_sleeper_id_unique` ON `household_accounts` (`sleeper_id`);--> statement-breakpoint
CREATE TABLE `household_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_devices_token_hash_unique` ON `household_devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `household_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`issuer_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`target_account_id` text,
	`claimed_device_id` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issuer_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claimed_device_id`) REFERENCES `household_devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_invitations_token_hash_unique` ON `household_invitations` (`token_hash`);--> statement-breakpoint
CREATE TABLE `household_mutation_receipts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_hash` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `household_personal_settings` (
	`account_id` text PRIMARY KEY NOT NULL,
	`preferences` text NOT NULL,
	`preferences_revision` integer DEFAULT 1 NOT NULL,
	`routines` text NOT NULL,
	`routines_revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`pod_id` text NOT NULL,
	`setup_request_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`assignment_revision` integer DEFAULT 1 NOT NULL,
	`mode` text NOT NULL,
	`source_side` text NOT NULL,
	`effective_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `households_pod_id_unique` ON `households` (`pod_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `households_setup_request_id_unique` ON `households` (`setup_request_id`);