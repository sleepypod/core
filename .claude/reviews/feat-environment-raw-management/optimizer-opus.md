# Optimizer Findings (Opus) — feat/environment-raw-management

## Summary

This branch adds an end-to-end environment monitoring pipeline: a Python daemon (`environment-monitor`) reads CBOR-encoded bed and freezer temperature records from RAW sensor files, downsamples them to 60-second intervals, and writes to two new SQLite tables (`bed_temp`, `freezer_temp`) in `biometrics.db`. On the TypeScript side, it adds a new `environment` tRPC router for querying/summarizing this data with unit conversion, a `raw` tRPC router for listing/deleting/reporting disk usage of `.RAW` files, a Next.js streaming download endpoint for those files, and a `wifiStatus` procedure on the existing `system` router. Schema, migrations, install script, and systemd service are all included.

## Findings

### Finding 1: `deleteFile` uses `protect: true` but no auth middleware exists
- **File**: `src/server/routers/raw.ts`:59
- **Severity**: 🟡 Major
- **Category**: Security
- **Problem**: The `deleteFile` mutation sets `protect: true` in its OpenAPI meta, suggesting it should require authentication. However, the procedure is built on `publicProcedure` and no auth middleware is wired up anywhere in the codebase. The `protect` field is purely decorative metadata for the OpenAPI spec — it does not enforce any access control. Anyone on the LAN can delete RAW files.
- **Suggested fix**: Either (a) document explicitly that this is intentional given the LAN-only deployment model and add a code comment like the one on `systemRouter` in `app.ts`, or (b) implement a lightweight auth guard (e.g., a shared secret from `.env`) as a `protectedProcedure` base procedure and apply it here. At minimum, change `protect: true` to `protect: false` to avoid the false sense of security — or add the same comment as `systemRouter` noting LAN-only is acceptable.
- **Rationale**: The `protect: true` flag is the only endpoint in the entire codebase that claims protection, but it has none. This is misleading to future developers who may assume the endpoint is guarded.

### Finding 2: Duplicate migration file `0002_mushy_loki.sql` is dead/orphaned
- **File**: `src/db/biometrics-migrations/0002_mushy_loki.sql`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: Two migration files exist with identical content: `0002_fuzzy_strong_guy.sql` and `0002_mushy_loki.sql`. The migration journal (`meta/_journal.json`) only references `0002_fuzzy_strong_guy`. The orphaned `0002_mushy_loki.sql` is dead code that will confuse future developers and could cause issues if Drizzle tooling attempts to process it.
- **Suggested fix**: Delete `src/db/biometrics-migrations/0002_mushy_loki.sql`.
- **Rationale**: Orphaned migration files create confusion about which migration is canonical and risk accidental double-application if tooling changes.

### Finding 3: `systemRouter.setInternetAccess` is unprotected — allows toggling WAN from LAN
- **File**: `src/server/routers/system.ts`:127
- **Severity**: 🟣 Pre-existing
- **Category**: Security
- **Problem**: The `setInternetAccess` mutation uses `publicProcedure` with `protect: false`. Any device on the LAN can unblock WAN access (flush all iptables rules), which defeats the privacy-first design. This is pre-existing but worth noting alongside the new endpoints.
- **Suggested fix**: This is tracked by the existing comment in `app.ts` ("If internet access is ever opened, add auth middleware"). No action needed in this PR, but worth flagging that the new `deleteFile` endpoint has the same pattern.
- **Rationale**: Consistency check — the new endpoints follow the existing (known-risky) pattern.

### Finding 4: `triggerUpdate` mutation is unprotected — allows arbitrary branch deployment
- **File**: `src/server/routers/system.ts`:209
- **Severity**: 🟣 Pre-existing
- **Category**: Security
- **Problem**: Any LAN device can trigger `sp-update` with an arbitrary branch name. While the branch regex prevents injection, the endpoint still allows deploying any branch without authentication.
- **Suggested fix**: Same as Finding 3 — tracked by existing comment. No action needed in this PR.
- **Rationale**: Context for the overall security posture of the new endpoints.

