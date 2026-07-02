# Repo-Wide Code Review — 2026-07-01

Full-repository review of `@sleepypod/core` (branch `dev`, HEAD `caf4283`), covering
~90k lines: the Next.js/TypeScript app (`src/`, `app/`), the Python device modules
(`modules/`), the DB layer and migrations (`src/db/`), and `scripts/`. Six parallel
review agents each audited one area for correctness bugs, races, resource leaks,
security issues, and data-integrity risks; every finding below was verified against
surrounding code before inclusion. Style/naming nitpicks were excluded.

**Totals: 44 findings — 1 critical, 3 high, 16 medium, 24 low.**

## Top priorities

1. **[critical] Biometrics migration journal is non-monotonic** — incremental OTA
   upgrades can silently skip table-creating migrations, then hard-fail pod boot
   (`src/db/biometrics-migrations/meta/_journal.json`). See DB §1.
2. **[high] Health check thrashes the scheduler** — with LED night mode on, every
   `/health/system` poll miscounts jobs, flags drift, and rebuilds every cron job
   (`src/server/routers/health.ts`). See Server §1.
3. **[high] DAC transport desyncs on a lost response** — a timed-out read is never
   cancelled, so every later command reads the previous command's response, with no
   self-heal (`src/hardware/dacTransport.ts`). See Hardware §1.
4. **[high] One bad timestamp permanently stalls temperature ingestion** —
   `environment-monitor` has no upper-bound timestamp gate and re-seeds its cursor
   from the poisoned `MAX(timestamp)` on every restart (`modules/environment-monitor/main.py`).
   See Python §1.

---

## Server & API (`src/server/`, `app/api/`, `proxy.ts`)

1. **[high]** `src/server/routers/health.ts:223,238` — The `system` health check's
   scheduler-drift detection miscounts jobs and triggers a full scheduler rebuild on
   every call. `expectedJobCount` is derived only from temperature/power/alarm
   schedules, and `actualUserJobs = schedulerJobCount - systemJobCount` subtracts only
   `PRIME`+`REBOOT`; but `scheduler.getJobs()` also holds `LED_BRIGHTNESS` (2 jobs when
   night mode is on), `AWAY_MODE`, `RUN_ONCE`, and `CALIBRATION` jobs.
   *Failure scenario:* user enables LED night mode → every `/health/system` poll sees a
   count mismatch → `drifted=true` → `reloadSchedules()` cancels and rebuilds every
   recurring cron job (~7s at the documented ~357-job count) on each poll.
   *Fix:* subtract all non-user job types from `schedulerJobCount`, or compute both
   totals the same way.

2. **[medium]** `app/api/export/archive/route.ts:25,145` — The module-level `inflight`
   single-flight guard is cleared only by tar's `close`/`error` events, with no timeout
   and no `tarChild.kill()`.
   *Failure scenario:* client disconnects mid-export (or tar blocks on an undrained
   pipe) → `inflight` stays `true`, the staging dir is never removed, and every
   subsequent export returns `429` until process restart.
   *Fix:* wire `request.signal`/abort handling plus a watchdog timeout that kills the
   child and runs `cleanup()`.

3. **[medium]** `src/server/routers/raw.ts:63` — `raw.deleteFile` is marked
   `protect: true`, but nothing enforces it: `createContext` returns `{}` in both API
   routes, there is no auth middleware, and `securitySchemes` is `{}` in
   `src/server/openapi.ts:22`.
   *Failure scenario:* any client that can reach the pod deletes RAW biometrics files
   with no authentication, despite the OpenAPI spec advertising the endpoint as protected.
   *Fix:* implement middleware that honors `protect`, or remove the flag and document
   the LAN-only trust model uniformly.

