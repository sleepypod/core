# Adjustable-base implementation verification

Verified locally on 2026-10-04 in `.codex/worktrees/adjustable-base`, branch `feat/adjustable-base`, starting from `0348650a7af63f66ffec2a7f3bf4160702efd65d` (origin/dev). Work is local; no deploy, push or physical base movement was performed.

## Requirements and evidence

| Requirement | Evidence |
| --- | --- |
| Identify beta's new base support against main/history | [Pinned investigation](free-sleep-adjustable-base.md), full upstream clone including main/beta ancestry and original/replayed dates |
| Local findings and sleepypod ADR | Investigation plus [ADR 0024](../adr/0024-adjustable-base-control.md) |
| Protocol and hardware implementation | `src/hardware/base/`: exact calibrated maps, known packet bytes, checksummed decoder, BlueZ D-Bus adapter, singleton controller |
| Correct hardware isolation | No DAC command changes; shared side locks acquired left then right for whole-bed moves; Stop invalidates pending generation and bypasses side locks |
| Lifecycle and failure handling | Tests cover disconnected/unconfigured/stale state, missing BlueZ device, acknowledgement failure, timeout, late replies, bus loss, stop races, guarded moves and shutdown |
| Local API | `base` tRPC router and eight REST operations; actual OpenAPI JSON contained all `/base/*` paths; GET status returned unconfigured/null positions locally; POST head=61 returned HTTP 400 |
| Persistent elevation scheduling | Generated config migration `0017_warm_synch`; fresh in-memory SQLite migrations and CRUD tests; unique day/time; timezone registration, away suppression, current-row guards, no replay/retry |
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

The one full-suite failure is `src/demo/tests/coverage.test.ts`, reporting missing `system.getSensorSource`. This is pre-existing at starting commit `0348650a`: `git show HEAD:src/components/Settings/SensorSourceCard.tsx` already calls that procedure, while `git show HEAD:src/demo/handlers/system.ts` has no corresponding handler. Those production files were not changed. All newly added base demo handlers have real-router contract coverage. The new schema/router expectations were updated and their tests pass.

## Practical limit

The real local API correctly reports no configured base. Mocked transport tests and browser demo behavior establish software behavior, not physical calibration, motion or stop latency. Qualification on a paired TriMix base remains necessary before claiming verified physical operation. The [setup guide](../hardware/ADJUSTABLE-BASE.md) lists prerequisites and the hardware qualification sequence. Independent split-side positioning is not implemented because beta's evidenced commands synchronize both sides.