### Finding 5: `environment.getSummary` returns `avg()` results as strings, not numbers
- **File**: `src/server/routers/environment.ts`:192-218
- **Severity**: 🟡 Major
- **Category**: Type Safety
- **Problem**: Drizzle's `avg()` returns `string | null` (SQLite returns text for aggregate functions). The `cv` helper correctly calls `Number(v)` for most fields, but `bed.minAmbient` and `bed.maxAmbient` are passed directly to `convertTemp()` which expects `number | null`. The `min()` and `max()` functions in Drizzle also return `number | null` for integer columns, so this works, but the inconsistency between `cv()` (which wraps `Number()`) and the direct `convertTemp()` calls is confusing and fragile. Additionally, the `.output(z.any())` on this and all other environment procedures bypasses type checking entirely.
- **Suggested fix**: Use `cv()` consistently for all aggregate-derived values, or define proper output schemas instead of `z.any()` so TypeScript catches type mismatches.
- **Rationale**: `z.any()` on output disables runtime validation and compile-time type checking. A wrong type will silently pass through to clients.

### Finding 6: All environment and raw router outputs use `z.any()` — no runtime type validation
- **File**: `src/server/routers/environment.ts`:35, 73, 109, 146, 178; `src/server/routers/raw.ts`:44, 97
- **Severity**: 🟢 Minor
- **Category**: Type Safety
- **Problem**: Every query procedure in both new routers uses `.output(z.any())`. This means: (a) the OpenAPI spec will show `any` for response types, making it useless for client generation; (b) no runtime validation catches malformed responses; (c) TypeScript return type is `any`, so callers lose type safety.
- **Suggested fix**: Define proper output schemas. The biometrics router also uses `z.any()` (pre-existing pattern), but this PR adds 7 more instances. At minimum, define output schemas for the most-used endpoints (`getLatestBedTemp`, `getLatestFreezerTemp`).
- **Rationale**: The OpenAPI spec was explicitly updated to include `Environment` and `Raw` tags, suggesting these endpoints are intended to be consumed by clients that benefit from typed responses.

### Finding 7: `listRawFiles()` does `stat()` on every file without limiting count
- **File**: `src/server/routers/raw.ts`:17-36
- **Severity**: 🟢 Minor
- **Category**: Performance
- **Problem**: `listRawFiles()` reads the entire directory, then calls `stat()` on every `.RAW` file via `Promise.all()`. If the `/persistent` directory contains hundreds of RAW files (plausible over months of operation), this creates a burst of filesystem syscalls. The function is called by both `files` (listing) and `deleteFile` (to find the newest file), meaning a delete operation also stats all files.
- **Suggested fix**: For the `deleteFile` use case, only the newest file is needed. Consider a lighter function that just finds the max mtime without statting all files, or add a limit parameter to `listRawFiles()`. Alternatively, since RAW files rotate and old ones get cleaned up, this may be acceptable in practice — but document the assumption.
- **Rationale**: On an embedded device with limited I/O, statting hundreds of files synchronously in an API handler could cause latency spikes.

### Finding 8: `diskUsage` uses `df -B1` which is a GNU coreutils flag, not POSIX
- **File**: `src/server/routers/raw.ts`:100
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: `df -B1` (block size = 1 byte) is a GNU coreutils extension. This works on the target Linux (Yocto) system but will fail on macOS during development, producing confusing errors. The `catch` block will throw a generic `TRPCError` without useful context.
- **Suggested fix**: This is acceptable for production (Linux-only target), but consider adding a dev-environment fallback similar to what `wifiStatus` does (returns graceful fallback when `nmcli` is unavailable). Alternatively, use POSIX `df -k` and multiply by 1024.
- **Rationale**: Developer experience — `diskUsage` will fail hard during local development on macOS while `wifiStatus` degrades gracefully.

### Finding 9: `Content-Disposition` header in raw download is vulnerable to filename injection
- **File**: `app/api/raw/[filename]/route.ts`:49
- **Severity**: 🟢 Minor
- **Category**: Security
- **Problem**: The `Content-Disposition` header uses `filename="${filename}"` with the filename embedded directly in double quotes. While the `SAFE_FILENAME` regex (`/^[\w.-]+\.RAW$/i`) prevents most dangerous characters, the regex allows `.` which means filenames like `....RAW` are valid. More importantly, if the regex is ever relaxed, this becomes an injection point. RFC 6266 recommends percent-encoding for `filename*` parameter.
- **Suggested fix**: This is adequately protected by the current regex. As defense-in-depth, consider using `encodeURIComponent(filename)` with the `filename*=UTF-8''` syntax, or at minimum add a comment noting the regex is a security boundary for this header.
- **Rationale**: Low risk given current regex, but the defense-in-depth pattern would prevent regressions.

