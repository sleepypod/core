# Optimizer Findings (Sonnet) — feat/beta-features

## Summary

This branch ports six features from the free-sleep beta fork into sleepypod-core: water level history/trend/alert endpoints with a new DB router (`waterLevel`), alarm snooze with in-process timeout management, a prime-completion notification piggybacking on `getStatus`, sleep record edit/delete mutations, ambient light sensor endpoints, and a `/system/version` endpoint backed by a pre-build git-info script. The intent is to close the API gap needed by the iOS client's beta feature set.

---

## Findings

### Finding 1: Snooze re-trigger uses shared hardware client without null guard
- **File**: `src/hardware/snoozeManager.ts:29`
- **Severity**: 🔴 Critical
- **Category**: Correctness
- **Problem**: `getSharedHardwareClient()` is called inside the `setTimeout` callback, which fires seconds to minutes later. If the server restarts, the DAC monitor shuts down, or the hardware client is cleared from `globalThis` (e.g. via `shutdownDacMonitor`), `getSharedHardwareClient()` will return a new `DacHardwareClient` that has never connected — it will throw or silently fail. The timeout itself is not cancelled on server shutdown, creating a window where a ghost callback fires after teardown.
- **Suggested fix**: Capture the client reference eagerly before the timeout, or call `cancelSnooze` for all sides during `shutdownDacMonitor`. Add a connection guard: `if (!client.isConnected()) { console.warn('[Snooze] Hardware disconnected, skipping re-trigger'); return }`.
- **Rationale**: A user snoozing an alarm may simply wake up to silence if the in-process timer fires against a disconnected client. This is the core value-add of the snooze feature and failure is silent.

---

