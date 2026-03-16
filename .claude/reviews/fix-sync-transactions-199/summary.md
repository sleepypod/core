# Code Review Summary — fix/sync-transactions-199 (PR #200)
Date: 2026-03-15
Depth: standard (Sonnet Optimizer + Sonnet Skeptic)
Branch: fix/sync-transactions-199 → dev

## What changed
Converts all 10 `db.transaction(async (tx) => { await tx... })` calls to synchronous `db.transaction((tx) => { tx...all() })` across `schedules.ts` (9 transactions) and `settings.ts` (1 transaction). Fixes #199 — all schedule and settings write operations were returning 500 "Transaction function cannot return a promise" because better-sqlite3 only supports synchronous transaction callbacks.

## Findings

### Confirmed (5)

| # | Source | Severity | File | Finding | Status |
|---|--------|----------|------|---------|--------|
| O-1 | Optimizer (modified by Skeptic) | 🟢 Minor | `schedules.ts:118` + all mutation catch blocks | `reloadScheduler()` inside `try` block — if scheduler reload fails after committed DB write, caller gets misleading 500 error | Deferred |
| O-2 | Optimizer | 🟢 Minor | `schedules.ts:197,387,538` | Delete handlers silently drop `db.transaction()` return value — intent ambiguous | Deferred |
| O-3 | Optimizer | 🟢 Minor | `schedules.ts:228,281` | `createPowerSchedule` and `updatePowerSchedule` missing `.meta()` and `.output()` — unreachable via REST/OpenAPI | Deferred |
| O-5 | Optimizer | ⚪ Nit | `schedules.ts:201` | No comment explaining better-sqlite3 rollback-on-throw guarantee | Noted |
| O-8 | Optimizer | ⚪ Nit | N/A | Issue #199 completeness confirmed — all 9 broken mutations fixed | N/A |

### Disputed (1)

| # | Finding | Optimizer | Skeptic | Resolution |
|---|---------|-----------|---------|------------|
| O-6 | Empty-string falsy check on `rebootTime`/`primePodTime` | 🟣 Pre-existing — add `.trim()` guard | ⚠️ Disagree — empty string unreachable via `timeStringSchema`; `trim()` implies impossible state | **Skeptic wins** — no change needed |

### Pre-existing (4)

| # | Source | Severity | File | Finding |
|---|--------|----------|------|---------|
| O-7 | Optimizer | 🟣 | `schedules.ts:51-65,577-606` | `Promise.all` on synchronous better-sqlite3 queries — no actual parallelism |
| S-4 | Skeptic | 🟣 | `settings.ts` (updateSide, setGesture, deleteGesture) | Still use `await db.update().returning()` without `.all()` — inconsistent with fix pattern but works |
| S-5 | Skeptic | 🟣 | `src/scheduler/instance.ts:42-60` | `getJobManager()` singleton race: failed `loadSchedules()` clears init promise, retry may get different timezone |
| S-6 | Skeptic | 🟣 | `src/server/validation-schemas.ts` | `validateTimeRange` rejects midnight-crossing schedules (22:00→06:00) |

### Noted only (3)

| # | Source | Severity | Finding |
|---|--------|----------|---------|
| O-4 | Optimizer | ⚪ Nit | `reloadSchedulerIfNeeded` accepts `Record<string, unknown>` instead of typed input |
| S-1 | Skeptic | 🟡 Major (pre-existing) | `updatePowerSchedule` partial-time validation asymmetry — constraint not re-evaluated for non-time updates |
| S-2 | Skeptic | 🟢 Minor | Comment gap: `reloadScheduler()` only reached on success, but control flow is implicit |

## Mechanical checks
- Lint: pass
- TypeScript: pass (0 errors)
- Tests: pass (400 passed, 2 skipped)

## Verification
No auto-fixes applied (review-only mode). All mechanical checks green.

## Recommendation
**Approve** — the core fix is correct, complete, and mechanically verified. No Critical or Major issues in the changed code. All flagged items are either pre-existing, nits, or out-of-scope for this bug fix PR.