### Finding 10: TOCTOU race in `deleteFile` — file could be replaced between `listRawFiles()` and `unlink()`
- **File**: `src/server/routers/raw.ts`:72-86
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The `deleteFile` mutation first calls `listRawFiles()` to check if the target is the newest file, then calls `unlink()`. Between these two operations, a new RAW file could be created, making the previously-newest file now safe to delete, but the check already passed. Conversely, the target file could be replaced with a new active file. This is a time-of-check-to-time-of-use (TOCTOU) race.
- **Suggested fix**: This is low risk in practice — RAW files rotate slowly and the window is tiny. If desired, re-check after acquiring a lock, or use file advisory locking. No change needed for this PR.
- **Rationale**: Theoretical race condition. The consequence (deleting the wrong file or failing to delete a safe file) is low-impact since the system creates new RAW files automatically.

### Finding 11: Python monitor does not validate RAW record field types before database write
- **File**: `modules/environment-monitor/main.py`:99-124
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The `write_bed_temp` and `write_freezer_temp` functions use `record.get("fieldName")` to extract values from CBOR-decoded dicts and pass them directly to SQL. If a malformed CBOR record contains a string where an integer is expected, the write will succeed (SQLite is type-flexible) but the TypeScript layer will receive unexpected types. The `INSERT OR IGNORE` on conflict means bad data could silently replace a good row if timestamps collide.
- **Suggested fix**: Add basic type validation for numeric fields (e.g., `isinstance(v, (int, float))`) before writing, or coerce values with a safe cast. Also consider `INSERT OR IGNORE` semantics: since the unique index is on `timestamp`, a second record with the same timestamp will be silently dropped — which is the intended behavior, but only if the first write was correct.
- **Rationale**: Defense against corrupted or unexpected CBOR data from hardware.

### Finding 12: Python `BIOMETRICS_DATABASE_URL` parsing assumes single `file:` prefix
- **File**: `modules/environment-monitor/main.py`:39-42
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: `BIOMETRICS_DATABASE_URL` is parsed via `.replace("file:", "")`. If someone sets the env var to `file:///persistent/foo.db` (three slashes, valid URI), the result will be `///persistent/foo.db` which is still a valid absolute path. But if set to `file://persistent/foo.db` (relative), the result is `//persistent/foo.db` which may behave unexpectedly. Similarly, `DATABASE_URL` uses the same pattern.
- **Suggested fix**: Use `removeprefix("file:")` (Python 3.9+) or a proper URI parser. Given the controlled deployment environment, this is minor.
- **Rationale**: The env vars are set by the systemd service file and unlikely to be misconfigured, but the parsing is fragile.

### Finding 13: Systemd service `ReadOnlyPaths=/persistent` conflicts with RAW file follower
- **File**: `modules/environment-monitor/sleepypod-environment-monitor.service`:27-28
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: The service file sets `ReadOnlyPaths=/persistent` and `ReadWritePaths=/persistent/sleepypod-data`. The Python monitor reads from `/persistent/*.RAW` (read-only is fine) and writes to `/persistent/sleepypod-data/biometrics.db` (read-write is fine). This is actually correct and well-configured. Noting it as verified rather than a finding.
- **Suggested fix**: No change needed — the sandboxing is correct.
- **Rationale**: Verified that the sandboxing configuration matches the actual I/O pattern.

### Finding 14: `wifiStatus` nmcli parsing doesn't handle SSIDs that start with "yes:"
- **File**: `src/server/routers/system.ts`:165
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: The parser looks for lines starting with `yes:` to find the active connection. The custom escape-aware parser correctly handles colons within SSID names. However, the initial `find(l => l.startsWith('yes:'))` operates on the raw line before parsing. If a non-active line happened to start with `yes:` due to the SSID text, it could be selected instead of the actual active line. In practice, `nmcli -t` always puts ACTIVE first, so a non-active line would start with `no:`.
- **Suggested fix**: No change needed — `nmcli -t -f ACTIVE,SSID,SIGNAL` puts ACTIVE as the first field, so non-active lines always start with `no:`.
- **Rationale**: The parsing logic is correct. The escape-handling parser is well-implemented for a subtle edge case.