### Finding 2: `recordWaterLevel` updates `lastWaterLevelWrite` even on failure path — no, it doesn't; the timestamp update is NOT atomic with the insert
- **File**: `src/hardware/deviceStateSync.ts:96-100`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: `this.lastWaterLevelWrite = now` is set *inside* the `try` block but *after* the `.run()` call. If `.run()` throws, the catch block logs the error and `lastWaterLevelWrite` is NOT updated — which is actually the correct behaviour. However, the insert is synchronous (`.run()` is Drizzle's sync API) yet `recordWaterLevel` is called unconditionally before the async `Promise.all` in `sync()`. If the sync insert blocks longer than 60 s under lock contention, the rate-limit guard provides no protection because the timestamp is only updated on success. More importantly: `recordWaterLevel` is synchronous and blocking on the main event-loop thread — it uses the synchronous `.run()` Drizzle API on every status poll cycle. Under write pressure this can delay subsequent awaited async operations.
- **Suggested fix**: Make `recordWaterLevel` async and `await biometricsDb.insert(...).values(...).run()` if Drizzle's async API is available, or at minimum document the synchronous blocking intent. Also move `this.lastWaterLevelWrite = now` to *before* the insert (optimistic throttle) to ensure the 60-second window is always respected even if the write fails.
- **Rationale**: Under SQLite write contention (e.g. biometrics pipeline writing concurrently), synchronous DB calls on the event loop can starve I/O and produce cascading latency across all server requests.

---

### Finding 3: Water level alert schema has no writing path — alerts are never created
- **File**: `src/server/routers/waterLevel.ts` / `src/db/biometrics-schema.ts:88`
- **Severity**: 🟡 Major
- **Category**: Completeness
- **Problem**: The `waterLevelAlerts` table is defined and a `dismissAlert` mutation is exposed, but there is no code anywhere in this PR (or apparently in the existing codebase) that *creates* alerts. The `type` enum includes `'low_sustained'`, `'rapid_change'`, and `'leak_suspected'` — leak detection logic — but no detection job or trigger writes rows to this table. The iOS client will always receive an empty array from `getAlerts`.
- **Suggested fix**: Either implement the leak-detection job as required by issue #181 (configurable thresholds, priming cooldown), or clearly document that alert creation is deferred and close the partially-implemented endpoint's false promise. At minimum, the PR description should note that `getAlerts`/`dismissAlert` are scaffolding for a future detection job.
- **Rationale**: Issue #181 explicitly requires "Leak detection job with configurable thresholds" and "Priming cooldown period to avoid false alerts". The PR ships the read/dismiss side of alerts without the write side, leaving these endpoints non-functional in practice.

---

### Finding 4: Issue #181 — endpoint paths don't match the spec
- **File**: `src/server/routers/waterLevel.ts:14,50,76,132,156`
- **Severity**: 🟡 Major
- **Category**: Completeness
- **Problem**: Issue #181 specifies: `GET /water-level/readings`, `GET /water-level/status`, `GET /water-level/summary`. The PR delivers: `GET /water-level/history` (not `readings`), `GET /water-level/trend` (not `summary`/`status`), and no `/water-level/status` endpoint. Additionally, issue #181 requires `maxPoints` with downsampling on the readings endpoint and the alert dismiss endpoint uses `id` while the issue spec says dismiss by `timestamp`. These are API contract mismatches that will break iOS client integration if it was built against the issue spec.
- **Suggested fix**: Either update the issue spec to reflect the chosen names, or rename `history`→`readings`, `trend`→`summary`, and add a `status` endpoint. Confirm with the iOS client team which contract is canonical.
- **Rationale**: The iOS app likely has these paths hardcoded. A naming mismatch at integration time is a silent failure (404).

---

### Finding 5: Issue #183 — snooze endpoint path mismatch
- **File**: `src/server/routers/device.ts:353`
- **Severity**: 🟡 Major
- **Category**: Completeness
- **Problem**: Issue #183 specifies the endpoint as `POST /device/snooze`. The PR uses `POST /device/alarm/snooze`. Additionally, issue #183 says snooze duration should come from settings (`snoozeDuration`), but the PR hardcodes a default of 300 s with a client-supplied override. The issue also mentions `frankenMonitor.dismissNotification()` as the mechanism, which is not how this is implemented (in-process timeout instead).
- **Suggested fix**: Confirm with iOS team whether `/device/snooze` or `/device/alarm/snooze` is the expected path. The path-in-settings approach may be a lower-priority detail, but document the deviation.
- **Rationale**: Path mismatch will cause 404 in iOS client integration.

---

### Finding 6: Issue #188 — dismiss endpoint path mismatch
- **File**: `src/server/routers/device.ts:436`
- **Severity**: 🟡 Major
- **Category**: Completeness
- **Problem**: Issue #188 specifies `POST /device/dismiss-prime-notification`. The PR uses `POST /device/prime/dismiss`. These differ.
- **Suggested fix**: Align path with issue spec or update the issue.
- **Rationale**: Same path-mismatch concern as above for iOS client integration.

---

### Finding 7: `updateSleepRecord` has a TOCTOU race — double-query without a transaction
- **File**: `src/server/routers/biometrics.ts:554-582`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: The mutation first `SELECT`s the existing record to get current timestamps for recalculating `sleepDurationSeconds`, then separately `UPDATE`s it. Between the select and the update another concurrent mutation could modify the same record (unlikely in practice but the DB offers no protection here). More concretely: if `enteredBedAt` is supplied but `leftBedAt` is not, the code reads `existing.leftBedAt` — but the schema marks `leftBedAt` as `.notNull()`, so this is fine at the type level. However if the record was deleted between the SELECT and the UPDATE, the final `if (!updated)` guard will still fire a `NOT_FOUND`, but with a misleading error message ("not found") rather than a clear "concurrently deleted" message. The deeper issue is that the SELECT and UPDATE are two separate DB round-trips with no wrapping transaction.
- **Suggested fix**: Wrap the select+update in a `biometricsDb.transaction()` block, consistent with how `DeviceStateSync.upsertSide` handles its own read-modify-write.
- **Rationale**: SQLite's WAL mode allows concurrent readers, so this can produce stale reads in a multi-process environment (e.g. the sleep-detector daemon also writing `sleep_records`).

---

### Finding 8: `getTrend` fetches unlimited rows for up to 168 hours with no query limit
- **File**: `src/server/routers/waterLevel.ts:85-89`
- **Severity**: 🟡 Major
- **Category**: Performance
- **Problem**: The `getTrend` query fetches all rows since `now - hours * 60 * 60 * 1000` with no `.limit()`. Water level readings are recorded every 60 seconds (from `recordWaterLevel`). At `hours=168` (7 days) that is up to 10,080 rows loaded into memory purely to count `ok`/`low` values — when a SQL `COUNT`/`SUM` aggregate would do this in O(1) memory.
- **Suggested fix**: Replace the in-memory `filter` approach with a SQL aggregation query:
  ```sql
  SELECT level, COUNT(*) as cnt FROM water_level_readings WHERE timestamp >= ? GROUP BY level
  ```
  Then compute percentages from the aggregated counts. For the trend half/half comparison, two windowed counts can be done with a single SQL expression.
- **Rationale**: 10,080 DB rows deserialized into JS objects for a simple percentage calculation is an unnecessary performance hazard at the 168-hour limit.

---

### Finding 9: `waterLevelReadings` index is non-unique — duplicate timestamps possible
- **File**: `src/db/biometrics-schema.ts:84-86` / `src/db/biometrics-migrations/0004_peaceful_mordo.sql:21`
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: `waterLevelReadings` uses a plain (non-unique) index on `timestamp`, unlike `ambientLight`, `bedTemp`, and `freezerTemp` which all use `uniqueIndex` on their timestamps. Since `recordWaterLevel` is rate-limited to once per 60 s in-process, duplicates shouldn't occur under normal operation. However, if multiple processes (or test runs) write to the same DB, the lack of a unique constraint means silent duplicate rows will accumulate and skew `getTrend` counts.
- **Suggested fix**: Change to `uniqueIndex('idx_water_level_timestamp')` to match the pattern of the other time-series tables.
- **Rationale**: Consistency with the established schema pattern; prevents data integrity issues if the water-level recorder is ever invoked from multiple contexts.

---

### Finding 10: `generate-git-info.mjs` writes `.git-info` relative to CWD, but `getVersion` reads it relative to CWD too — both depend on CWD being repo root
- **File**: `scripts/generate-git-info.mjs:11` / `src/server/routers/system.ts:423`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: Both the write (`writeFileSync('.git-info', ...)`) and the read (`readFile('.git-info', 'utf-8')`) use a bare relative path. In development this works if `pnpm dev` is run from the repo root (which is the normal case). In production, if the systemd service sets `WorkingDirectory` to anything other than the repo root, the file will be written to one path at build time and read from a different path at runtime.
- **Suggested fix**: Use `new URL('../.git-info', import.meta.url)` in the script (for the write) and `path.join(process.cwd(), '.git-info')` or an env-var-configurable path in the router. Or use `__dirname`-equivalent resolution. The fallback to `'unknown'` makes this non-fatal, but the feature will be silently broken.
- **Rationale**: The systemd unit's `WorkingDirectory` is deployment-specific. Anchoring to `import.meta.url` / `__dirname` is more robust.

---

### Finding 11: `reportVitalsBatch` always returns `written: rows.length` even when `onConflictDoNothing` silently drops duplicates
- **File**: `src/server/routers/biometrics.ts:467`
- **Severity**: 🟢 Minor
- **Category**: Deception
- **Problem**: The comment says "Efficient bulk insert with ON CONFLICT to avoid duplicates" and returns `{ written: rows.length }`. If any rows are duplicates and skipped by `onConflictDoNothing`, the returned `written` count will be higher than the actual rows inserted. The iOS client may log misleading sync statistics.
- **Suggested fix**: Drizzle's `.returning()` on a bulk insert with `onConflictDoNothing` only returns the actually-inserted rows. Use `.values(rows).onConflictDoNothing().returning()` and return `result.length` for an accurate count.
- **Rationale**: The function name and return value claim to report how many vitals were written, but they over-report when duplicates exist.

---

### Finding 12: `snoozeAlarm` router does not expose `getSnoozeStatus` — no way to query active snooze
- **File**: `src/server/routers/device.ts` / `src/hardware/snoozeManager.ts:49`
- **Severity**: 🟢 Minor
- **Category**: Completeness
- **Problem**: `snoozeManager.ts` exports `getSnoozeStatus(side)` returning `{ active, snoozeUntil }`, but the device router never exposes this. The iOS client receives `snoozeUntil` as part of the snooze mutation response, but after a restart or page reload there is no way to recover whether a snooze is currently active or when it will expire (since state is in-memory only).
- **Suggested fix**: Either expose `getSnoozeStatus` as part of the `getStatus` response (alongside `primeCompletedNotification`) or add a dedicated `device.getSnoozeStatus` query. Document the in-memory-only caveat (snooze state is lost on restart).
- **Rationale**: The iOS client cannot reconstruct UI state (e.g. "snoozed until 7:15 AM") after a server restart.

---

### Finding 13: `waterLevel` router is mounted without `TRPCError` wrapping in `dismissAlert`
- **File**: `src/server/routers/waterLevel.ts:159-173`
- **Severity**: 🟢 Minor
- **Category**: Pattern
- **Problem**: All other mutations in this router and throughout the codebase wrap database operations in `try/catch` and rethrow as `TRPCError`. `dismissAlert` performs a `biometricsDb.update(...).returning()` call without any try/catch. An unexpected DB error (e.g. schema mismatch during migration rollout, SQLITE_BUSY) will propagate as an unhandled internal error rather than a structured `TRPCError`, producing a less informative error response.
- **Suggested fix**: Wrap in the same try/catch pattern used by all sibling procedures.
- **Rationale**: Inconsistent error handling; tRPC will still catch unhandled errors but the error message will be less actionable.

---

### Finding 14: `getVersion` reads `.git-info` with `JSON.parse` but doesn't validate it's an object before indexing properties
- **File**: `src/server/routers/system.ts:424-430`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: If `.git-info` contains valid JSON that is not an object (e.g. `null`, `"string"`, `42`), `parsed.branch` etc. will be `undefined` (not throw), and the `typeof parsed.branch === 'string'` checks will correctly fall back to `'unknown'`. This is actually handled, but only by accident — if `parsed` is `null`, accessing `parsed.branch` in JS is a TypeError. In practice `writeFileSync` always writes an object, but it's fragile.
- **Suggested fix**: Add `if (typeof parsed !== 'object' || parsed === null) return fallback` before the property checks.
- **Rationale**: Defensive programming for a file that can be manually edited or corrupted.

---

### Finding 15: `since` parameter in `getLogs` is passed to `journalctl --since` without sanitization (pre-existing)
- **File**: `src/server/routers/system.ts:319`
- **Severity**: 🟣 Pre-existing
- **Category**: Security
- **Problem**: The `since` field is `z.string().optional()` with no length limit or format validation, and is passed directly as `--since <value>` to `journalctl` via `execFileAsync`. `execFileAsync` does not spawn a shell, so shell injection is not possible. However, an attacker can supply arbitrary strings to `journalctl --since`, potentially causing unexpected journalctl behavior (e.g. dates far in the past causing massive output). The `maxBuffer: 5MB` limit mitigates the worst case, but the parameter should be validated.
- **Suggested fix**: Add a regex or allowlist for `since` values: `z.string().regex(/^[\d\s\-:a-z]+$/).max(32).optional()`.
- **Rationale**: Defense-in-depth; no immediate injection risk but unnecessary permissiveness.

---

### Finding 16: `waterLevelAlerts` missing index on `dismissedAt` for active-alert queries (pre-existing design gap)
- **File**: `src/db/biometrics-schema.ts:88-95`
- **Severity**: 🟣 Pre-existing
- **Category**: Performance
- **Problem**: `getAlerts` queries `WHERE dismissedAt IS NULL`, but there is no index on `dismissedAt`. For a table that could grow large over time (if alerts ever start being created), this will result in a full table scan. This is a design gap introduced in this PR's migration.
- **Suggested fix**: Add `index('idx_water_level_alerts_dismissed').on(t.dismissedAt)` or use a partial index idiom.
- **Rationale**: Low impact while the table is small, but worth addressing before the leak-detection job starts writing to it.

---

## Statistics
- Total findings: 16
- 🔴 Critical: 1
- 🟡 Major: 5
- 🟢 Minor: 5
- ⚪ Nit: 1
- 🟣 Pre-existing: 2

> Note: 2 additional Completeness findings (#4, #5, #6) are counted under 🟡 Major above.
