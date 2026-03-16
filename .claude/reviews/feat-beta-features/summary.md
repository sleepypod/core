# Code Review Summary — feat/beta-features (PR #193)
Date: 2026-03-15
Depth: standard (Sonnet-only Optimizer + Skeptic)
Branch: feat/beta-features → dev

## What changed
Ports 7 features from free-sleep beta: version endpoint, sleep record CRUD, alarm snooze with in-process timeout, prime completion notification, ambient light sensor endpoints, water level monitoring with trend analysis, and a new biometrics DB migration for 3 tables.

## Findings

### Fixed (7)
- `dacMonitor.instance.ts`: Cancel snooze timers + reset prime state in `shutdownDacMonitor` (ghost timer leak)
- `dacMonitor.instance.ts`: Wrap `trackPrimingState` in try/catch error boundary (uncaught exception crash risk)
- `biometrics.ts`: Wrap `updateSleepRecord` select+update in `biometricsDb.transaction()` (TOCTOU race)
- `waterLevel.ts`: Replace in-memory row scan in `getTrend` with SQL COUNT aggregation (10K row perf fix at 168h)
- `biometrics-schema.ts`: Change `waterLevelReadings` to `uniqueIndex` on timestamp (consistency with other tables)
- `biometrics-schema.ts`: Add index on `waterLevelAlerts.dismissedAt` for active-alert queries
- `waterLevel.ts`: Add try/catch to `dismissAlert` mutation (pattern consistency)

### Disputed (3)
- **F2: Synchronous `.run()` blocking** — Skeptic correctly argues single-row INSERT at 1/min under WAL is negligible. Not fixed.
- **F10: `.git-info` CWD path** — Skeptic verified systemd `WorkingDirectory` matches repo root in deployment. Not broken. Downgraded to nit.
- **F14: `JSON.parse(null).branch` TypeError** — Skeptic correctly notes the encompassing try/catch already handles this. No fix needed.

### Deferred (3)
- **F3: Leak detection job** — `waterLevelAlerts` table + dismiss endpoint are scaffolding; no write path creates alerts yet. Issue #181 scope, but leak detection logic is complex and out of scope for this PR.
- **F4/5/6: Endpoint path mismatches vs issue specs** — Paths differ from issue text (`/water-level/history` vs `/readings`, `/device/alarm/snooze` vs `/device/snooze`, `/device/prime/dismiss` vs `/device/dismiss-prime-notification`). Not changed — the chosen paths are better organized, and iOS hasn't been built against the issue specs yet.
- **F12: `getSnoozeStatus` not exposed** — Valid feature gap but not a bug. Follow-up to add to `getStatus` response.

### Pre-existing (2)
- `getLogs` `since` param: no format validation (no injection risk due to `execFileAsync`)
- `reportVitalsBatch`: returns `rows.length` not actual inserted count with `onConflictDoNothing`

## Mechanical checks
- TypeScript: pass
- Build: pass

## Verification
1 fix-verify iteration. All checks pass.
