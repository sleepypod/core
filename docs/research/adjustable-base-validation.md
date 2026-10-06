# Adjustable-base implementation verification

Verified locally on 2026-10-04 in `.codex/worktrees/adjustable-base`, branch `feat/adjustable-base`, starting from `0348650a7af63f66ffec2a7f3bf4160702efd65d` (origin/dev). No deploy or physical base movement was performed.

## Requirements and evidence

| Requirement | Evidence |
| --- | --- |
| Identify beta's new base support against main/history | [Pinned investigation](free-sleep-adjustable-base.md), full upstream clone including main/beta ancestry and original/replayed dates |
| Local findings and sleepypod ADR | Investigation plus [ADR 0024](../adr/0024-adjustable-base-control.md) |
| Protocol and hardware implementation | `src/hardware/base/`: exact calibrated maps, known packet bytes, checksummed decoder, BlueZ D-Bus adapter, singleton controller |
| Correct hardware isolation | No DAC command changes; shared side locks acquired left then right for whole-bed moves; Stop invalidates pending generation and bypasses side locks |
| Lifecycle and failure handling | Tests cover disconnected/unconfigured/stale state, missing BlueZ device, acknowledgement failure, timeout, late replies, bus loss, stop races, guarded moves and shutdown |
| Local API | `base` tRPC router and eight REST operations; actual OpenAPI JSON contained all `/base/*` paths; GET status returned unconfigured/null positions locally; POST head=61 returned HTTP 400 |
| Persistent elevation scheduling | Generated config migration `0018_amazing_captain_marvel`; fresh in-memory SQLite migrations and CRUD tests; unique day/time; timezone registration, away suppression, current-row guards, no replay/retry |
| UI | `/[lang]/base`, Temperature → Base link; separate measured/target position, preview, sliders, presets, Stop, reconnect, schedule creation/edit/pause/delete |
| Responsive behavior | Chrome default desktop and 390×844 phone viewport inspected; Stop remained visible above bottom navigation; viewport restored afterward |
| UI interaction | Demo Relax changed measured positions to 30°/15°; created Monday 22:00 schedule, edited it to Tuesday 23:00 through native time input, confirmed stored row; Stop acknowledged; home/Base navigation verified |
| Attribution | MIT notice preserved next to upstream-derived angle tables |
| Packaging | Pinned dbus-next optional-X11 patch and package-scoped exclusion of native usocket; standalone production build passed |

## Automated checks

- `pnpm exec tsc --noEmit`: passed.
- `pnpm lint`: passed (zero errors; existing anonymous-default-export warning in `stryker.config.mjs`).
- `CI=1 NEXT_TELEMETRY_DISABLED=1 pnpm build`: passed, including TypeScript, route generation and standalone postprocessing.
- Focused regression run: **20 files, 439 tests passed**. Covers base codec/transport/controller, API, UI, all scheduler tests, TempScreen, demo output contracts, DB contracts and root router surface.
- Full `pnpm exec vitest run --reporter=dot`: **274 files passed; 4,922 tests passed, 1 skipped, 1 failed** (275 files total).
- Additional demo-mutation contract test: reconnect, custom position, preset, stop and schedule create/update/delete passed against the real router schemas.
- `pnpm install --frozen-lockfile --ignore-scripts`: passed after excluding the optional native dependency.
- `git diff --check`: passed.
- Migration journal timestamps verified strictly increasing; schema snapshot reviewed for only the added base table.

The initial full-suite failure was `src/demo/tests/coverage.test.ts`, reporting missing `system.getSensorSource`. This was pre-existing at starting commit `0348650a`: `SensorSourceCard.tsx` already called that procedure, while `src/demo/handlers/system.ts` had no corresponding handler. The pre-push gate reproduced it, so a separate fix adds the demo response. Demo coverage and real-router contract tests now pass: **2 files, 70 tests**. All newly added base demo handlers have real-router contract coverage. The new schema/router expectations were updated and their tests pass.

## Practical limit

The real local API correctly reports no configured base. Mocked transport tests and browser demo behavior establish software behavior, not physical calibration, motion or stop latency. Qualification on a paired TriMix base remains necessary before claiming verified physical operation. The [setup guide](../hardware/ADJUSTABLE-BASE.md) lists prerequisites and the hardware qualification sequence. Independent split-side positioning is not implemented because beta's evidenced commands synchronize both sides.

## Per-side layouts 2a/2b (2026-10-04 follow-up)

Implemented against `Sleepypod Base.dc.html` sections 2a/2b and the supplied implementation prompts. Both layouts are available through a persisted layout preference when the backend explicitly advertises independent control. The real synchronized TriMix controller falls back to the whole-bed layout; independent movement is exercised by the demo and regression fixtures, not inferred from `SplitBase`.

- UI tests cover independent targets, link-on copy, linked edits/moves, unlink preservation, persisted preferences, scoped and immediate presets, mixed targets, measured overlays/labels, bounds, unavailable state, always-enabled global Stop and hardware fallback.
- Controller/API tests cover independent motion estimates, rejection of unsupported one-sided BLE writes, scoped payload validation and recurring schedule overlap detection.
- Scheduler tests cover recurrence groups in the device timezone, own-side away checks, both-side checks, scope/target revalidation under lock, skipping late callbacks/lock waits and no physical retries.
- Focused run: **29 files, 530 tests passed**, including all base, scheduler, demo and DB tests. The DB contract snapshot was reviewed and updated only for the intended recurrence/side/preset fields and unique index.
- Full lint passed with the existing Stryker default-export warning. Both Drizzle schema checks passed. Generated migration 0018 has a strictly increasing journal timestamp and preserves existing rows with side `both` and preset name `Custom`.
- Browser verification: both desktop layouts, linked editing from the opposite card, scoped movement to measured arrival, global Stop, a Weekdays/Sam preset schedule, preset matching and mixed-target messaging. Both layouts were inspected at a 390×844 viewport; actual document client/scroll widths were both 384px, with stacked cards and no horizontal overflow. Temporary viewport override was reset.
- The calibrated 60°/45° angle limits and 30% minimum speed are preserved. The requested 25% segment is disabled. Physical motion/stop qualification remains outside what these software checks establish.
