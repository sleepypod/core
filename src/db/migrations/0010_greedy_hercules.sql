ALTER TABLE `device_settings` ADD `pump_stall_protection_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `pump_stall_rpm_threshold` integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `pump_stall_dwell_samples` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `pump_stall_auto_recovery_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `pump_stall_recovery_rpm` integer DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `pump_stall_recovery_samples` integer DEFAULT 3 NOT NULL;