4. **[low]** `app/api/export/archive/route.ts:102` — Non-numeric `startTs`/`endTs`
   parse to `NaN`, and the `mtime < startTs || mtime > endTs` guard is always false for
   `NaN`, silently disabling the time filter.
   *Failure scenario:* `?startTs=abc&endTs=abc` exports the entire RAW dataset instead
   of a window or a 400.
   *Fix:* reject with 400 on `Number.isNaN`.

5. **[low]** `src/server/routers/system.ts:272` — The `triggerUpdate` branch validator
   `/^[a-zA-Z0-9._\-/]+$/` accepts `..` and leading/trailing `/`, which are not valid
   git refs; the value is passed as argv to `sudo -n /usr/local/bin/sp-update <branch>`.
   *Failure scenario:* a branch like `../something` passes validation and may resolve
   to an unintended ref/path inside sp-update.
   *Fix:* tighten to a git-ref-safe pattern rejecting `..`, leading/trailing `/`, and `//`.

6. **[low]** `proxy.ts:44` — The locale matcher whitelists `/panel`, keeping
   `app/panel/route.ts` reachable; it renders the full tRPC panel (including
   `device.execute`, `system.setInternetAccess`, `system.triggerUpdate`,
   `raw.deleteFile`) with no `NODE_ENV` gate or auth.
   *Failure scenario:* on any pod reachable beyond the trusted LAN, `/panel` is a
   complete unauthenticated device-control surface.
   *Fix:* gate the panel behind `NODE_ENV !== 'production'` or auth.

*Overall:* generally defensive — strict Zod validation, argv-array shell-outs (no
injection), solid symlink/realpath traversal guards, parameterized SQL. The health-check
drift miscount is the priority. The API is intentionally unauthenticated (LAN-only model,
WAN blocked via iptables); the `protect: true` flag and the always-on tRPC panel are the
seams where that assumption is easiest to violate.

---

## Hardware & Streaming (`src/hardware/`, `src/streaming/`)

1. **[high]** `src/hardware/dacTransport.ts:244` — `sendMessage` races
   `messageStream.readMessage()` against a timeout but never cancels the losing read,
   so a lost firmware response permanently desyncs command/response correlation.
   *Failure scenario:* firmware never answers command A → after the 30s timeout the
   orphaned `readMessage_A` stays alive; when B's response arrives, the orphan consumes
   it, so B (and every later command) reads the previous command's response. Since
   `transport` stays set, `connectDac`'s `if (transport) return` prevents recovery
   without a socket close.
   *Fix:* make the read cancelable on timeout, or add per-request correlation so stale
   buffers are discarded.

2. **[medium]** `src/hardware/dacMonitor.ts:186` — After a `degraded → running`
   recovery, `lastGestures` is never re-baselined, so `detectGestures` diffs
   post-outage counters against pre-outage counters.
   *Failure scenario:* connection blips for a minute, user double-taps 3× during the
   outage → first successful poll emits 3 stale `gesture:detected` events → 3
   temperature/power/alarm actions fire at once.
   *Fix:* re-baseline gesture counters without emitting on recovery, as on first poll.

3. **[medium]** `src/hardware/sideLock.ts:18` — The per-side mutex is a module-level
   `Record`, not `globalThis`-backed like its four sibling singletons, which all
   document that Turbopack duplicates modules across chunks.
   *Failure scenario:* scheduler and automation engine resolve to different bundle
   chunks → each gets its own `sideLocks` → the process-wide writer serialization
   silently breaks, allowing e.g. a temperature command to land after a power-off.
   (The device tRPC router also issues hardware writes without `withSideLock` at all.)
   *Fix:* store `sideLocks` on `globalThis` under a keyed symbol, matching siblings.

4. **[low]** `src/streaming/normalizeFrame.ts:230` — The `frzHealth`/`frzTherm` cases
   dereference `wire.left.pump.rpm` / `wire.fan.top.rpm` with no structural guard.
   *Failure scenario:* a partially-garbled frame missing `pump`/`fan` throws a
   `TypeError` that the caller swallows as "non-JSON", dropping the frame.
   *Fix:* use optional chaining with `?? null`/`?? 0` as the other cases do.

