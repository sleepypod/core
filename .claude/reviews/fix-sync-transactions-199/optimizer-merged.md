# Optimizer Findings — fix/sync-transactions-199

## Summary

This branch fixes a runtime crash in all schedule and settings write operations caused by passing `async` callbacks to `db.transaction()` on a `better-sqlite3` driver, which only supports synchronous transaction callbacks. The fix converts nine transaction callbacks from `async (tx) => { await tx.op() }` to `(tx) => { tx.op().all() }` and adds the synchronous `.all()` terminator required by the better-sqlite3 Drizzle adapter. The `await` keyword is removed from the `db.transaction(...)` call site, which is now synchronous; `await reloadScheduler()` is correctly preserved outside the transaction.

Overall the fix is targeted and mechanically sound. It addresses all nine broken mutations across `schedules.ts` (9 procedures) and `settings.ts` (1 procedure). Two structural issues are introduced: error propagation for scheduler-reload failures bleeds into mutation error messages (pre-existing but newly surfaced by the fix structure), and the three delete handlers silently discard the synchronous transaction return value (harmless but imprecise). No new security or performance concerns are introduced.

## Findings

### Finding 1: Scheduler reload failures produce misleading mutation error messages
- **File**: `src/server/routers/schedules.ts:118-126` (and all analogous catch blocks — lines 171-178, 215-222, 269-276, 360-365, 404-409, 452-459, 510-514, 554-558) and `src/server/routers/settings.ts:151-158`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: `reloadScheduler()` is called inside the `try` block that wraps the mutation. If `reloadScheduler()` throws (e.g., the job manager is not yet initialized, or node-schedule throws on a malformed schedule), the error is caught and re-wrapped as, for example, `"Failed to create temperature schedule: ..."`. The DB mutation has already committed at that point — the record was created successfully. The caller receives a 500 with a message that implies the write failed, but the data is actually persisted. This creates a confusing state where the iOS app may retry, creating a duplicate record.
- **Suggested fix**: Separate the scheduler reload into its own try/catch with a distinct error code or log-and-continue pattern:
  ```typescript
  const created = db.transaction((tx) => { ... })
  try {
    await reloadScheduler()
  } catch (schedErr) {
    // Log and continue — DB record is committed; scheduler will pick up on next boot/reload
    console.error('Failed to reload scheduler after schedule create:', schedErr)
  }
  return created
  ```
- **Rationale**: A committed DB write should not surface as a write failure. Callers (iOS app) may retry on 500 and create duplicate schedules.

---

### Finding 2: Delete handlers drop the `db.transaction()` return value without comment
- **File**: `src/server/routers/schedules.ts:197`, `387`, `538`; `settings.ts` — N/A (update, not delete)
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The three delete mutations call `db.transaction(...)` as a statement with no assignment:
  ```typescript
  db.transaction((tx) => {
    const [deleted] = tx.delete(...).returning().all()
    if (!deleted) { throw new TRPCError({ code: 'NOT_FOUND', ... }) }
  })
  ```
  The callback returns `void` implicitly, and since better-sqlite3 transactions propagate synchronous throws, a NOT_FOUND error inside will surface correctly to the outer `catch`. However, the discarded return value and the lack of an explicit `void` cast makes the intent ambiguous to readers. A future maintainer might accidentally add an `async` qualifier back to the callback thinking it was intentional.
- **Suggested fix**: Assign the call (even as `void`) or add an explicit cast:
  ```typescript
  void db.transaction((tx) => { ... })
  // OR
  db.transaction<void>((tx) => { ... })
  ```
- **Rationale**: Clarity and resistance to accidental re-introduction of the async bug.

---

### Finding 3: Inconsistency — `createPowerSchedule` and `updatePowerSchedule` lack `.meta()` / OpenAPI exposure
- **File**: `src/server/routers/schedules.ts:228`, `281`
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: Every other CRUD procedure in `schedulesRouter` has `.meta({ openapi: { method: ..., path: ..., protect: false, tags: ['Schedules'] } })`. `createPowerSchedule` (line 228) and `updatePowerSchedule` (line 281) have no `.meta()` call and no `.output()` schema, meaning they are invisible to the OpenAPI/REST layer. This pre-dates this PR but the PR touches both files and is the right moment to flag it.
- **Suggested fix**: Add `.meta()` and `.output(z.any())` to both procedures, consistent with their sibling procedures.
- **Rationale**: The iOS app accesses the REST layer via the OpenAPI handler added in #179. Missing `.meta()` means `createPowerSchedule` and `updatePowerSchedule` are unreachable via REST and invisible to the CI-generated OpenAPI contract.

---

