ALTER TABLE `device_settings` ADD `mqtt_enabled` integer;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mqtt_url` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mqtt_username` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mqtt_password` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mqtt_topic_prefix` text;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mqtt_ha_discovery` integer;--> statement-breakpoint
ALTER TABLE `device_settings` ADD `mqtt_tls_enabled` integer;