5. **[low]** `src/hardware/messageStream.ts:35` — The dev/test `SocketClient` has the
   same response-misalignment flaw via its single `pendingRead` slot: a late response
   resolves the *next* command's read.
   *Fix:* correlate responses to requests or drop late messages after timeout.

6. **[low]** `src/hardware/gestureActionHandler.ts:133` (and
   `src/hardware/snoozeManager.ts:41,52`) — Snooze restart uses
   `setTimeout(fn, snoozeDuration * 1000)`; values above ~2,147,483,647 ms (~24.8 days)
   overflow Node's 32-bit timer and fire almost immediately.
   *Fix:* clamp the delay or reject out-of-range durations at config time.

7. **[low]** `src/streaming/mqttBridge.ts:660` — `testConnection` derives `tlsInsecure`
   only from `process.env.MQTT_TLS_INSECURE`, ignoring the `device_settings.mqttTlsInsecure`
   DB value the running bridge honors.
   *Failure scenario:* DB has `mqtt_tls_insecure=true` (self-signed broker), env unset →
   the "Test" button fails while the actual bridge connects, misleading the operator.
   *Fix:* resolve through the same DB-then-env precedence as the live bridge.

8. **[low]** `src/streaming/piezoStream.ts:540` — `handleSeek` does a synchronous
   `Buffer.alloc` + `fs.readSync` (capped at 64 MB) on the main event loop.
   *Failure scenario:* a seek near the start of the retained window blocking-reads
   several MB, stalling all WebSocket clients and the 10 ms tail-follow loop.
   *Fix:* use async reads or chunk the replay so the loop yields.

*Overall:* well-engineered — idempotent lifecycles, explicit backpressure, bounded frame
indexes, CBOR resync. The residual risk concentrates in degraded/reconnect paths; the
transport correlation bug is the one genuinely serious, non-self-healing issue.

---

## Python Device Modules (`modules/`)

1. **[high]** `modules/environment-monitor/main.py:240` — Frame timestamps are used
   unvalidated (`ts = float(record.get("ts", time.time()))`) with no upper bound, and
   downsample cursors are seeded from `MAX(timestamp)` in the DB (lines 223–228).
   *Failure scenario:* one corrupt-but-decodable frame with a far-future `ts` (e.g.
   year 2040) is written; thereafter every real record fails the
   `ts - last_bed_write < 60` gate and is dropped — and on restart the cursor re-seeds
   from the poisoned `MAX(timestamp)`, so the stall survives forever.
   *Fix:* add a wall-clock sanity gate on `ts` (mirror `sleep-detector.sanitize_ts`).

2. **[medium]** `modules/piezo-processor/main.py:184` — DB reconnection updates only
   the calling `SideProcessor`'s handle; the sibling keeps the closed connection, and
   the reconnect-failure counter is shared across both sides.
   *Failure scenario:* after WAL/disk errors, `left.db` gets the new connection but
   `right.db` still holds the closed one → right side loses its next 5 writes; the
   shared counter can also trip a reconnect that discards a healthy connection.
   *Fix:* use the shared-mutable-holder pattern `sleep-detector`'s `DBHolder` already
   documents as fixing exactly this bug.

3. **[medium]** `modules/calibrator/main.py:200` — `should_run_daily` ignores the
   persisted profile age and `DAILY_HOUR`; it returns `True` once the *in-memory*
   `daily_last_run` (starts at 0) is ≥25h old.
   *Failure scenario:* every process start (crash-loop, redeploy) immediately runs a
   full recalibration of all 6 profiles; the intended 06:00 schedule is never honored.
   *Fix:* gate on `store.get_profile_age_hours` and honor `DAILY_HOUR`.

