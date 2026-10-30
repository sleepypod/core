ALTER TABLE `curve_templates` ADD `end_action` text DEFAULT 'turn_off' NOT NULL;--> statement-breakpoint
ALTER TABLE `curve_templates` ADD `left_days` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `curve_templates` ADD `right_days` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `curve_templates` ADD `active` integer DEFAULT false NOT NULL;