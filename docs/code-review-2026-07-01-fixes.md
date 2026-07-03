# Code Review Fix Plan — 2026-07-01

Actionable work plan derived from `docs/code-review-2026-07-01.md` (repo-wide review,
44 findings). This file is self-contained: each item has the location, the defect, and
the concrete change to make. Execute in batch order; commit per batch.

**Process notes for the implementing session:**
- Quality gates after each batch: `pnpm tsc && pnpm lint && pnpm test` (pre-push hook
  also runs these). Python modules: CI runs `.github/workflows/python-modules.yml`;
  run the module tests locally if a runner exists (check `modules/*/test*`).
- Add/adjust a test with each behavioral fix where practical — Stryker mutation
  testing is active, so untested fixes will surface as surviving mutants.
- Working tree already has an unrelated, verified-correct modification to
  `modules/common/calibration.py` (6-value capSense2 frames) and `.serena/project.yml`.
  Don't revert them; fold the calibration.py items below into that file carefully.
- Mark each item's checkbox when done. If a fix is intentionally skipped, note why inline.

---

## Batch 1 — Critical + High (do first, one commit each)

- [x] **1.1 [critical] Fix biometrics migration journal ordering**
  `src/db/biometrics-migrations/meta/_journal.json` — the idx-3 entry
  (`0003_sensor_calibration`) has hand-edited `when: 1773714000000`, which is greater
  than idx 4 (`1773621733014`) and idx 5 (`1773626902925`). Drizzle's migrator skips
  entries whose `when` ≤ max recorded `created_at`, so incremental upgrades past 0003
  skip 0004/0005 → missing tables → migration 0009 fails → pod cannot boot.
  **Change:** set idx 3's `when` to a value strictly between idx 2's and idx 4's
  (e.g. `1773621733013` or idx2+1). Do NOT reorder entries or touch SQL bodies.
  **Also:** add an incremental-upgrade migration test: apply migrations 0000–0003 to a
  fresh SQLite db, then run the full migrator again and assert 0004+ apply and
  `water_level_readings`/`ambient_light`/`water_level_alerts` exist.

- [x] **1.2 [high] Fix scheduler-drift miscount in health check**
  `src/server/routers/health.ts:223,238` — `expectedJobCount` counts only
  temperature/power/alarm schedule jobs, while `actualUserJobs = schedulerJobCount -
  systemJobCount` subtracts only `PRIME`+`REBOOT`. `LED_BRIGHTNESS` (2 jobs when night
  mode on), `AWAY_MODE`, `RUN_ONCE`, `CALIBRATION` jobs are in neither total, so any
  of them makes `drifted=true` and every health poll calls `reloadSchedules()` (full
  cron rebuild, ~7s).
  **Change:** compute both sides the same way — either subtract ALL non-user job types
  from `schedulerJobCount`, or count expected jobs per type including LED/away/
  run-once/calibration. Add a regression test: enable LED night mode, call the health
  check, assert `drifted === false` and `reloadSchedules` not called.

- [x] **1.3 [high] Make DAC transport reads cancelable / correlated**
  `src/hardware/dacTransport.ts:244` — `sendMessage` races
  `messageStream.readMessage()` vs a 30s timeout but never cancels the losing read.
  The orphaned read later consumes the NEXT command's response, permanently shifting
  all command/response pairing; `connectDac`'s `if (transport) return` blocks recovery.
  **Change:** make `readMessage` accept an abort/cancel signal and settle it when the
  timeout wins (so it stops listening and does not consume from the shared queue), OR
  tag requests and discard stale buffered responses. Apply the same fix to the
  dev/test path in `src/hardware/messageStream.ts:35` (single `pendingRead` slot has
  the identical flaw — item 3.5). Test: simulate a dropped response then a second
  command; assert the second command receives its own response.

- [x] **1.4 [high] Add timestamp sanity gate to environment-monitor**
  `modules/environment-monitor/main.py:240` — `ts = float(record.get("ts",
  time.time()))` has no upper/lower bound; downsample cursors seed from
  `MAX(timestamp)` (lines ~223–228), so one far-future timestamp permanently blocks
  all subsequent writes, surviving restarts.
  **Change:** mirror `sleep-detector`'s `sanitize_ts` — reject/clamp timestamps
  outside a sane window (e.g. > now + 60s or < some epoch floor) before the
  `ts - last_*_write` comparison and before insertion. Consider also clamping the
  DB-seeded cursor to `now` at startup so an already-poisoned DB self-heals.

---