4. **[medium]** `modules/common/raw_follower.py:94` — `self._file = open(latest, "rb")`
   runs outside the `try` block, so a file-rotation race raises an uncaught exception.
   *Failure scenario:* the RAW file is rotated between `_find_latest()` and `open()` →
   `FileNotFoundError` propagates to each module's top-level handler → `sys.exit(1)`.
   *Fix:* wrap the file-switch/`open` in `try/except OSError` and continue.

5. **[medium]** `modules/sleep-detector/main.py:562` — `PumpGateCapSense.is_gated`
   zeroes movement for *both* sides whenever *either* pump reports RPM>0.
   *Failure scenario:* on pods with long pump runtimes, genuine body movement during
   pump operation is discarded, systematically under-counting the `movement` table
   that downstream sleep staging relies on.
   *Fix:* restrict full gating to the correlated ref-anomaly path, or gate per side.

6. **[low]** `modules/piezo-processor/main.py:935` — `np.frombuffer(..., dtype=np.int32)`
   raises `ValueError` on buffers whose length isn't a multiple of 4, guarded only by
   the fatal top-level handler; one corrupted frame crashes the whole processor.
   *Fix:* truncate to `len//4*4` (as `PiezoCalibrator` does) or skip per-record.

7. **[low]** `modules/calibrator/main.py:234` — A trigger file containing valid JSON
   that isn't a dict crashes `main` before `clear_trigger()` runs, producing a crash
   loop (the file is re-read and re-crashes on every restart).
   *Fix:* validate `isinstance(trigger, dict)` and clear the file on invalid content.

8. **[low]** `modules/piezo-processor/main.py:558` — `HRTracker` never appends to
   `history` on the "accept anyway" path; after a large sustained HR shift, the median
   tracker freezes and harmonic correction is disabled for the rest of the session.
   *Fix:* append the accepted value (or decay/reset history) on the fallback path.

9. **[low]** `modules/common/calibration.py:238` — `CapCalibrator.calibrate` iterates
   `range(len(timestamps) - window_samples)` (no `+1`), so the final full window is
   never evaluated; `CapSense2Calibrator` does this correctly (line 337).
   *Fix:* use `range(... - window_samples + 1)`.

10. **[low]** `modules/common/calibration.py:824` — `write_trigger_atomic` derives the
    filename from `int(time.time()*1000)` and does no fsync; two triggers in the same
    millisecond clobber each other, and a crash right after `rename` can lose the
    trigger without a directory fsync.
    *Fix:* add a pid/counter uniquifier and fsync file + parent dir.

*Overall:* clear evidence of field hardening (atomic renames, WAL/reconnect handling,
corruption-scan recovery, presence debouncing). The uncommitted working-tree change to
`modules/common/calibration.py` (accepting 6-value capSense2 frames with optional REF)
was verified **correct** and consistent with its consumers in `sleep-detector`. The
recurring theme is uneven propagation of hardened patterns between sibling modules
(`DBHolder`, `sanitize_ts`) — several defects would disappear by adopting the safer
sibling's approach.

---

## Scheduler, Automation, HomeKit (`src/scheduler/`, `src/automation/`, `src/homekit/`, `src/services/`)

1. **[medium]** `src/homekit/accessories/sideController.ts:31,74-78,114-117` — The
   `intendedPower` latch is set eagerly on every HomeKit power toggle but never
   reconciled back to firmware truth.
   *Failure scenario:* user powers a side ON via HomeKit; the scheduler's morning
   power-off turns the bed off in firmware; `intendedPower` stays `true` → a later
   `TargetTemperature.onSet` pushes `setTemperature` to a bed that is off, re-heating
   it against the explicit off; `isEffectivelyPowered` also reports stale ON.
   *Fix:* clear/reconcile `intendedPower[side]` in the `status:updated` handler once
   firmware state is observed.

