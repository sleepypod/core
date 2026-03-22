# Skeptic Challenge Report (Opus) — feat/browser-ui-parity

## Challenges to Optimizer Findings

### RE: Finding 1 — Seven barrel export files violate project convention
- **Verdict**: ⚠️ Disagree
- **Confidence**: 70
- **Challenge**: The import-patterns doc bans barrel exports to avoid "indirection, circular dependency risks, slows bundlers." This rationale applies to cross-module barrels (e.g., `src/hardware/index.ts` re-exporting everything). However, 5 of the 7 files here are _intra-component_ barrels for multi-file component directories (e.g., `src/components/SleepStages/index.ts` grouping `SleepStagesCard`, `Hypnogram`, `QualityScore`, etc.). These are closer to a component package boundary than a barrel. The `sleepCurve/index.ts` is the strongest case -- it aggregates 3 internal files across types, generation logic, and color mapping. Deleting all 7 would force consumers like `data/page.tsx` to import from 3-4 separate paths per component family, which adds noise for minimal bundler benefit (Next.js tree-shakes `index.ts` re-exports fine with webpack/turbopack). That said, the convention is explicit: "never create barrel exports." The literal rule was broken even if the rationale doesn't fully apply.
- **Alternative**: Rather than deleting all 7, update the import-patterns doc to carve out an exception for multi-file component directories (which didn't exist when the rule was written). Or delete the 2 that are actually consumed by external pages (`SleepStages`, `Environment`) and leave the rest as dead re-exports that can be cleaned up when direct imports are added.
- **Risk if applied as-is**: Low risk, but creates 20+ import path changes across consuming files for a style-only benefit. Could introduce typos during the migration.

### RE: Finding 2 — Duplicate SideSelector rendered on Temp screen
- **Verdict**: ✅ Agree
- **Confidence**: 95
- **Challenge**: Confirmed. `app/[lang]/layout.tsx:48` renders `<SideSelector />` globally. `TempScreen.tsx:161` renders a second `<SideSelector />`. Both share state via SideProvider so they won't conflict functionally, but two identical interactive controls stacked on the same screen is clearly a bug.
- **Alternative**: None needed. Remove from TempScreen.
- **Risk if applied as-is**: None.

### RE: Finding 3 — Debounce/setTimeout timers not cleaned up on unmount
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 80
- **Challenge**: The core concern is valid -- timers that fire `mutate()` after unmount _will_ send network requests to the server. However, the Optimizer's severity assessment overweights the actual risk. In tRPC/React Query, mutations fired after unmount won't crash the app or cause memory leaks (React Query handles this gracefully). The mutation will execute, the server will process it, and the `onSuccess`/`onSettled` callbacks will be no-ops because the query cache still exists. The real risk is _user surprise_ -- e.g., navigating away from schedule editing mid-debounce causes a phantom temperature change. That's a UX issue, not a crash/leak.

  Additionally, the `CurveEditor.tsx:149,153` callout appears incorrect. Looking at the actual code, `CurveEditor.handleApply` uses `await Promise.all` (not setTimeout) -- the `setTimeout` there is only for the `setSaveStatus('idle')` call after 2-3 seconds, which is a cosmetic animation timer, not a mutation debounce. Cleaning it up is a nit, not a correctness issue.
- **Alternative**: Add cleanup for the mutation-triggering debounces in `TempScreen.tsx` (debounceRef) and `AlarmScheduleSection.tsx` (intensityCommitRef, alarmTempCommitRef). Leave the cosmetic `setSaveStatus` and `setConfirmMessage` timers as-is since they only update local state.
- **Risk if applied as-is**: None if applied correctly, but overcleaning cosmetic timers adds boilerplate with no user benefit.

### RE: Finding 4 — Pervasive `any` types in schedule/biometrics code
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 75
- **Challenge**: The `any` types in `useSchedules.ts` (`power: any[]`, `alarm: any[]`) and `ScheduleOverview.tsx` are real issues -- proper types exist in `useSchedule.ts` and could be imported. However, the severity should remain Minor, not Major. The `any` types here are in display-only components that destructure specific known fields (`ps.onTime`, `ps.offTime`, `as.time`). A type mismatch would produce `undefined` rendering, not a runtime crash. The risk is low because these fields are dictated by the server schema which hasn't changed.

  For the CSV export functions (`RawDataButton.tsx`), the `any` types with `eslint-disable` are pragmatic -- the CSV functions receive the raw tRPC response and extract known fields. Typing them would require importing/constructing the exact tRPC output type, which is verbose for a one-off export utility.
- **Alternative**: Type the schedule cards as suggested. Leave CSV functions with `any` but add a `// tRPC output shape` comment.
- **Risk if applied as-is**: Minimal risk, but the work to properly type tRPC output responses for CSV may not be worth the effort for non-critical display code.

### RE: Finding 5 — `getSleepStages` endpoint uses `z.any()` output schema
- **Verdict**: ✅ Agree
- **Confidence**: 90
- **Challenge**: Valid finding. `z.any()` output is a real issue because it breaks the tRPC end-to-end contract -- the client has no runtime validation of server responses. Sonnet correctly noted this applies to all 9 biometrics procedures, not just `getSleepStages`. However, since this is a pre-existing pattern across the entire biometrics router (not introduced by this PR for the first time), calling it a "Major" is slightly aggressive for a PR review scope. The `SleepStagesResult` type is well-defined and could easily have a Zod companion, but so could all the others.
- **Alternative**: Create Zod schemas for `getSleepStages` output as the exemplar, then file a follow-up issue for the other 8 procedures.
- **Risk if applied as-is**: No risk in adding proper output schemas. But be aware that adding strict Zod output validation could _reject_ legitimate responses if the schema doesn't perfectly match the Drizzle output types (e.g., `Date` vs `string` serialization).

### RE: Finding 6 — Serial mutations in bulk schedule operations
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 70
- **Challenge**: The `toggleAllSchedules` and `applyToOtherDays` functions in `useSchedule.ts` are indeed sequential, but this is partially by design. Each mutation triggers `invalidateAll()` which reloads the scheduler on the backend. If parallelized naively with `Promise.all`, all mutations would fire before any invalidation, potentially causing the scheduler to process stale state during the intermediate period. More importantly, the `applyToOtherDays` function _deletes then recreates_ schedules per day. Parallelizing across days is safe (delete Mon + delete Tue simultaneously), but parallelizing within a day (delete Mon schedules while creating Mon schedules) could race.

  The `CurveEditor.tsx:149-175` reference is partially wrong -- looking at the actual code, the CurveEditor already uses `Promise.all` for deletions and creations within each day (lines 155-174), only iterating sequentially across days. That's actually a reasonable approach.
- **Alternative**: Parallelize `toggleAllSchedules` across days with `Promise.all`, then call `invalidateAll()` once at the end. For `applyToOtherDays`, the current sequential-by-day approach is correct; move the invalidation to the end instead of per-mutation.
- **Risk if applied as-is**: Parallelizing naively could cause scheduler reload to see partially-applied state. Each `onSuccess: () => invalidateAll()` fires per mutation, meaning N invalidations instead of 1. The fix should focus on the invalidation strategy, not just parallelism.

### RE: Finding 7 — PowerButton fires concurrent mutations without coordination
- **Verdict**: ✅ Agree
- **Confidence**: 85
- **Challenge**: Valid concern. In linked mode, `setPower.mutate()` is called twice in rapid succession. Since `mutate()` is fire-and-forget (not `mutateAsync`), there's no coordination. If the first mutation succeeds and the second fails (hardware timeout), the pod ends up with split power state. The suggestion to use `Promise.all` with `mutateAsync` is correct. The alternative suggestion to create a server-side `setMultiSidePower` endpoint is over-engineered for the current use case -- the hardware protocol processes left and right independently anyway.
- **Alternative**: Wrap in `Promise.all([...activeSides.map(side => setPower.mutateAsync({...}))])` with a `.catch()` handler that refetches status and shows an error toast. Skip the server-side endpoint.
- **Risk if applied as-is**: The `Promise.all` approach is safe. The server-side endpoint suggestion adds API surface for little benefit.

### RE: Finding 8 — Dual `useSide` exports create naming confusion
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 65
- **Challenge**: The finding is architecturally valid but the severity is inflated. `src/hooks/useSide.ts` is a documented "compatibility shim" that provides `{ side, setSide, toggleSide }` -- a simplified interface for components that don't need linked/both mode. `src/providers/SideProvider.tsx` exports the full context hook with `{ selectedSide, isLinked, selectSide, toggleLink, activeSides, primarySide }`. The shim is only 27 lines and its JSDoc explains its purpose clearly. Components import from different paths (`@/src/hooks/useSide` vs `@/src/providers/SideProvider`) which makes the distinction clear at the import site. This is a common React pattern (see Radix UI's `useDialogContext` / `useDialog`).
- **Alternative**: Rename the shim to `useSideSimple` if the naming collision is truly confusing. But a breaking rename across all consuming components is high-churn for low benefit. A better fix: add a `@deprecated Use useSide from SideProvider instead` JSDoc tag to the shim and migrate consumers over time.
- **Risk if applied as-is**: Renaming to `useSimpleSide` requires touching every file that imports the shim. If the rename is done without updating all imports, it's a build break.