### Finding 15: Install script duplicates module deployment logic
- **File**: `scripts/install`:677-709
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: The install script has two code paths that deploy modules: (1) the `install_module` function (lines ~453-504) called during initial install, and (2) a separate inline loop (lines ~677-709) in what appears to be the update/sync section. These two paths have subtly different logic — the inline version doesn't check for `python3-venv` availability, uses different error handling, and lacks the `manifest.json` validation that could be added to `install_module`. This duplication will drift over time.
- **Suggested fix**: Refactor the inline module sync (lines 677-709) to reuse the `install_module` function. If the contexts differ, parameterize the function rather than duplicating it.
- **Rationale**: DRY violation — the two deployment paths can drift, leading to inconsistent module installations between fresh installs and updates.

### Finding 16: No test coverage for any new router procedures
- **File**: `src/server/routers/environment.ts`, `src/server/routers/raw.ts`
- **Severity**: 🟢 Minor
- **Category**: Testing
- **Problem**: The branch adds 8 new tRPC procedures (5 in environment, 3 in raw) and a Next.js route handler, with zero test coverage. The environment router has non-trivial logic (centidegree conversion, aggregate queries, date range validation) that would benefit from unit tests. The raw router's delete-newest-file protection logic is also testable.
- **Suggested fix**: Add at least unit tests for: (a) `convertTemp` and `convertHumidity` helpers, (b) the delete-newest-file guard in `deleteFile`, (c) the `getSummary` aggregate conversion logic. The biometrics router also lacks tests (pre-existing), but this PR adds more surface area.
- **Rationale**: The `convertTemp` function is used on every response row. A bug here (e.g., wrong division) would silently produce incorrect temperatures for all consumers.

### Finding 17: `ensureF` export from `tempUtils.ts` is unused in this branch
- **File**: `src/lib/tempUtils.ts`:34
- **Severity**: 🟣 Pre-existing
- **Category**: Architecture
- **Problem**: The new `centiDegreesToC`, `centiDegreesToF`, and `centiPercentToPercent` functions are well-placed. However, the existing `ensureF` function could have been used in `convertTemp` instead of the manual conditional. This is a minor pre-existing pattern inconsistency.
- **Suggested fix**: No change needed. The `convertTemp` function appropriately uses the raw conversion functions directly since `ensureF` is designed for a different use case (converting user input that might be in C or F).
- **Rationale**: Noting for completeness — the new functions are correctly implemented.

### Finding 18: `realpath` import is unused in `raw.ts` route handler pattern
- **File**: `app/api/raw/[filename]/route.ts`:3
- **Severity**: ⚪ Nit
- **Category**: Architecture
- **Problem**: The `realpath` import is used, but the `realpath` check (line 36-39) is redundant with the `lstat` symlink check (line 30-33) given the `SAFE_FILENAME` regex already prevents `..` and path separators. The three layers of defense (regex, `startsWith`, `lstat` + `realpath`) are arguably good defense-in-depth, but the `realpath` call adds an extra filesystem syscall per request.
- **Suggested fix**: Keep it — defense-in-depth is appropriate for a file-serving endpoint. The extra syscall cost is negligible.
- **Rationale**: Verified that the layered security approach is intentional and correct.

### Finding 19: `dateRangeInput` in environment router uses `.strict()` which may break tRPC
- **File**: `src/server/routers/environment.ts`:21-29
- **Severity**: ⚪ Nit
- **Category**: Pattern
- **Problem**: The `dateRangeInput` schema uses `.strict()` which rejects unknown keys. The biometrics router also uses `.strict()` on its inputs, so this is consistent with the project pattern. However, tRPC's internal processing sometimes adds extra properties to the input object, which `.strict()` would reject. This hasn't been a problem in the existing code, so it's likely safe.
- **Suggested fix**: No change needed — consistent with existing pattern and verified working.
- **Rationale**: Confirming pattern consistency.

## Statistics
- **Total**: 19 (includes 4 verified-correct observations)
- **Critical**: 0
- **Major**: 3 (Findings 1, 2, 5)
- **Minor**: 7 (Findings 6, 7, 8, 9, 11, 15, 16)
- **Nit**: 4 (Findings 13, 14, 18, 19)
- **Pre-existing**: 3 (Findings 3, 4, 17)