2. **[medium]** `src/automation/instance.ts:33,113` +
   `src/server/routers/settings.ts:117-120` — A timezone change reaches the scheduler
   (`jobManager.updateTimezone`) but never the AutomationEngine, whose `clock` closure
   captured the old timezone and whose `cachedTimezone` is never invalidated.
   *Failure scenario:* timezone changed NY→LA; cron jobs rebind, but every `timeOfDay`
   trigger and `timeBetween` condition keeps evaluating on New York wall-clock (3h off)
   until process restart.
   *Fix:* add an engine `updateTimezone` path and call it from the settings handler.

3. **[medium]** `src/scheduler/instance.ts:59-77` — If `loadSchedules()` throws after
   registering some jobs, the partially-built `JobManager` is discarded without
   cancelling them; node-schedule keeps those timers alive in its global registry.
   *Failure scenario:* transient DB error mid-load → init rejects → the next
   `getJobManager()` registers a second copy → temperature/power jobs fire twice
   (duplicate hardware commands).
   *Fix:* on init failure, call `manager.shutdown()`/`cancelAllJobs()` before rejecting.

4. **[low]** `src/automation/engine.ts:240-249,168-171` — `timeOfDay` triggers fire
   only on exact minute equality sampled by a 60s interval, and the `if (this.ticking)
   return` guard drops overlapping ticks.
   *Failure scenario:* a hardware write under `withSideLock` hangs one tick past 60s →
   the next tick is dropped, the minute is skipped, and a 06:30 wake-up automation
   silently never fires that day.
   *Fix:* fire when `nowMinutes >= atMin` and not already fired for that day-key.

5. **[low]** `src/scheduler/jobManager.ts:1042-1067,1178-1189` — `loadRunOnceSessions`
   builds job IDs from *filtered-array position* (`runonce-${sessionId}-${i}`); on an
   in-process `reloadSchedules()` after ≥1 setpoint has fired, surviving one-time jobs
   are re-indexed and old ones never cancelled.
   *Failure scenario:* setpoints [0,1,2] with #0 fired; heartbeat reload creates new
   `-0`/`-1` jobs while old `-2` survives → the last setpoint fires twice.
   *Fix:* index run-once jobs by original setpoint index, or clear all
   `runonce-${sessionId}-*` before rescheduling.

*Overall:* unusually well-defended (DST handling, liveness heartbeat, layered automation
safety stack, paired timer/listener cleanup in HomeKit). Remaining defects concentrate in
cross-component state reconciliation: stale intent latches, config changes that don't
propagate, and cleanup gaps on partial init and in-process reloads.

---

## Database & Migrations (`src/db/`, `*.sql`, `scripts/`)

1. **[critical]** `src/db/biometrics-migrations/meta/_journal.json` — The journal's
   `when` timestamps are non-monotonic: idx 3 (`0003_sensor_calibration`,
   `when: 1773714000000` = 2026-03-17, a hand-edited round value) sorts *after* idx 4
   and idx 5 (both 2026-03-16). Drizzle's migrator applies only entries whose
   `folderMillis` exceeds the max `created_at` already recorded — ordering keys off
   `when`, not idx.
   *Failure scenario:* a pod whose last applied migration is 0003 records
   `created_at = 1773714000000`; a later OTA adds 0004/0005 but both are skipped
   (`folderMillis` < recorded max) → `ambient_light`, `water_level_alerts`,
   `water_level_readings` never created → `0009` runs
   `ALTER TABLE water_level_readings ADD raw` → "no such table" → migration transaction
   rolls back → **pod fails to boot on every restart**.
   *Fix:* rewrite the three `when` values to increase strictly with idx (content
   unchanged), and add an incremental-upgrade migration test.

2. **[medium]** `src/db/migrations/0002_nappy_warpath.sql:1` — Byte-identical to
   `0003_previous_phil_sheldon.sql` and absent from `meta/_journal.json` — an inert
   landmine from a botched `0002` merge collision.
   *Failure scenario:* anyone re-adding it to the journal (or directory-scanning
   tooling) re-runs `ALTER TABLE device_settings ADD led_*` → "duplicate column name"
   aborts migrations.
   *Fix:* delete the orphaned file.

