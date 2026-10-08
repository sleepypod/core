# Adjustable-base control

> **Experimental.** Adjustable-base control has been verified only against simulated hardware; it has not been qualified on a physical TriMix base (see [Deployment and qualification](#deployment-and-qualification)). The Base page shows an **Experimental** badge. Per-side movement is locked until a base firmware dump confirms the per-side motor selectors.

Open **Base** from the main menu (`/<language>/base`). The menu item appears only when valid local base configuration exists; a temporary Bluetooth disconnect does not hide it. With no base configured, open the URL directly. The hosted demo always includes Base. The bed view draws the split base in 3D (three.js) and falls back to a 2D side view; see [Bed view](#bed-view). Head/feet steppers and presets edit a target; **Move** sends it with the selected speed. **Move immediately when selecting a preset** is an opt-in browser preference. **Stop both** always remains enabled and reports delivery failures visibly.

The per-side layouts from the design's 2a/2b are selectable as **Side cards** and **Single card** when `independentControl` is true. That is locked off: while `INDEPENDENT_CONTROL_UNLOCKED` in `src/hardware/base/types.ts` is `false`, the hardware, the hosted demo and `?debug=1` all report whole-bed control. The page then shows one whole-bed card, and one-sided moves and schedules are rejected. Flip the flag only after firmware confirms per-side actuation. Side cards have independent targets and a persisted link toggle; linking copies the left target to the right. Single card has a persisted Both/name/name scope switch and overlays both measured positions. Names come from side settings. Both layouts share targets, speed and schedules. The demo simulates movement and Stop over time; it simulates independent movement only when unlocked.

## Bed view

The bed view is decorative; the text line under it is the exact measured readout. The 3D view loads a pinned three.js (0.170.0) in the browser from jsDelivr, then unpkg, then the copy the pod serves at `/vendor/three.module.min.js`, allowing 4 s per source, so pods on LANs without internet access still get 3D. Without WebGL, if every source fails, or if the WebGL context is lost, the page shows the 2D side view. Drag the 3D view to rotate and tilt it; pinch or ⌘/Ctrl + scroll to zoom; double-click or double-tap to reset. On touch, one finger rotates and vertical swipes still scroll the page, while two fingers tilt and zoom. **Show mattress** adds a mattress and pillows, and **Simple bed view** always uses 2D. Both are browser preferences. With reduced motion enabled, the bed snaps to each measurement instead of easing toward it.

## Preview without hardware

Open `/<language>/base?debug=1` to simulate the base on a normal pod build. A visible **Base debug** banner identifies this mode. Movement, presets, Stop and schedules use a fresh in-memory base for that page session. The per-side layouts appear only when per-side control is unlocked. Every `base.*` call is intercepted, including unknown operations, so the debug page never sends base writes or stores schedules on the pod. Other reads, such as side names and timezone, still use the normal settings source.

Debug queries use a separate query cache and transport; **Exit debug** reloads the normal Base page. Simulated schedules reset on reload/exit. Menu availability continues to reflect the real configuration. `?debug=1` only applies to the Base page, and is separate from the whole-app `NEXT_PUBLIC_DEMO=1` build mode.

## Setup and supported hardware

This is the TriMix protocol investigated in [free-sleep beta](../research/free-sleep-adjustable-base.md), implemented under [ADR 0024](../adr/0024-adjustable-base-control.md). It uses the Pod's local BlueZ system bus, separately from DAC and temperature control.

Complete the base's stock setup/pairing first. The Pod must have a readable `/persistent/AdjustableBaseConfiguration.json`, for example:

```json
{"Address":"AA:BB:CC:DD:EE:FF","SplitBase":false}
```

The address is the already-paired base, not the Pod. The controller validates both fields and discovers notification FFE1 and write FFE3 characteristics under that device. Adapter numbers and GATT handles are not fixed. FFE3 must support acknowledged `write` requests. The sleepypod service needs access to the system D-Bus/BlueZ service; the normal Pod service runs as root. No new port or cloud service is needed.

Use Reconnect after setup/configuration changes. Missing configuration does not start Bluetooth and does not affect temperature control. Failed connections retry with bounded backoff; movement commands are never replayed after reconnect. A restart also never restores an old requested base position.

The current TriMix transport supports synchronized whole-bed positioning only and reports `independentControl: false`, including when `SplitBase: true`. The UI therefore falls back to one whole-bed card and hides the per-side switches. One-sided API commands and schedules are rejected rather than silently moving both halves. Independent hardware commands require a separately qualified transport. Calibrated limits remain 60° head and 45° feet; minimum speed is 30%, so the design’s 25% segment is disabled and 50/75/100% are available.

## Status and schedules

Measured positions come only from checksum-valid position notifications. A fresh connection starts with unknown angles. After ten seconds without a position notification, the display becomes unavailable and new moves are blocked. Stop remains enabled even offline or with stale telemetry; offline commands return a visible error. A successful command response acknowledges the Bluetooth write, not physical arrival or physical stopping. Motion is estimated from tick changes and shown as unknown when stale.

Schedules use the device timezone and the selected **calendar day** (Monday 01:00 means early Monday, not Tuesday). Rows include a side (`both`, `left`, `right`), preset name, and a single day, Daily, Weekdays, or Weekends. Overlapping day/time slots for the same physical side are rejected. Only the selected side’s away mode suppresses a side schedule; `both` is suppressed if either side is away. The current synchronized transport only accepts `both`. Cooling power does not gate base movement. The sentence form (side cards) and compact form (single card) add named presets; Delete removes a row. The API retains update and pause support for existing clients. Legacy schedules migrate to `both` without changing their targets or enabled state. Missed or failed movements are not caught up or retried. A callback or lock wait more than one minute late is skipped. Changing timezone rebuilds recurring jobs through the existing JobManager reload path.

## Local API

The same LAN-only trust model as the rest of the Pod applies. REST paths below have `/api` prepended; corresponding tRPC procedures live under `base`.

| REST | Purpose |
| --- | --- |
| GET `/base/availability` | `{configured}` from validated local setup, without connecting Bluetooth |
| GET `/base/status` | Connection, separate-side measured position, age/stale state, global and per-side estimated motion (`movingBySide`), `independentControl` capability |
| POST `/base/reconnect` with `{}` | Reload stock configuration and reconnect |
| POST `/base/position` | `{head: 0..60, feet: 0..45, feedRate: 30..100}`; integers; rate defaults to 50; `sides` defaults to `["left", "right"]` |
| POST `/base/preset` | `{preset: "flat" | "sleep" | "relax" | "read", sides?: ["left", "right"]}` |
| POST `/base/stop` with `{}` | Cancel pending movement and send synchronized stop |
| GET `/base/schedules` | List scheduled positions |
| POST `/base/schedules` | Create/update: optional `id`, `dayOfWeek`, `time` (HH:mm), `enabled`, head/feet/rate, `side` (defaults to `both`), `presetName`; `dayOfWeek` also accepts `daily`, `weekdays`, `weekends` |
| DELETE `/base/schedules/{id}` | Remove a schedule |

## Deployment and qualification

Configuration database migration `0018_amazing_captain_marvel` is generated by Drizzle and run through the existing startup migration path. There is no biometrics migration. `dbus-next` is a server external dependency. Its pinned pnpm patch makes the unused desktop X11 import optional so Next's standalone tracer can package the system-bus client. The optional usocket native addon is excluded by a package-scoped pnpm override; Node's Unix-socket fallback is used. This avoids adding a native build and its transitive installer dependencies to the Pod.

Software tests use fake transport/D-Bus replies and local SQLite. They do not prove physical operation. On a paired TriMix base, qualification should verify configuration discovery; both sides' reported angles; a small head and feet change; each preset; Stop during motion and between motor writes; disconnected/stale states; reconnect without replay; and one calendar-time schedule with away suppression. Confirm the upstream irregular degree/tick calibration against that hardware before relying on large-angle positions. If Bluetooth is disconnected, the UI cannot confirm or deliver a stop to the base.
