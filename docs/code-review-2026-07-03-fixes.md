# Code Review Fix Plan — 2026-07-03

Execution plan for the remaining findings from the 2026-07-03 adversarial Codex
review of `dev` against `origin/main`. The source reports live in `.reviews/dev/`
(gitignored, local-only, overwritten by the next review run), so every finding is
copied here in full — this document is self-contained.

Line references were re-verified against `dev` HEAD after commit `0c87deb`.

**Status of the review's consensus findings:**

Already fixed in `0c87deb` (`fix(automation): honor manual overrides and missing
setpoints`), with regression tests:

- Major: `setPower` with an explicit unresolved temperature expression fell
  through to the hardware 75°F fallback (`src/automation/engine.ts`).
- Major: `registerManualOverride()` was never called from production manual
  controls (device router, gestures, HomeKit).
- Major: edited rules reused stale trigger runtime after `reload()`.

Remaining: **1 Major + 4 Minor**, planned below. Previous repo-wide review
(2026-07-01, 44 findings) is fully remediated; its plan was retired from
`docs/` and remains in git history.

---

## Batch 1 — Major: shared side-lock invariant

- [x] **1.1 Route manual hardware writes through `withSideLock()`**

  The branch introduced `withSideLock()` (`src/hardware/sideLock.ts`) as the
  global per-side hardware mutex, and CLAUDE.md declares it an invariant:
  *per-side hardware writes MUST go through `withSideLock`*. Scheduler
  (`src/scheduler/jobManager.ts:324,361,396,425,1064,1104`) and Autopilot
  (`src/automation/instance.ts:119` → `engine.ts:410`) honor it — but the
  manual control surfaces do not:

  - Device router: `client.setTemperature()` at
    `src/server/routers/device.ts:374`, `client.setPower()` at `:445`
    (MQTT user commands also flow through this router).
  - HomeKit: `src/homekit/accessories/sideController.ts` still serializes
    through its own local `sideQueues` promise chain (`:34-45`, reset at
    `:205-206`) — a *separate* mutex that does not exclude scheduler/autopilot
    writes.
  - Gestures: `client.setTemperature()` at
    `src/hardware/gestureActionHandler.ts:107`, `client.setPower()` at `:171`.

  **Impact:** a manual/HomeKit command can interleave semantically with a
  scheduler/autopilot sequence on the same side. The DAC transport queue
  serializes bytes, not the higher-level invariant (e.g. "mark side off, then
  skip the now-stale temp/alarm writes").

  **Change:** wrap the hardware mutation (not surrounding UI/cache logic) in
  `withSideLock(side, ...)` at each entrypoint:
  - `device.ts`: wrap the final debounced write — the dial-drag collapse
    (`:50`) must stay *outside* the lock so rapid calls still coalesce. Mind
    the snooze-window comment at `:468` (lock hold time across
    connect/setPower).
  - `sideController.ts`: replace the local `sideQueues` chain with
    `withSideLock`, preserving the optimistic HomeKit intent/cache behavior.
  - `gestureActionHandler.ts`: wrap the two writes.

  **Tests:** per-entrypoint serialization test — start a slow scheduler-style
  `withSideLock` holder, issue the manual write, assert it does not reach the
  hardware client until the lock releases (and that opposite-side writes are
  not blocked). Suites: `src/server/routers/tests/device.test.ts`,
  `src/homekit/tests/sideController.test.ts`,
  `src/hardware/tests/gestureActionHandler.test.ts`.

  One commit: `fix(hardware): route manual writes through shared side lock`.

---

## Batch 2 — Minor: cap-frame data pipeline (`src/streaming/`)

These three touch the same new persistence path (`piezoStream` →
`capFramePersistence` → `cap_sense_frames`). One commit each, or a single
grouped `fix(streaming)` commit if the diffs stay small.

- [x] **2.1 Reject partial Pod 3 capSense payloads instead of zero-filling**

  `capSideChannels()` (`src/streaming/normalizeFrame.ts:147-149`) expands any
  object with *at least one* of `out`/`cen`/`in` to six channels, zero-filling
  the rest — `{ out: 12 }` becomes `[12, 12, 0, 0, 0, 0]`. Missing channels
  become real zero-pressure readings in persisted `cap_sense_frames` rows and
  any `cap.*` backtest derived from them.

  **Change:** return `null` (skip the frame) unless all three of
  `out`/`cen`/`in` are numeric. Safe to be strict: the only production caller
  is the persistence path (`src/streaming/piezoStream.ts:796-797`); the live
  WS stream does not use this helper.

- [x] **2.2 Sanity-guard firmware timestamps before cap-frame persistence**

  `piezoStream` passes raw `frame.ts` to `recordCapFrame()` whenever it is a
  number (`src/streaming/piezoStream.ts:806-807`), and `recordCapFrame()`
  trusts it (`src/streaming/capFramePersistence.ts:118`, `tsSeconds * 1000`).
  RAW frames can carry tiny relative timestamps or far-future values — the
  Python writers already guard for exactly this
  (`modules/environment-monitor/main.py:44-75`,
  `modules/sleep-detector/main.py:89-118`).

  **Impact:** a tiny timestamp persists 1970-era rows until prune; a far-future
  *first* frame wedges the side's window — later normal timestamps are all
  `< startTsMs`, so the window never rolls over and cap history stops flushing
  for that side.

  **Change:** apply the same wall-clock sanity window as the Python modules
  before accepting a timestamp; skip invalid/future frames (or fall back to
  `Date.now() / 1000`).

- [x] **2.3 Flush in-flight cap windows on RAW file switch and shutdown**

  `recordCapFrame()` flushes a window only on a ≥5s rollover
  (`src/streaming/capFramePersistence.ts:118-134`); `resetCapFrameWindows()`
  just nulls both accumulators (`:152`). `piezoStream` calls the reset
  immediately on RAW file switch (`src/streaming/piezoStream.ts:711`) and
  shutdown never flushes — so the tail window of every RAW file is dropped,
  leaving a deterministic blind spot at each file boundary.

  **Change:** add `flushCapFrameWindows()` that persists non-empty in-flight
  windows, and call it before the reset on file switch and during shutdown.
  Do not persist empty windows.

---

## Batch 3 — Minor: DB retention index

- [x] **3.1 Timestamp-leading index for `cap_sense_frames` pruning**

  The only index on `cap_sense_frames` is the unique `(side, timestamp)` pair
  (`src/db/biometrics-schema.ts:134`), but retention deletes filter on
  `timestamp` alone (`src/streaming/capFramePersistence.ts:103`) — SQLite
  cannot seek the second column, so each prune scans the bulkiest time-series
  table. The branch already added timestamp-leading retention indexes to the
  other time-series tables for the same reason.

  **Change:** add `index('idx_cap_sense_frames_timestamp').on(t.timestamp)` to
  the schema, then `pnpm db:biometrics:generate`. Never hand-edit the
  migration journal (entry `when` values must stay strictly increasing).

---

## Definition of done

- Every behavioral fix lands with a pinning test (Stryker mutation testing is
  active — untested fixes surface as surviving mutants).
- Quality gates green: `pnpm tsc && pnpm lint && pnpm test`.
- One conventional commit per fix (or the noted Batch 2 grouping), checkboxes
  above ticked in the same commit as the fix.
- Pushed: `git status` clean vs `origin/dev`.