3. **[low]** `src/db/migrations/meta/` — `0007_snapshot.json` is missing while journal
   idx 7 exists and all other indexes 0000–0014 have snapshots; history-walking
   drizzle-kit operations can error or misreport (runtime `migrate()` unaffected).
   *Fix:* regenerate/restore the snapshot.

4. **[low]** `src/db/retention.ts:67` — `pruneOldBiometrics` deletes on
   `timestamp < cutoff`, but `vitals` and `movement` (the highest-frequency tables)
   lack a timestamp-leading index — only `(side, timestamp)` composites survive.
   *Failure scenario:* daily retention degrades toward a full-table scan of the
   largest tables on constrained pod hardware.
   *Fix:* add a plain `timestamp` index on `vitals` and `movement`.

5. **[low]** `src/db/biometrics-schema.ts:215` — `vitals_quality.vitalsId` is
   documented as "FK to vitals.id" but declared without `.references()`, and the table
   is excluded from `RETENTION_TABLES`; rows referencing pruned vitals accumulate
   indefinitely unless the owning module prunes them.
   *Fix:* add a real FK with cascade, or document the owning module's pruning.

6. **[low]** `src/db/migrations/0012_backfill_pump_stall_optin.sql:11` — The backfill
   unconditionally sets `pump_stall_protection_enabled = false` for all rows,
   silently disabling protection for users who intentionally re-enabled it between
   releases. The migration comment marks this as an intentional safety reset — if
   preserving explicit opt-ins matters, gate the reset with a marker column.

