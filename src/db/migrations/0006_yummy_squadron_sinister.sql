-- Remove pre-existing duplicates before creating the unique index. The app
-- treats (side, tap_type) as a primary key, so any extra rows are stale
-- and keeping the newest id (highest autoincrement) is correct.
DELETE FROM `tap_gestures`
WHERE `id` NOT IN (
  SELECT MAX(`id`) FROM `tap_gestures` GROUP BY `side`, `tap_type`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tap_side_type` ON `tap_gestures` (`side`,`tap_type`);