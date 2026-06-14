CREATE TABLE `cap_sense_frames` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`timestamp` integer NOT NULL,
	`zones` text,
	`max` real NOT NULL,
	`mean` real NOT NULL,
	`spread` real NOT NULL,
	`peak_zone` integer,
	`frame_count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cap_sense_frames_side_ts` ON `cap_sense_frames` (`side`,`timestamp`);