### RE: Finding 9 — No test coverage for new React components or hooks
- **Verdict**: ✅ Agree
- **Confidence**: 95
- **Challenge**: 80 new components and 7 hooks with zero test coverage is a real gap. The `--passWithNoTests` CI config means this will never be caught automatically. The PR does include 2 utility test files (`sleep-stages.test.ts`, `sleepCurve/generate.test.ts`) which test the pure algorithmic functions, but the hooks and components that wire hardware mutations are untested. However, categorizing this as a blocker for a PR that adds browser UI parity (with hardware parity already working via the iOS app) is context-dependent. If this is a pre-release feature, the test debt is acceptable. If this is going to production, it's a Major.
- **Alternative**: Add integration tests for the 3 highest-risk hooks: `useSchedule` (bulk mutations), `useSensorStream` (WebSocket lifecycle), and `SideProvider` (state persistence). Component-level tests for pure display components can wait.
- **Risk if applied as-is**: None. More tests is always better.

### RE: Finding 10 — Dead code -- NetworkInfoCard never imported
- **Verdict**: ✅ Agree
- **Confidence**: 90
- **Challenge**: `NetworkInfoCard.tsx` exists and is never imported. The Status screen's `SystemInfoCard` already shows WiFi and internet status. This is likely an abandoned prototype. Keeping dead code adds maintenance burden.
- **Alternative**: None needed.
- **Risk if applied as-is**: None.

