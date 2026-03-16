# Merged Optimizer Findings — feat/environment-raw-management

## Summary
This branch adds environment monitoring (Python daemon for bed/freezer temps), RAW file management endpoints, WiFi status, and supporting migrations/schema. Both models found it well-structured with solid security practices.

## Consensus Findings (flagged by BOTH models)

### MF-1: Duplicate migration file `0002_mushy_loki.sql`
- **Sonnet**: 🔴 Critical | **Opus**: 🟡 Major
- **Consensus Severity**: 🔴 Critical
- **File**: `src/db/biometrics-migrations/0002_mushy_loki.sql`
- **Problem**: Orphaned duplicate of `0002_fuzzy_strong_guy.sql`, not referenced in journal. Will confuse drizzle tooling.
- **Fix**: Delete the file.

### MF-2: `deleteFile` protect:true is decorative — no actual auth
- **Sonnet**: 🟡 Major | **Opus**: 🟡 Major
- **Consensus Severity**: 🟡 Major
- **File**: `src/server/routers/raw.ts:59`
- **Problem**: `protect: true` suggests auth but `publicProcedure` has no enforcement. Misleading.
- **Fix**: Change to `protect: false` with a comment (matching systemRouter pattern), or implement real auth.

### MF-3: All output schemas use `z.any()` — no type safety
- **Sonnet**: 🟡 Major | **Opus**: 🟡 Major (split across F5/F6)
- **Consensus Severity**: 🟡 Major
- **File**: environment.ts (5 instances), raw.ts (2 instances)
- **Problem**: 7 new `z.any()` outputs defeat tRPC type inference and OpenAPI spec.
- **Fix**: Define proper Zod output schemas.

### MF-4: `df -B1` fragile on macOS / non-GNU systems
- **Sonnet**: 🟡 Major | **Opus**: 🟢 Minor
- **Consensus Severity**: 🟡 Major
- **File**: `src/server/routers/raw.ts:101`
- **Fix**: Use `fs.statfs()` (Node 18+) or add dev fallback.

### MF-5: No test coverage for new procedures
- **Sonnet**: (not explicit) | **Opus**: 🟢 Minor
- **File**: environment.ts, raw.ts
- **Fix**: Add unit tests for convertTemp, deleteFile guard, getSummary.

### MF-6: Install script duplicates module deployment logic
- **Sonnet**: (not explicit) | **Opus**: 🟢 Minor
- **File**: `scripts/install:677-709`
- **Fix**: Refactor sp-update module sync to reuse `install_module` function.

## Sonnet-only Findings

### SF-1: `startsWith` path check missing trailing separator
- **Severity**: 🔴 Critical
- **File**: `raw.ts:68`, `route.ts:22`
- **Problem**: `/persistent2/evil.RAW` passes `startsWith("/persistent")`. Mitigated by SAFE_FILENAME regex but latent footgun.
- **Fix**: Append `path.sep` to canonical dir before check.

### SF-2: RAW file listing/download has no authentication
- **Severity**: 🟡 Major
- **File**: `raw.ts:41-54`, `route.ts`
- **Problem**: Unauthenticated streaming of biometric sensor data.

### SF-3: `getSummary` sequential awaits should be parallel
- **Severity**: 🟡 Major
- **File**: `environment.ts:190-218`
- **Fix**: Use `Promise.all`.

### SF-4: TOCTOU race in deleteFile active-file guard
- **Severity**: 🟡 Major (Sonnet) / 🟢 Minor (Opus agreed low risk)

### SF-5: `check_same_thread=False` unnecessary
- **Severity**: 🟢 Minor
- **File**: `main.py:81`

### SF-6: `listRawFiles` uses `stat` not `lstat` — follows symlinks
- **Severity**: 🟢 Minor
- **File**: `raw.ts:22`

## Opus-only Findings

### OF-1: Python record field types not validated before DB write
- **Severity**: 🟢 Minor
- **File**: `main.py:99-124`

### OF-2: `file:` URI parsing fragile
- **Severity**: 🟢 Minor
- **File**: `main.py:39-42`

## Pre-existing (both models)
- `setInternetAccess` unprotected (Opus)
- `triggerUpdate` unprotected (Opus)
- `wifiStatus` swallows all errors (Sonnet)
