# Skeptic Review — commit d42be8d (post-merge, branch dev)

Reviewed files:
- `src/server/routers/biometrics.ts`
- `src/server/routers/settings.ts`

---

## Finding 1 — iOS client hard-codes `side` in all biometric queries (MEDIUM blast radius)

**Status: low real-world risk, but the intent is misleading**

The commit makes `side` optional in `getSleepRecords`, `getVitals`, and `getMovement`. However, the current iOS client (`SleepypodCoreClient.swift`, lines 291–327) always provides a side:

```swift
func getSleepRecords(side: Side? = nil, ...) async throws -> [SleepRecord] {
    var input: [String: Any] = [:]
    input["side"] = (side ?? .left).rawValue   // always sends "left" as fallback
    ...
}
```

Same pattern for `getVitals` and `getMovement`. The iOS client will **never** omit side. This means:
- No existing iOS client will hit the new "no side" code path in production today.
- A future caller (web panel, scripts, curl) that omits side will silently get **both sides interleaved** with no indication in the response that filtering was skipped.

**Risk:** If a future caller expects single-side data but forgets to pass `side`, the query succeeds without error, returning mixed data. This is a silent semantic failure, not a crash.

---

## Finding 2 — `and(...conditions)` with empty array returns `undefined`, producing a full table scan (CONFIRMED BUG, MEDIUM severity)

**Verified:** `and(...[])` in drizzle-orm 0.45.1 returns `undefined`. Passing `undefined` to `.where()` generates SQL with no WHERE clause — a full table scan.

The three affected queries (`getSleepRecords`, `getVitals`, `getMovement`) will now execute `SELECT ... FROM <table> ORDER BY ... LIMIT <n>` with no filtering if all of `side`, `startDate`, and `endDate` are omitted. This is the intended behavior per the "optional side" change, but:

1. It was never the behavior before this commit — previously `side` was required, so a fully-unfiltered query was impossible.
2. The `limit` cap (30 for sleep records, 288 for vitals/movement, max 1000) means this won't be catastrophically expensive, but it will return data from both sides mixed together with no caller indication that no filter was applied.
3. `getVitals` with no arguments and the default limit of 288 returns the 288 most-recent vitals from *either* side — which may be all left-side or all right-side depending on which was last written, completely defeating the "24 hours of intervals" comment.

**No crash risk** — the `undefined` path is safe in Drizzle with better-sqlite3. The risk is silent data contamination.

---

## Finding 3 — Default values in `getAll` have multiple schema mismatches (HIGH)

The fallback device object injected when no DB row exists (`settings.ts`, lines 54–64):

| Field | Hardcoded default | Schema default |
|---|---|---|
| `timezone` | `'America/New_York'` | `'America/Los_Angeles'` |
| `temperatureUnit` | `'f'` (lowercase) | `'F'` (uppercase, enum `['F','C']`) |
| `rebootTime` | `null` | `'03:00'` |
| `primePodTime` | `null` | `'14:00'` |

**timezone mismatch:** If the DB row is absent, the pod behaves as if it is in New York, but the actual schema default seeds it as Los Angeles. Any logic that reads this value from `getAll` will disagree with the value that would be stored after the first `INSERT`.

**temperatureUnit case mismatch:** The iOS client at line 585 compares `device?.temperatureUnit == "C"` — the `'f'` fallback will pass the `!= "C"` check and return `.fahrenheit`, which happens to be correct. However, the schema enum is `['F', 'C']` (uppercase). If any server-side code compares the returned value against the schema enum `'F'`, the fake `'f'` default will fail that comparison. This is a latent type-safety bug that won't show up until another code path reads it.

**rebootTime / primePodTime null vs schema default:** The schema defaults to `'03:00'` and `'14:00'` respectively (not null). A caller receiving the fake default row sees `null` for both, while the real DB row would have string values. Scheduler code that reads these for time parsing could behave differently depending on whether a real or fake row is returned.

**Missing `id` field on side defaults (confirmed):** Lines 66–67:

```ts
left: sides.find(s => s.side === 'left') ?? { side: 'left' as const, name: 'Left', awayMode: false, createdAt: new Date(), updatedAt: new Date() },
```

