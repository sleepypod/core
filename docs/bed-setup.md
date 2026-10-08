# Bed setup, away status, and temperature zones

Settings → Sides includes a permanent bed setup: two sleepers, solo on the
left, or solo on the right. Existing installations default to two sleepers.
Changing setup preserves both profiles, saved schedules, and away dates.

Away mode is temporary and applies to a person. A solo sleeper can also go
away. An optional return date clears away status without changing bed setup.
The return picker uses the browser's local time and saves an absolute instant;
schedules continue to run in the pod's configured timezone.

When exactly one configured sleeper is home, the other temperature zone can:

- **Stay off** (default): recurring heat and power schedules are inactive.
- **Follow my schedule**: use the active sleeper's temperature and power schedule.
- **Use its own schedule**: keep an independent temperature and power schedule.

With no active sleepers, neither zone runs a recurring schedule. Explicit
manual controls and run-once sessions remain available. Alarm vibration and
alarm warm-up belong to active sleepers, even with independent zone schedules.

The temperature screen shows a link to these settings and labels the current
zone behavior. Both physical temperature cards remain available. The existing
Sides linked button controls manual adjustments independently; changing setup
or away status never changes that selection. Schedule editing follows the
thermal policy, so independent zones retain separate editors.

The core API stores `bedMode` (`two`, `solo-left`, `solo-right`) and
`unusedZoneMode` (`off`, `follow`, `independent`) in device settings. Both are
available through `settings.getAll` and `settings.updateDevice` (REST
`GET /api/settings` and `PATCH /api/settings/device`). The generated control-DB
migration defaults the unused zone to off, preserving the pre-PR away policy.

The Python workers read setup and away status every 60 seconds. With one active
sleeper they combine both sensor zones into that person's profile; with none
they stop creating sleep and vitals records. Old databases without `bed_mode`
retain the two-person setup fallback. Existing historical records are unchanged.
