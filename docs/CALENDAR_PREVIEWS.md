# Calendar dates in overnight previews

Temperature scheduler rows use the actual calendar weekday and clock time.
A Monday 06:00 row runs on Monday morning. A Monday bedtime routine that
includes a following-morning 06:00 phase compiles that phase into a Tuesday
row; the bedtime API retains its Monday ownership separately.

Night previews must therefore combine Monday afternoon/evening rows with
Tuesday morning rows. Previously several web views took every Monday row
and shifted its early clocks to Tuesday. That could display the wrong target
when adjacent weekdays differed, or invent a following-morning point that
was not scheduled.

`src/lib/calendarTemperature.ts` now provides the shared projection for
Schedule, Temp, the 3D stage, Autopilot and diagnostic night views. Noon is
the display boundary: the starting day's clocks at or after noon and the
following day's clocks before noon belong to the displayed night. Explicit
display offsets keep morning-only and long curves on their actual dates.
The next-change readout uses each row's calendar occurrence directly.

This projection does not rewrite saved rows, change controller ownership,
infer whether a sleeper is present, or issue hardware commands. Editable
curve templates retain their existing ordering behavior; display offsets
are only attached to projected calendar rows. These helpers retain the
existing browser-local clock convention. Device-timezone rendering when
the browser is in a different zone remains a separate UI concern.

Regression checks cover distinct adjacent mornings, Saturday/Sunday rollover,
disabled points, morning-only curves, stage scrubbing and shared chart
offsets. A separate process checks Los Angeles spring-forward and fall-back
dates against the scheduler's cron parser, including the different elapsed
length of those overnight windows. These are software checks, not physical
Pod observations or Preview nights.
