CREATE TABLE `household_browser_scopes` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`session_hash` text NOT NULL,
	`expires_at` integer NOT NULL
);