The `sideSettings` schema has no `id` column (`side` is the primary key), so the missing `id` is **not** a bug. This specific concern from the brief does not apply.

---

## Finding 4 — `new Date()` in defaults vs Drizzle integer timestamp storage (LOW-MEDIUM)

The `createdAt`/`updatedAt` defaults use `new Date()` (a JavaScript Date object). The schema defines these columns as `integer('created_at', { mode: 'timestamp' })` with a DB-level default of `sql\`(unixepoch())\``.

When Drizzle reads a real DB row, it converts the stored integer epoch to a JS `Date` object automatically. So far consistent.

The fake default rows in `getAll` also use `new Date()`, which is a JS Date — structurally compatible with what a real row would return. **No serialization mismatch** at the type level.

However: `new Date()` is evaluated at **request time** on the fallback path, while `sql\`(unixepoch())\`` would be evaluated at insert time on a real row. The effective times differ: a real row has a stable `createdAt`, the fake row's `createdAt` changes on every request. Any client caching or diffing on `createdAt` would see the fake row as perpetually "just created," potentially triggering spurious cache invalidations.

The `getVitalsSummary` endpoint (lines 368–370) computes `effectiveStart`/`effectiveEnd` using `new Date()` inside the query handler. This is called at request time, so there is no persistence concern — the Date objects are ephemeral and consumed immediately by Drizzle as query parameters. No issue here.

---

## Finding 5 — `.all()` on single-row-expectation queries (LOW)

The added `.all()` calls in `settings.ts` are used with `[result] = ...` destructuring, which is the correct Drizzle better-sqlite3 pattern for synchronous single-row extraction. No queries that semantically expect exactly one row are using `.all()` in a way that would hide a multi-row problem — the first-element destructure silently discards extra rows, but these are all primary-key lookups (`WHERE id = 1`, `WHERE side = ?`), so returning multiple rows is not possible.

The `setGesture` path (line 256) uses `.limit(1).all()` on its existence check, which is correct.

**One real issue:** `updateDevice` (line 104) calls `db.transaction(...)` without `await`:

```ts
const updated = db.transaction((tx) => { ... })   // no await
```

With better-sqlite3, `db.transaction()` is **synchronous** and returns the value directly — not a Promise. So `await` is not needed and `const updated` will hold the result synchronously. This is not a bug. However, the surrounding function is `async` and the next line does `await reloadSchedulerIfNeeded(input)`. The inconsistency is confusing to readers and could break if the DB driver is ever switched to an async one (e.g., libsql). Low risk today, technical debt to flag.

---

## Finding 6 — `getVitalsSummary` side is still required but dates are now optional (INCONSISTENCY)

`getVitalsSummary` (line 348) kept `side: sideSchema` as required. The other three endpoints made side optional. This asymmetry is fine for the summary endpoint (aggregating both sides together would produce meaningless results), but the docstring still says:

> `@param side - Which side to summarize`
> `@param startDate - Start of date range (inclusive)` [previously required, now optional]

The JSDoc was not updated to reflect that `startDate`/`endDate` are now optional. Minor documentation debt.

---

## Summary Table

| # | Issue | Severity | Crashes? | Affects iOS today? |
|---|---|---|---|---|
| 1 | iOS always sends side; optional side is dead code in prod | Low | No | No |
| 2 | Empty conditions → full table scan (both sides, no filter) | Medium | No | No (iOS sends side) |
| 3 | Default `timezone` disagrees with schema ('New York' vs 'LA'); `temperatureUnit` wrong case (`'f'` vs `'F'`); `rebootTime`/`primePodTime` null vs schema string defaults | High | No | Yes (first boot or empty DB) |
| 4 | `new Date()` in fake defaults changes per-request; real rows are stable | Low | No | Edge case |
| 5 | `db.transaction()` not awaited — correct for better-sqlite3 but fragile pattern | Low | No | No |
| 6 | JSDoc not updated for now-optional dates in `getVitalsSummary` | Trivial | No | No |

**Most actionable fix:** The `temperatureUnit: 'f'` default should be `'F'` to match the schema enum, and `timezone` should be `'America/Los_Angeles'` to match the schema default. Both are one-line fixes.
