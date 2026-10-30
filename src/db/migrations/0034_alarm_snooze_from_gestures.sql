-- The snooze length moved from tap gestures to alarms. Carry over what each
-- side's snoozing gesture was set to (the first by tap count), so existing
-- snoozes keep their length; sides without one keep the 5 minute default.
UPDATE `alarm_schedules` SET `snooze_duration` = (
  SELECT MIN(MAX(`g`.`alarm_snooze_duration`, 60), 1800) FROM `tap_gestures` `g`
  WHERE `g`.`side` = `alarm_schedules`.`side`
    AND `g`.`action_type` = 'alarm'
    AND `g`.`alarm_behavior` = 'snooze'
    AND `g`.`alarm_snooze_duration` IS NOT NULL
  ORDER BY CASE `g`.`tap_type` WHEN 'doubleTap' THEN 0 WHEN 'tripleTap' THEN 1 ELSE 2 END
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM `tap_gestures` `g`
  WHERE `g`.`side` = `alarm_schedules`.`side`
    AND `g`.`action_type` = 'alarm'
    AND `g`.`alarm_behavior` = 'snooze'
    AND `g`.`alarm_snooze_duration` IS NOT NULL
);

--> statement-breakpoint
-- Bedtime metadata owns these alarm rows. Keep its normalized representation in
-- step so the ownership validator and revision checks remain valid after upgrade.
UPDATE bedtime_routines SET configuration = json_set(
  configuration,
  '$.alarm.snoozeDuration', (SELECT snooze_duration FROM alarm_schedules WHERE id = json_extract(bedtime_routines.schedule_ids, '$.alarm[0]')),
  '$.alarm.snoozeTaper', (SELECT snooze_taper FROM alarm_schedules WHERE id = json_extract(bedtime_routines.schedule_ids, '$.alarm[0]'))
)
WHERE json_type(configuration, '$.alarm') = 'object'
  AND EXISTS (SELECT 1 FROM alarm_schedules WHERE id = json_extract(bedtime_routines.schedule_ids, '$.alarm[0]'));