## Batch 2 — Medium: device-control correctness

- [x] **2.1 HomeKit stale `intendedPower` latch**
  `src/homekit/accessories/sideController.ts:31,74-78,114-117` — `intendedPower` is
  set on every HomeKit toggle and never reconciled with firmware, so external power
  changes (scheduler off, auto-off) are shadowed; `setTargetTemperature` can re-heat a
  bed the scheduler turned off, and `isEffectivelyPowered` reports stale ON.
  **Change:** in the `status:updated` handler, once firmware state is observed, clear
  `intendedPower[side]` to `null` (or set it to the observed value).

- [x] **2.2 Timezone change never reaches AutomationEngine**
  `src/automation/instance.ts:33,113` + `src/server/routers/settings.ts:117-120` —
  settings handler calls `jobManager.updateTimezone` but the engine's `clock` closure
  captured the old timezone and `cachedTimezone` is never invalidated.
  **Change:** add an `updateTimezone(tz)` (or reinit) method on the engine that
  resets the clock closure and `cachedTimezone`; call it from the settings timezone
  handler alongside the scheduler update.

- [x] **2.3 Partial scheduler init leaks live jobs**
  `src/scheduler/instance.ts:59-77` — if `loadSchedules()` throws after registering
  some jobs, the partially-built `JobManager` is discarded but node-schedule keeps its
  timers; a retry registers duplicates → double hardware commands.
  **Change:** wrap the init body in try/catch; on failure call
  `manager.shutdown()`/`cancelAllJobs()` before rejecting.

- [x] **2.4 Gesture replay after dacMonitor recovery**
  `src/hardware/dacMonitor.ts:186` — after `degraded → running`, `lastGestures` still
  holds pre-outage counters, so the first good poll emits every gesture performed
  during the outage as fresh events.
  **Change:** on the degraded→running transition, re-baseline gesture counters
  without emitting (same as the `isFirstPoll` path).

- [x] **2.5 `sideLock` not `globalThis`-backed**
  `src/hardware/sideLock.ts:18` — module-level `Record` mutex; sibling singletons
  (`snoozeManager`, `pumpStallGuard`, `primeNotification`, `dacMonitor.instance`) all
  use `globalThis` because Turbopack can duplicate modules across chunks, which would
  silently break cross-component write serialization.
  **Change:** store `sideLocks` on `globalThis` under a keyed symbol, matching the
  sibling pattern. (Optional follow-up: route device tRPC router hardware writes
  through `withSideLock` — currently unlocked; verify before changing behavior.)

- [x] **2.6 Export archive endpoint can wedge permanently**
  `app/api/export/archive/route.ts:25,145` — module-level `inflight` flag is cleared
  only by tar `close`/`error`; a stuck tar or client disconnect leaves it `true`
  forever (429s until restart) and leaks the staging dir.
  **Change:** listen on `request.signal` abort + add a watchdog timeout; both paths
  `tarChild.kill()`, run `cleanup()`, and clear `inflight`.

- [x] **2.7 `protect: true` on `raw.deleteFile` is unenforced**
  `src/server/routers/raw.ts:63`; `createContext` returns `{}` in
  `app/api/[...rest]/route.ts:9` and `app/api/trpc/[trpc]/route.ts:10`;
  `securitySchemes: {}` in `src/server/openapi.ts:22`.
  **Decision needed:** either implement an auth middleware that honors `protect`, or
  remove the flag and document the LAN-only trust model uniformly. Pick one; don't
  leave the misleading flag. (Pairs with 2.8.)

- [x] **2.8 tRPC panel is an unauthenticated device-control surface**
  `proxy.ts:44` whitelists `/panel`; `app/panel/route.ts` exposes every procedure
  (`device.execute`, `system.setInternetAccess`, `system.triggerUpdate`,
  `raw.deleteFile`) with no gate.
  **Change:** gate the panel route behind `NODE_ENV !== 'production'` (or auth).

---

## Batch 3 — Medium: data pipeline (Python) + frontend seams

- [x] **3.1 piezo-processor orphaned DB handle on reconnect**
  `modules/piezo-processor/main.py:184` — `_replace_db_connection` swaps only the
  calling `SideProcessor`'s handle; the sibling keeps the closed connection and the
  shared `_db_write_failures` counter can discard a healthy connection.
  **Change:** adopt the shared-mutable-holder pattern from `sleep-detector`'s
  `DBHolder` (its docstring documents this exact bug); make the failure counter
  per-connection.

