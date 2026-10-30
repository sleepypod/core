ALTER TABLE `household_accounts` ADD `assigned_side` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_household_assigned_side` ON `household_accounts` (`household_id`,`assigned_side`);