### RE: Finding 11 — Duplicate client-side sleep stage classification
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 75
- **Challenge**: The finding is valid -- week view fetches raw vitals/movement and runs `classifySleepStages` in the browser. But the "suggested fix" of calling `biometrics.getSleepStages` per night would issue 7 sequential tRPC calls (one per night) vs the current 3 calls (sleep records, vitals, movement). The current approach is actually _fewer_ network round trips. The real issue is computation cost: running classification on 7 x ~288 vitals rows (~2000 records) in the browser. On modern devices this takes <50ms (it's just array iteration with simple arithmetic). The batch endpoint suggestion is the right long-term fix but is scope creep for this PR.
- **Alternative**: Keep the current client-side approach for now. Add a `TODO` comment noting the server-side batch endpoint would be more efficient. The performance penalty is negligible at this data scale.
- **Risk if applied as-is**: Switching to 7 individual `getSleepStages` calls would increase network round trips from 3 to 7+. With no batch endpoint, the suggested fix is worse than the current approach for week view.

### RE: Finding 12 — Stale date range memoization in EnvironmentPanel
- **Verdict**: ⚠️ Disagree
- **Confidence**: 80
- **Challenge**: The `useMemo` wrapping `getDateRangeFromTimeRange(timeRange)` with `[timeRange]` dependency is _intentional_, not a bug. `getDateRangeFromTimeRange` computes `new Date()` as the end date and subtracts `hours` for the start date. The date becomes "stale" relative to wall clock time, but the `refetchInterval: 60_000` on the query triggers a refetch every 60 seconds. Each refetch sends the _same_ date range to the server, but the server query uses `gte(timestamp, startDate)` which will include new data that appeared since the last fetch. The staleness only matters if the user stays on the page for >1 hour without changing the time range selector -- in which case the "6 hours ago" start drifts by at most the session duration, but the data still updates.

  Removing the `useMemo` would cause `dateRange` to be a _new object reference on every render_, which would trigger infinite re-renders of the child queries (since `dateRange.startDate` would be a new `Date` object each time, even with the same logical value). The `useMemo` is correct here.
- **Alternative**: No change needed. If the drift bothers someone, add a 5-minute `setInterval` that bumps a counter dependency, but this is over-engineering for a sensor dashboard.
- **Risk if applied as-is**: Removing `useMemo` would cause infinite query re-fetching because `new Date()` creates a new reference on every render, which changes the query key, which triggers a refetch, which causes a re-render. This would be a regression.

### RE: Finding 13 — Static SVG gradient ID collision risk
- **Verdict**: ✅ Agree
- **Confidence**: 85
- **Challenge**: Valid. Hardcoded `id="humidityGradient"` in HumidityChart will collide if the component is rendered multiple times on the same page. The `EnvironmentPanel` currently renders one `HumidityChart`, but the `DataPage` can render it in dual-side mode which may produce two instances. `useId()` is the correct fix.
- **Alternative**: None needed.
- **Risk if applied as-is**: None.

### RE: Finding 14 — Stale closure risk in `handleDialChange`
- **Verdict**: ✅ Agree
- **Confidence**: 70
- **Challenge**: Valid but the actual risk window is tiny. `handleDialChange` captures `activeSides` in its closure. If the user is dragging the temperature dial and simultaneously someone clicks the side selector to change from "left" to "right", the 300ms debounce could fire `setTempMutation.mutate` for the old side. However, the chance of this happening is extremely low -- you can't drag a dial and click a button simultaneously on touch devices (single-finger). On desktop with mouse, it's possible but unlikely. Still, the ref pattern is cheap and correct.
- **Alternative**: Use `activeSidesRef = useRef(activeSides)` and read `activeSidesRef.current` inside the debounce callback.
- **Risk if applied as-is**: None.

### RE: Finding 15 — `useEffect` dependency on optional-chained values
- **Verdict**: ✅ Agree
- **Confidence**: 75
- **Challenge**: Valid. `useEffect` with deps `[schedule?.vibrationIntensity, schedule?.alarmTemperature]` won't re-fire when the schedule _object_ changes (e.g., switching days) if the numeric values happen to be the same. Adding `schedule?.id` to the deps array is the correct fix.
- **Alternative**: None needed.
- **Risk if applied as-is**: None.

### RE: Finding 16 — `DataPage` inline type may drift from tRPC output
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 60
- **Challenge**: The `SleepRecordRow` interface in `data/page.tsx` manually defines fields that should match the tRPC output. However, getting the exact tRPC inferred output type is non-trivial -- you need `RouterOutputs['biometrics']['getSleepRecords']` which requires importing from the tRPC router definition chain. Given that the biometrics router uses `z.any()` output (Finding 5), the inferred type is actually `any` -- so using the tRPC inferred type wouldn't help at all until Finding 5 is fixed.
- **Alternative**: Fix Finding 5 first (proper Zod output schemas), then this issue resolves itself.
- **Risk if applied as-is**: Attempting to use tRPC inferred types when the output schema is `z.any()` would give `any`, which is worse than the manual interface.

### RE: Finding 17 — `PrimeCompleteNotification` dismiss only calls refetch
- **Verdict**: ✅ Agree
- **Confidence**: 80
- **Challenge**: Valid. The `onDismiss={refetch}` callback simply re-fetches device status. If the server still reports `primeCompletedNotification != null` after refetch, the notification will immediately reappear. The TempScreen JSDoc even lists `device.dismissPrimeNotification (mutation)` as a wired dependency, but it's never actually called. This is a functional bug.
- **Alternative**: Wire `dismissPrimeNotification.mutateAsync()` then `refetch()` in the dismiss handler.
- **Risk if applied as-is**: None.

### RE: Finding 18 — SideSelector click silently unlinks
- **Verdict**: ⚠️ Disagree
- **Confidence**: 75
- **Challenge**: The Optimizer says clicking a side button while linked "silently" sets `isLinked = false`. Looking at the code in `SideProvider.tsx:85-90`, `selectSide` only unlinks when `side !== 'both'`. The `SideSelector` component passes `onSelect={() => selectSide('left')}` and `onSelect={() => selectSide('right')}`. So clicking a specific side while linked does unlink -- but this is _the expected behavior_. In the iOS app, tapping a specific side when linked also exits linked mode (it means "I want to control this side independently"). The visual feedback is also present: the unified highlight disappears and individual highlight appears. This matches the standard iOS toggle pattern (similar to AirPods L/R/Both selection in Settings). The "guard" suggestion would add friction to a standard interaction pattern.
- **Alternative**: No change needed. The behavior is correct and matches iOS.
- **Risk if applied as-is**: Adding a confirmation dialog before unlinking would make the side selector feel sluggish and break iOS parity.

### RE: Finding 19 — `user-scalable=no` accessibility concern
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 60
- **Challenge**: Valid WCAG concern, but this is a deliberate choice for a kiosk-like hardware control app running on a bedside device. The `user-scalable=no` prevents accidental zoom during dial interaction (the TemperatureDial uses pointer events that would conflict with pinch-zoom). The `maximum-scale=1` prevents iOS Safari's auto-zoom on input focus. These are standard practices for full-screen interactive web apps. However, removing `user-scalable=no` while keeping `maximum-scale=1` would satisfy WCAG while still preventing the auto-zoom issue.
- **Alternative**: Remove only `user-scalable=no`, keep `maximum-scale=1`. This allows manual zoom while preventing auto-zoom.
- **Risk if applied as-is**: Removing both could cause the temperature dial to zoom unexpectedly during drag interactions on iOS Safari, degrading UX for the primary use case.

### RE: Finding 20 — SleepRecordActions no client-side validation
- **Verdict**: ✅ Agree
- **Confidence**: 85
- **Challenge**: Valid. The edit form uses native `<input type="datetime-local">` with no validation. Users can set wake time before bed time and submit. The server may or may not reject this (depends on the Zod schema in the update mutation). Adding `disabled={new Date(editWakeTime) <= new Date(editBedTime)}` on the save button is trivial.
- **Alternative**: None needed.
- **Risk if applied as-is**: None.

### RE: Finding 21 — `formatRelativeTime` returns "past" for stale jobs
- **Verdict**: ✅ Agree
- **Confidence**: 80
- **Challenge**: Valid nit. Returning "past" is technically correct but not user-friendly. "Overdue" would be clearer. Very low impact.
- **Alternative**: None needed.
- **Risk if applied as-is**: None.

### RE: Finding 22 — 6 tabs vs 5 screens in PR description
- **Verdict**: ✅ Agree
- **Confidence**: 95
- **Challenge**: Valid. BottomNav has 6 tabs (Temp, Schedule, Data, Sensors, Status, Settings). PR title says "5 screens." Trivial documentation fix.
- **Alternative**: None needed.
- **Risk if applied as-is**: None.

### RE: Finding 23 — `Link` icon shadows Next.js `Link`
- **Verdict**: ⚠️ Disagree
- **Confidence**: 70
- **Challenge**: `SideSelector.tsx` imports `Link` from lucide-react but never imports Next.js `Link`. The file has no `<a>` or routing elements -- it's a pure button component. There's no actual shadowing because Next.js `Link` is not imported. The _potential_ for confusion exists if someone later adds routing to this component, but that's speculative. The Optimizer's concern is about a hypothetical, not an actual bug.

  Looking at the actual import line: `import { Link, LinkIcon, Power, TrendingDown, TrendingUp } from 'lucide-react'`. Both `Link` and `LinkIcon` are imported. `Link` is used for the linked state, `LinkIcon` for the unlinked state. This is intentional -- lucide provides both icons. There's no Next.js `Link` import in this file.
- **Risk if applied as-is**: Renaming `Link` to `ChainLinkIcon` would require a custom alias that doesn't exist in lucide-react. The suggestion is incorrect -- `ChainLinkIcon` is not a lucide export.

### RE: Finding 24 — TempTrendChart date bounds frozen at mount
- **Verdict**: ✅ Agree
- **Confidence**: 85
- **Challenge**: Valid nit. The `oneHourAgo` and `now` variables are computed once at render time and used as query parameters. The `refetchInterval` will re-send the same stale date bounds. This is acceptable for a 1-hour window (the drift is bounded by how long the user stays on the sensors page), but a comment explaining this would help.
- **Alternative**: None needed beyond the suggested comment.
- **Risk if applied as-is**: None.

### RE: Finding 25 — PullToRefresh missing `data-scroll-container`
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 75
- **Challenge**: Valid. The `usePullToRefresh` hook looks for `[data-scroll-container]` ancestor to check scroll position, but no component in the PR sets this attribute. However, the fallback `?? document.documentElement` makes this a non-issue _functionally_ -- pull-to-refresh will work correctly because it falls back to checking `document.documentElement.scrollTop`. The `data-scroll-container` is there for future use if the app moves to a scrollable container other than `<html>`.
- **Alternative**: Add a comment in `usePullToRefresh.ts` explaining the fallback behavior. Don't add `data-scroll-container` to the layout unless you actually need a custom scroll container.
- **Risk if applied as-is**: Adding `data-scroll-container` to a wrapper div that doesn't have `overflow: auto/scroll` would cause the `scrollTop` check to read 0 always, making pull-to-refresh activate at any scroll position.

### RE: Finding 26 — useSensorStream non-obvious dependency management
- **Verdict**: ✅ Agree
- **Confidence**: 80
- **Challenge**: Valid nit. The `sensorsKey` derived string is used as a `useEffect` dependency instead of the `sensors` array to avoid the standard React problem where `['a', 'b']` !== `['a', 'b']` as dependency. This is a well-known React pattern and the code is correct. The suggestion to add an `eslint-disable` comment with explanation is appropriate.
- **Alternative**: None needed.
- **Risk if applied as-is**: None.

---

## Missed Issues

### Missed Issue 1: Module-level singleton state in useSensorStream leaks across HMR
- **File**: `src/hooks/useSensorStream.ts:262-274`
- **Severity**: 🟡 Major
- **Category**: Race Condition
- **Problem**: The WebSocket connection state (`ws`, `heartbeatInterval`, `reconnectTimeout`, `activeRefCount`, `state`, `fpsTimestamps`, etc.) is stored in module-level variables. During Next.js development with Fast Refresh / HMR, the module is re-evaluated but the old WebSocket connection and timers are never cleaned up. This creates orphaned connections, duplicate heartbeat intervals, and `activeRefCount` desync. The `fpsTimestamps` array and `frameCallbacks` Set grow unbounded across hot reloads. Production is fine (modules load once), but development experience will degrade with "phantom" WebSocket connections.
- **Suggested fix**: Wrap the singleton in a `globalThis` pattern: `const state = globalThis.__sensorStream ??= { ... }`. Or move the singleton to a React context with proper cleanup, though that sacrifices the cross-component sharing benefit.

### Missed Issue 2: TemperatureDial has no keyboard accessibility
- **File**: `src/components/TemperatureDial/TemperatureDial.tsx`
- **Severity**: 🟡 Major
- **Category**: Accessibility
- **Problem**: The temperature dial is an SVG element with pointer event handlers but no keyboard interaction support. It cannot be focused via Tab, and there's no way to adjust temperature via keyboard (arrow keys). The `+` and `-` buttons below provide keyboard-accessible alternatives, but the dial itself is the primary interaction element and should have `role="slider"`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-label`, `tabIndex={0}`, and keyboard event handlers for arrow keys.
- **Suggested fix**: Add `role="slider"` with ARIA attributes to the SVG, add `tabIndex={0}`, and handle `onKeyDown` for ArrowUp/ArrowDown to adjust temperature in 1-degree increments.

### Missed Issue 3: `useSchedule` and `useSchedules` are confusingly similar hooks with overlapping responsibilities
- **File**: `src/hooks/useSchedule.ts`, `src/hooks/useSchedules.ts`
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: Two hooks with nearly identical names serve different purposes. `useSchedule` (singular) handles bulk operations, multi-day selection, and power/alarm toggle. `useSchedules` (plural) handles optimistic CRUD for temperature set points. Both import from the same tRPC endpoints. Both define `TemperatureSchedule` interfaces (with slightly different fields -- `useSchedules` includes `createdAt`/`updatedAt`, `useSchedule` does not). The naming convention suggests `useSchedules` returns multiple schedules and `useSchedule` returns one, but both return arrays.
- **Suggested fix**: Rename `useSchedules` to `useTemperatureSetPoints` (which is what it actually manages) and `useSchedule` to `useScheduleManager` (which manages bulk operations). Consolidate the `TemperatureSchedule` type into a shared types file.

### Missed Issue 4: `applyToOtherDays` reads stale `allSchedulesQuery.data` for deletion
- **File**: `src/hooks/useSchedule.ts:730-768`
- **Severity**: 🟡 Major
- **Category**: Race Condition
- **Problem**: `applyToOtherDays` reads `allSchedulesQuery.data` (cached at callback creation time) to find existing schedules to delete for each target day. But inside the loop, previous iterations have already deleted and created schedules, making the cached data stale. If Day 1's deletion succeeds but the data for Day 2 references IDs that were just created during Day 1's recreation step, those IDs won't exist in the cache. This is partially mitigated because Day 1 and Day 2 schedules have different `dayOfWeek` values so they filter independently, but the `allSchedulesQuery.data` reference itself could be stale if background refetching occurs mid-loop.
- **Suggested fix**: Fetch fresh data inside the loop: `const freshData = await utils.schedules.getAll.fetch({ side })` at the start of each day's iteration. Or better: refactor to use `utils.schedules.getByDay.fetch({ side, dayOfWeek: targetDay })` per day to get fresh data.

### Missed Issue 5: Inconsistent className utility -- `cn()` vs `clsx()` used interchangeably
- **File**: Multiple files
- **Severity**: ⚪ Nit
- **Category**: Consistency
- **Problem**: The codebase uses both `cn()` (from `@/lib/utils`, which wraps `clsx` + `twMerge`) and raw `clsx()` across different components. `cn()` handles Tailwind class conflicts (e.g., `cn('p-2', 'p-4')` resolves to `p-4`). `clsx()` just concatenates. Some new components use `clsx` where `cn` would be more correct (e.g., `SideSelector.tsx` passes conditional Tailwind classes that could conflict). This inconsistency could lead to subtle styling bugs when classes overlap.
- **Suggested fix**: Standardize on `cn()` for all Tailwind className construction. Use `clsx()` only for non-Tailwind classnames (CSS modules).

### Missed Issue 6: `usePullToRefresh` has stale closure in `onTouchEnd`
- **File**: `src/hooks/usePullToRefresh.ts:89-110`
- **Severity**: 🟢 Minor
- **Category**: Race Condition
- **Problem**: `onTouchEnd` is a `useCallback` with deps `[state.isPastThreshold, state.isRefreshing, onRefresh]`. The `state` is read from React state, but `isPullingRef` and `startYRef` are refs. If `isPastThreshold` changes during the touch gesture (e.g., a rapid pull-release), the callback might see a stale `state.isPastThreshold` value. More critically, the `onTouchMove` callback also reads `state.isRefreshing` which changes _after_ `onTouchEnd` triggers the refresh. During the refresh, if the user touches the screen, `onTouchMove` would check `state.isRefreshing` from the previous render, not the current one.
- **Suggested fix**: Use refs for `isPastThreshold` and `isRefreshing` alongside the state, similar to `isPullingRef`.

### Missed Issue 7: `handleDialCommit` can send duplicate mutations
- **File**: `src/components/TempScreen/TempScreen.tsx:105-114`
- **Severity**: 🟢 Minor
- **Category**: Edge Case
- **Problem**: `handleDialCommit` clears the debounce timer and then fires `setTempMutation.mutate()` for each active side. But if the debounce timer had already fired (e.g., the user held position for >300ms before releasing), the mutation was already sent. The commit then sends a duplicate mutation with the same temperature. This is idempotent (setting the same temperature twice has no effect), but it doubles the hardware command traffic and triggers two `onSettled` callbacks, each calling `setLocalTarget(null)` and `refetch()`.
- **Suggested fix**: Track whether the debounce has already fired (e.g., a ref flag) and skip the commit mutation if the debounce already executed with the same value.

### Missed Issue 8: SideProvider hydration flash -- initial state is always 'left'
- **File**: `src/providers/SideProvider.tsx:37`
- **Severity**: 🟢 Minor
- **Category**: UX
- **Problem**: `SideProvider` initializes `selectedSide` to `'left'` and only hydrates from localStorage/cookie in a `useEffect`. During SSR and the first client render, the UI always shows "left" selected. If the user's persisted preference is "right" or "both", there's a visual flash as the side switches after hydration. This is a standard Next.js hydration mismatch issue.
- **Suggested fix**: Use `useSyncExternalStore` with server/client snapshots, or add a `hydrated` guard that renders a skeleton/placeholder until hydration completes. The `hydrated` state already exists in the component but isn't used to suppress rendering.

### Missed Issue 9: `formatDurationHM` returns unexpected values for negative input
- **File**: `src/lib/sleep-stages.ts:159-166`
- **Severity**: ⚪ Nit
- **Category**: Edge Case
- **Problem**: `formatDurationHM` uses `Math.round(ms / 60_000)` which produces negative values for negative ms input. `Math.floor(totalMinutes / 60)` with a negative totalMinutes produces unexpected results (e.g., `-60000` ms rounds to `-1` minutes, `Math.floor(-1 / 60) = -1` hours, `-1 % 60 = -1` minutes, producing `-1h -1m`). While negative input shouldn't occur in normal usage, the function has no guard.
- **Suggested fix**: Clamp to 0: `const totalMinutes = Math.max(0, Math.round(ms / 60_000))`.

---

## Statistics
- Optimizer findings challenged: 5 (Findings 1, 12, 18, 19, 23)
- Findings agreed with: 14 (Findings 2, 5, 7, 9, 10, 13, 14, 15, 17, 20, 21, 22, 24, 26)
- Findings agreed with modifications: 7 (Findings 3, 4, 6, 8, 11, 16, 25)
- New issues found: 9