- [x] **3.2 Calibrator runs full recalibration on every process start**
  `modules/calibrator/main.py:200` — `should_run_daily` uses in-memory
  `daily_last_run` (starts 0) and ignores `DAILY_HOUR` (read at line ~45).
  **Change:** gate on persisted profile age via `store.get_profile_age_hours` and
  only run within the `DAILY_HOUR` window.

- [x] **3.3 raw_follower rotation race kills modules**
  `modules/common/raw_follower.py:94` — `open(latest, "rb")` outside the `try`; if
  the RAW file rotates between `_find_latest()` and `open()`, `FileNotFoundError`
  propagates → module `sys.exit(1)`.
  **Change:** wrap the file-switch/open in `try/except OSError` and `continue`.

- [x] **3.4 Pump gate discards real movement on both sides**
  `modules/sleep-detector/main.py:562` — `PumpGateCapSense.is_gated` zeroes movement
  for BOTH sides whenever EITHER pump has RPM>0 (Signal 1 is side-independent),
  under-counting the `movement` table during long pump runtimes.
  **Change:** gate per-side, or restrict full gating to the correlated ref-anomaly
  path (Signal 2). Validate against recorded data if available before/after.

- [x] **3.5 Dev/test SocketClient response misalignment** (fixed with 1.3)
  `src/hardware/messageStream.ts:35` — single `pendingRead` slot resolves a late/lost
  response into the NEXT command's read. Fix together with 1.3 (same correlation
  mechanism).

- [x] **3.6 WS fallback latch freezes device status UI**
  `src/hooks/useDeviceStatus.ts:28-38` — after the first WS frame,
  `hasReceivedWs.current` permanently sets `refetchInterval: false`; if the WS server
  dies, status (temps, pump-stall, alarm, water level) freezes with no HTTP fallback.
  **Change:** re-enable HTTP polling when stream status ≠ `connected` or no frame has
  arrived within N seconds; consider clearing `latestFrames` on reconnect.

- [x] **3.7 Snoozed alarm "Cancel" button is dead**
  `src/components/TempScreen/AlarmBanner.tsx:52-67,150` — during snooze,
  `handleStop` builds targets from `leftAlarmActive`/`rightAlarmActive` (both false),
  so no `clearAlarm` fires and the alarm resumes.
  **Change:** when nothing is actively vibrating, compute targets from
  `leftSnoozed`/`rightSnoozed`.

- [x] **3.8 Temp dial snaps back after commit**
  `src/components/TempScreen/TempScreen.tsx:88-100` — `onSettled` clears
  `localTarget` before the WS frame reflects the change (~2s), so the dial jumps
  back then forward.
  **Change:** keep `localTarget` until an incoming frame's `targetTemperature`
  matches the committed value (with a timeout fallback).

- [x] **3.9 Mutations refetch HTTP while UI reads WS**
  `src/components/TempScreen/TempScreen.tsx:93-119`,
  `src/components/PowerButton/PowerButton.tsx:26-61` — `refetch()`/`invalidate()`
  after `setTemperature`/`setPower` never updates the visible (WS-preferred) status;
  no optimistic state → no UI feedback for ~2s.
  **Change:** drive immediate feedback from optimistic local state (pattern from 3.8);
  fix the PowerButton doc comment or implement the optimistic toggle it describes
  (also covers low item 4.15).

---

## Batch 4 — Lows (batch into a few commits by area)

**Server/API**
- [x] 4.1 (done with 2.6) `app/api/export/archive/route.ts:102` — 400 on `Number.isNaN(startTs) || Number.isNaN(endTs)` instead of silently exporting everything.
- [x] 4.2 `src/server/routers/system.ts:272` — tighten branch regex to reject `..`, leading/trailing `/`, `//` (git-ref-safe).

**Hardware/streaming**
- [x] 4.3 `src/streaming/normalizeFrame.ts:230` — optional-chain `wire.left.pump.rpm` / `wire.fan.top.rpm` / `wire.*.power` with `?? null`/`?? 0` in `frzHealth`/`frzTherm` cases.
- [x] 4.4 `src/hardware/gestureActionHandler.ts:133` + `src/hardware/snoozeManager.ts:41,52` — clamp `setTimeout` delays to `2**31 - 1` ms or reject out-of-range snooze durations at config time.
- [x] 4.5 `src/streaming/mqttBridge.ts:660` — `testConnection` should resolve `tlsInsecure` via the same DB-then-env precedence as `resolveConfig`.
- [x] 4.6 `src/streaming/piezoStream.ts:540` — replace sync `Buffer.alloc`+`fs.readSync` seek with async/chunked reads so the event loop yields.

