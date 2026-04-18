ALTER TABLE `device_settings` ADD `global_max_on_hours` integer;
--> statement-breakpoint
-- Seed powered_on_at for sides that are currently powered on but missing the
-- timestamp (existing installs predate 0000's powered_on_at column being
-- populated on every write path). Without this, the global cap would never
-- fire on upgrades since powered_on_at stays NULL until the next OFF→ON edge.
UPDATE `device_state` SET `powered_on_at` = unixepoch() WHERE `is_powered` = 1 AND `powered_on_at` IS NULL;