7. **[low]** `scripts/install:158` — `--restore` copies `sleepypod.db` without
   clearing/restoring the live `-wal`/`-shm` sidecars, unlike the careful handling in
   `scripts/bin/sp-update:106-117`; a mismatched newer WAL risks replaying post-backup
   transactions (mostly latent thanks to SQLite's WAL salt check).
   *Fix:* remove or restore matching sidecars before copying, mirroring sp-update.

*Overall:* the schema is clean and well-indexed, migration bodies are individually
sensible, and the shell scripts are unusually defensive (annotated with the incidents
that motivated them). The serious risk is concentrated in migration *ordering metadata*
rather than migration content — none of it catchable by the existing empty-database
migration tests.

---

## Frontend (`src/components/`, `src/hooks/`, `src/lib/`, `app/`)

1. **[medium]** `src/hooks/useDeviceStatus.ts:28-38` — Once any WebSocket
   `deviceStatus` frame arrives, `hasReceivedWs.current` latches `true` forever and
   permanently disables the HTTP polling fallback.
   *Failure scenario:* the piezoStream WS server (port 3001) crashes while the app
   stays mounted → `latestFrames` is never cleared → temps, pump-stall notices, alarm,
   and water level freeze at the last frame with no HTTP refresh and no user-visible
   indication.
   *Fix:* re-enable the HTTP poll when the stream is not `connected` or no frame has
   arrived within N seconds.

2. **[medium]** `src/components/TempScreen/AlarmBanner.tsx:52-67,150` — The "Cancel"
   button on a snoozed (not actively vibrating) alarm fires zero mutations.
   *Failure scenario:* alarm snoozed → banner renders the snoozed branch → "Cancel"
   builds `targets` solely from `leftAlarmActive`/`rightAlarmActive` (both false during
   snooze) → no `clearAlarm` is sent and the alarm resumes after the snooze window.
   *Fix:* fall back to the snoozed sides when computing targets.

3. **[medium]** `src/components/TempScreen/TempScreen.tsx:88-100` — On dial release the
   target snaps back to the stale value for ~2s: `onSettled` clears `localTarget`
   before the WS-preferred status reflects the change.
   *Fix:* keep the local target until the incoming WS frame's `targetTemperature`
   matches the committed value.

4. **[medium]** `src/components/TempScreen/TempScreen.tsx:93-119` and
   `src/components/PowerButton/PowerButton.tsx:26-61` — Mutations refresh HTTP state
   (`refetch()`/`invalidate()`) while the UI reads WS state, so device-control feedback
   is effectively broken: power/temperature toggles show no UI change for up to ~2s.
   *Fix:* drive immediate feedback from optimistic local state instead of HTTP refetch.

5. **[low]** `src/components/PowerButton/PowerButton.tsx:16-38` — The doc comment
   claims optimistic UI ("toggles appearance immediately, reverts on error") but no
   optimistic state exists; implement it or correct the comment.

6. **[low]** `src/components/Settings/DeviceSettingsForm.tsx:82-104` — The
   `useEffect(..., [device])` re-syncs all local fields whenever the `device` object
   identity changes (any `settings.getAll` refetch).
   *Failure scenario:* user saves one field then starts editing another; the earlier
   save's refetch resolves and overwrites the in-progress edit with stale server state.
   *Fix:* guard the reset (skip while dirty/focused) or key it off actual data changes.

7. **[low]** `src/components/diagnostics/DiagnosticsConsole.tsx:154` — The Overview
   "Pump-stall" metric passes `good={!t?.pumpStallProtectionEnabled}` — protection
   ARMED renders amber and disabled renders green, inverted for a safety feature.
   *Fix:* use `good={t?.pumpStallProtectionEnabled}`.

8. **[low]** `src/components/Autopilot/CapZoneViz.tsx:142` —
   `Math.max(0.01, ...frames.flatMap(f => f.zones))` spreads a potentially huge array
   as call arguments; a long night's `capZoneReplay` can exceed the argument-count
   limit and throw `RangeError`, crashing the panel.
   *Fix:* compute the max with a reduce/loop.

*Overall:* healthy and deliberate — ref-counted WS singleton via `useSyncExternalStore`,
correct optimistic-update/rollback in `useSchedules`, consistent effect cleanup, no XSS
(the only `dangerouslySetInnerHTML` uses a static constant). The recurring weakness is
the seam between WS-sourced device status and the mutation→HTTP-refetch pattern, which
produces stale or laggy feedback for the physical controls and a permanent-freeze mode
if the WS server dies.

---

## Repo hygiene

- **Tracked SQLite runtime sidecars:** `biometrics.dev.db`, `biometrics.dev.db-shm`,
  and `biometrics.dev.db-wal` are committed to git. The `-shm`/`-wal` files are
  volatile WAL runtime state and should be gitignored (the `.db` itself is arguably a
  fixture, but sidecars will churn and can desync from the main file).
- **`CLAUDE.md` placeholders:** the Build & Test, Architecture Overview, and
  Conventions sections are still template stubs (`_Add your build and test commands
  here_`) despite a rich toolchain existing (`pnpm test`, `pnpm tsc`, `pnpm lint`,
  Stryker mutation testing, 11 CI workflows) — filling these in would help every agent
  and contributor.
- **`.env.dev`/`.env.prod` are tracked but contain no secrets** (local SQLite paths
  only) — fine as-is.
- The uncommitted working-tree diff (`modules/common/calibration.py` 6-value capSense2
  support, `.serena/project.yml` tooling update) was reviewed: both are correct/benign.

## Suggested fix order

1. Fix the biometrics `_journal.json` ordering + add an incremental-upgrade migration test (DB §1).
2. Fix the health-check job-count drift logic (Server §1).
3. Make `dacTransport` reads cancelable/correlated (Hardware §1).
4. Add timestamp sanity gating to `environment-monitor` (Python §1).
5. Batch the medium-severity reconciliation fixes: HomeKit `intendedPower`, automation
   timezone propagation, WS-fallback latch, snoozed-alarm Cancel, piezo-processor
   `DBHolder` adoption, calibrator daily-schedule gate.