**Python modules**
- [x] 4.7 `modules/piezo-processor/main.py:935` — guard `np.frombuffer` against non-multiple-of-4 buffers (truncate `len//4*4` or per-record try/except).
- [x] 4.8 `modules/calibrator/main.py:234` — validate trigger JSON `isinstance(dict)`; clear the trigger file on invalid content to break the crash loop.
- [x] 4.9 `modules/piezo-processor/main.py:558` — `HRTracker` fallback path should append to `history` (or decay/reset) so the median tracker can't freeze.
- [x] 4.10 `modules/common/calibration.py:238` — `range(len(timestamps) - window_samples + 1)` (match CapSense2Calibrator line ~337).
- [x] 4.11 `modules/common/calibration.py:824` — `write_trigger_atomic`: add pid/counter uniquifier to filename; fsync file + parent dir around rename.

**Scheduler/automation**
- [x] 4.12 `src/automation/engine.ts:240-249,168-171` — fire `timeOfDay` when `nowMinutes >= atMin` and not already fired for the day-key (instead of exact-minute equality that a >60s tick can skip).
- [x] 4.13 `src/scheduler/jobManager.ts:1042-1067,1178-1189` — index run-once jobs by original setpoint index, or cancel all `runonce-${sessionId}-*` before rescheduling, to prevent duplicate setpoint fires after in-process reload.

**DB/migrations/scripts**
- [x] 4.14 `src/db/migrations/0002_nappy_warpath.sql` — delete (orphaned byte-identical duplicate of `0003_previous_phil_sheldon.sql`, not in journal).
- [x] 4.15 `src/db/migrations/meta/` — regenerate/restore missing `0007_snapshot.json`.
- [x] 4.16 `src/db/retention.ts:67` — add plain `timestamp` index on `vitals` and `movement` (new migration) so retention pruning can seek.
- [x] 4.17 (chose retention-pruning over FK — SQLite FKs unenforced without PRAGMA in every writer) `src/db/biometrics-schema.ts:215` — `vitals_quality.vitalsId`: add real FK with `onDelete: 'cascade'` or document the owning module's pruning; today rows orphan forever.
- [x] 4.18 `scripts/install:158` — `--restore`: remove/restore matching `-wal`/`-shm` sidecars before copying the `.db` (mirror `scripts/bin/sp-update:106-117`).
- [x] 4.19 `src/db/migrations/0012_backfill_pump_stall_optin.sql` — DECIDED: keep the safety reset as-is, no marker column. Pump-stall protection cuts power, so defaulting everyone back to opt-in after the backfill is the safer failure mode; the handful of early opt-ins re-enable in one toggle.

**Frontend**
- [x] 4.20 (done with 3.9) `src/components/PowerButton/PowerButton.tsx:16-38` — covered by 3.9 (optimistic toggle or fix comment).
- [x] 4.21 `src/components/Settings/DeviceSettingsForm.tsx:82-104` — don't overwrite dirty/focused fields when `[device]` identity changes on refetch; reset only on actual data change.
- [x] 4.22 `src/components/diagnostics/DiagnosticsConsole.tsx:154` — invert: `good={t?.pumpStallProtectionEnabled}` (armed = green).
- [x] 4.23 `src/components/Autopilot/CapZoneViz.tsx:142` — replace `Math.max(0.01, ...bigArray)` spread with a reduce/loop (RangeError on long replays).

**Repo hygiene**
- [x] 4.24 gitignore + `git rm --cached` the SQLite sidecars `biometrics.dev.db-shm` / `biometrics.dev.db-wal` (keep the `.db` if it's an intentional fixture).
- [x] 4.25 Fill in `CLAUDE.md` placeholder sections (Build & Test: `pnpm test`, `pnpm tsc`, `pnpm lint`, `pnpm test:mutation`; brief architecture overview).
- [x] 4.26 Dependency audit — tracked separately as ygg task core-3 (triage the 24 Dependabot findings; 1 critical, 12 high).

---

## Definition of done
- All batches checked off (or explicitly skipped with a reason noted inline).
- `pnpm tsc && pnpm lint && pnpm test` green; Python module tests/CI green.
- New regression tests for 1.1, 1.2, 1.3 at minimum.
- Committed in reviewable batches and pushed (`git status` clean vs origin, aside from
  the pre-existing `calibration.py` / `.serena/project.yml` working-tree changes if
  still intentionally uncommitted).
