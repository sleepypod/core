PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_device_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`timezone` text DEFAULT 'America/Los_Angeles' NOT NULL,
	`temperature_unit` text DEFAULT 'F' NOT NULL,
	`reboot_daily` integer DEFAULT false NOT NULL,
	`reboot_time` text DEFAULT '03:00',
	`prime_pod_daily` integer DEFAULT false NOT NULL,
	`prime_pod_time` text DEFAULT '14:00',
	`led_night_mode_enabled` integer DEFAULT false NOT NULL,
	`led_day_brightness` integer DEFAULT 100 NOT NULL,
	`led_night_brightness` integer DEFAULT 0 NOT NULL,
	`led_night_start_time` text DEFAULT '22:00',
	`led_night_end_time` text DEFAULT '07:00',
	`global_max_on_hours` integer,
	`mqtt_enabled` integer,
	`mqtt_url` text,
	`mqtt_username` text,
	`mqtt_password` text,
	`mqtt_topic_prefix` text,
	`mqtt_ha_discovery` integer,
	`mqtt_tls_enabled` integer,
	`mqtt_tls_insecure` integer,
	`homekit_enabled` integer DEFAULT false NOT NULL,
	`pump_stall_protection_enabled` integer DEFAULT false NOT NULL,
	`pump_stall_rpm_threshold` integer DEFAULT 500 NOT NULL,
	`pump_stall_dwell_samples` integer DEFAULT 2 NOT NULL,
	`pump_stall_auto_recovery_enabled` integer DEFAULT false NOT NULL,
	`pump_stall_recovery_rpm` integer DEFAULT 1500 NOT NULL,
	`pump_stall_recovery_samples` integer DEFAULT 3 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_device_settings`("id", "timezone", "temperature_unit", "reboot_daily", "reboot_time", "prime_pod_daily", "prime_pod_time", "led_night_mode_enabled", "led_day_brightness", "led_night_brightness", "led_night_start_time", "led_night_end_time", "global_max_on_hours", "mqtt_enabled", "mqtt_url", "mqtt_username", "mqtt_password", "mqtt_topic_prefix", "mqtt_ha_discovery", "mqtt_tls_enabled", "mqtt_tls_insecure", "homekit_enabled", "pump_stall_protection_enabled", "pump_stall_rpm_threshold", "pump_stall_dwell_samples", "pump_stall_auto_recovery_enabled", "pump_stall_recovery_rpm", "pump_stall_recovery_samples", "created_at", "updated_at") SELECT "id", "timezone", "temperature_unit", "reboot_daily", "reboot_time", "prime_pod_daily", "prime_pod_time", "led_night_mode_enabled", "led_day_brightness", "led_night_brightness", "led_night_start_time", "led_night_end_time", "global_max_on_hours", "mqtt_enabled", "mqtt_url", "mqtt_username", "mqtt_password", "mqtt_topic_prefix", "mqtt_ha_discovery", "mqtt_tls_enabled", "mqtt_tls_insecure", "homekit_enabled", "pump_stall_protection_enabled", "pump_stall_rpm_threshold", "pump_stall_dwell_samples", "pump_stall_auto_recovery_enabled", "pump_stall_recovery_rpm", "pump_stall_recovery_samples", "created_at", "updated_at" FROM `device_settings`;--> statement-breakpoint
DROP TABLE `device_settings`;--> statement-breakpoint
ALTER TABLE `__new_device_settings` RENAME TO `device_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;