### Finding 4: `reloadSchedulerIfNeeded` type parameter accepts `Record<string, unknown>` but actual input is a strongly-typed Zod output
- **File**: `src/server/routers/settings.ts:19`, called at line 147
- **Severity**: ⚪ Nit
- **Category**: Type Safety
- **Problem**: `reloadSchedulerIfNeeded(input: Record<string, unknown>)` erases the input type at the call boundary. TypeScript accepts the call because the inferred Zod output type is structurally assignable, but the explicit downcast means the function body cannot leverage Zod-typed narrowing without additional casts. This is pre-existing but worth tightening.
- **Suggested fix**: Parameterize the function or inline the scheduling-key check:
  ```typescript
  async function reloadSchedulerIfNeeded(input: Partial<UpdateDeviceInput>): Promise<void>
  ```
- **Rationale**: Low risk, but type erasure at this boundary can hide future refactoring errors if the scheduling keys are renamed.

---

### Finding 5: `TRPCError` thrown inside synchronous `db.transaction()` bypasses SQLite rollback in the NOT_FOUND path for delete operations — relies on better-sqlite3 propagation guarantee
- **File**: `src/server/routers/schedules.ts:201-206`, `395-400`, `543-548`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: Throwing a JS exception inside a better-sqlite3 transaction callback causes the driver to call `ROLLBACK` before re-throwing. This is documented behavior for better-sqlite3. For a `DELETE ... RETURNING` operation where `returning().all()` returns an empty array (record not found), no rows were deleted, so rollback is a no-op. The behavior is correct, but it relies on the reader knowing this better-sqlite3 guarantee. A comment would reduce cognitive load.
- **Suggested fix**: Add a brief comment:
  ```typescript
  // better-sqlite3 rolls back and re-throws on exception
  if (!deleted) {
    throw new TRPCError({ code: 'NOT_FOUND', ... })
  }
  ```
- **Rationale**: Documentation clarity; guards against future migration to an async SQLite driver where this throw-inside-transaction pattern would break.

---

### Finding 6: `rebootTime` and `primePodTime` validation may pass `null` from DB as truthy check in computed-final-state logic
- **File**: `src/server/routers/settings.ts:116-127`
- **Severity**: 🟣 Pre-existing
- **Category**: Correctness
- **Problem**: The guards `if (finalRebootDaily && !finalRebootTime)` and `if (finalPrimeDaily && !finalPrimeTime)` treat any falsy `finalRebootTime` as "time not set." If the DB stores `rebootTime` as `null` (its initial/default value), `!null` is `true`, which is the correct check. However, if the DB schema allows an empty string `""` as a valid stored value (timeStringSchema validation on input only blocks empty strings on writes, not on existing DB rows), `!""` is also `true` — meaning the validation incorrectly rejects enabling reboot when a stale empty-string value exists. This is pre-existing.
- **Suggested fix**: Tighten the check: `!finalRebootTime || finalRebootTime.trim() === ''`.
- **Rationale**: Defensive against inconsistent DB state; not introduced by this PR.

---

### Finding 7: `getAll` and `getByDay` query procedures use `Promise.all` on better-sqlite3 which is a single-connection synchronous driver
- **File**: `src/server/routers/schedules.ts:51-65`, `577-606`
- **Severity**: 🟣 Pre-existing
- **Category**: Performance
- **Problem**: `Promise.all([db.select()..., db.select()..., db.select()...])` with better-sqlite3 executes three queries. Because better-sqlite3 is synchronous and single-connection, these queries do not actually run in parallel — they are serialized. `Promise.all` adds overhead without benefit and misleads readers into believing parallel I/O is occurring. This is pre-existing and not introduced by this PR.
- **Suggested fix**: Execute the three queries sequentially, or add a comment explaining the `Promise.all` is used for syntactic convenience (destructuring), not for parallelism.
- **Rationale**: Avoids misleading the reader about performance characteristics of the synchronous SQLite driver.

---

### Finding 8: Issue #199 completeness — all listed broken mutations are fixed
- **File**: N/A
- **Severity**: ⚪ Nit
- **Category**: Completeness
- **Problem**: Issue #199 names `createTemperatureSchedule`, `createPowerSchedule`, `createAlarmSchedule` explicitly. The PR also correctly fixes `updateTemperatureSchedule`, `updatePowerSchedule`, `updateAlarmSchedule`, `deleteTemperatureSchedule`, `deletePowerSchedule`, `deleteAlarmSchedule` in `schedules.ts`, and `updateDevice` in `settings.ts` — 9 mutations in total. All broken mutations are addressed. No outstanding gaps.
- **Suggested fix**: None — completeness confirmed.
- **Rationale**: Issue requirements are fully met.

## Statistics
- Total findings: 8
- 🔴 Critical: 0
- 🟡 Major: 1
- 🟢 Minor: 2
- ⚪ Nit: 3
- 🟣 Pre-existing: 2
