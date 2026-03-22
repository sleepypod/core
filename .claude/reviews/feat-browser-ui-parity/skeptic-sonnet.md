# Skeptic Challenge Report (Sonnet) — feat/browser-ui-parity

## Challenges to Optimizer Findings

### RE: Finding 1 — Seven barrel export files violate project convention
- **Verdict**: ✅ Agree
- **Confidence**: 95
- **Challenge**: None. The import-patterns.md document is unambiguous. Seven new `index.ts` barrel files directly contradict the documented convention. Two of them (`SleepStages/index.ts`, `Environment/index.ts`) are actively consumed by `data/page.tsx` (e.g., `import { SleepStagesCard } from '@/src/components/SleepStages'`).
- **Alternative**: N/A — the fix is straightforward: delete barrel files, update imports to direct paths.
- **Risk if applied as-is**: None. This is a correct finding.

---

### RE: Finding 2 — Duplicate SideSelector rendered on Temp screen
- **Verdict**: ✅ Agree
- **Confidence**: 98
- **Challenge**: Confirmed by inspection. `app/[lang]/layout.tsx:46` renders `<SideSelector />` globally for every page. `src/components/TempScreen/TempScreen.tsx:161` also renders `<SideSelector />`. On the Temp screen (`/`), which is the root page, users see two stacked selectors. This is unambiguous duplication.
- **Alternative**: Remove the `<SideSelector />` from `TempScreen.tsx`. The TempScreen JSDoc comment even documents it as a layout element ("4. SideSelector (left/right buttons with temp display)") suggesting it was originally intended to live at the layout level.
- **Risk if applied as-is**: None.

---

### RE: Finding 3 — Debounce/setTimeout timers not cleaned up on unmount
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 75
- **Challenge**: The Optimizer's characterization is partially accurate but overstates the scope. The `setConfirmMessage` timers in `useSchedule.ts` (lines 168, 224, 325, 329) are a genuine leak — bare `setTimeout(() => setConfirmMessage(null), 3000)` calls with no cleanup. However, the debounce refs in `AlarmScheduleSection.tsx` (`intensityCommitRef`, `alarmTempCommitRef`) and `PowerScheduleSection.tsx` (`tempCommitRef`) already call `clearTimeout` inline on `onChange` and `onPointerUp` — they're correctly cleared during normal usage. The omission of `useEffect(() => () => clearTimeout(ref.current), [])` is a real gap only for the navigation-during-drag case.

  The `TempScreen.tsx` `debounceRef` is the clearest unmount leak: no `useEffect`, no cleanup at all. Navigation during a 300ms dial drag will fire `setTempMutation.mutate()` against unmounted state.

  The `UpdateCard.tsx` polling loop (not flagged by either optimizer) is a worse version of this: recursive `setTimeout` calls during the reconnection poll with no cancellation mechanism — if the component unmounts mid-poll, the orphaned timers continue firing `version.refetch()` indefinitely.
- **Alternative**: Add cleanup effects to TempScreen and useSchedule. UpdateCard needs a `useRef<ReturnType<typeof setTimeout>>` and cleanup.
- **Risk if applied as-is**: The fix as described is correct. No regression risk.

---

### RE: Finding 4 — Pervasive `any` types in schedule/biometrics code
- **Verdict**: ✅ Agree
- **Confidence**: 85
- **Challenge**: The `any` typing in `ScheduleData.power` and `.alarm` in `useSchedules.ts` (lines 21-22) is a real problem — the hook already defines `PowerSchedule` and `AlarmSchedule` interfaces in `useSchedule.ts`, but `useSchedules.ts` doesn't import them. The `ScheduleOverview.tsx` pattern `(ps: any) =>` and `{ schedule: any }` typed card components are unambiguously wrong when types exist.

  The severity disagreement (Opus: Major, Sonnet-prior: Minor) is worth examining. For hardware control code where the wrong type would silently pass bad data to mutations, Major is more appropriate.
- **Alternative**: N/A — the fix is correct.
- **Risk if applied as-is**: None.

---

### RE: Finding 5 — `getSleepStages` endpoint uses `z.any()` output schema
- **Verdict**: ✅ Agree
- **Confidence**: 80
- **Challenge**: The finding is valid but slightly overstated. The full biometrics router has a mix — `z.any()` on 6 procedures (including `getSleepStages`), but 4 others use typed schemas (e.g., line 419: `z.object({ written: z.number() })`). So not all 9 procedures use `z.any()` as the prior Sonnet report claimed.

  The core issue is real: `SleepStagesResult` is a well-defined TypeScript interface in `src/lib/sleep-stages.ts` but has no corresponding Zod schema. `z.any()` bypasses runtime output validation, which is the primary tRPC safety guarantee.
- **Alternative**: Define a Zod schema for `SleepStagesResult`. Since it's a complex nested type, the pragmatic path is a Zod schema matching the existing TypeScript interface — or at minimum, `z.unknown()` which at least signals the intent.
- **Risk if applied as-is**: None.

---

### RE: Finding 6 — Serial mutations in bulk schedule operations
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 60
- **Challenge**: The finding correctly identifies serial `await mutateAsync` chains in `toggleAllSchedules` and `applyToOtherDays`. However, the suggested fix (`Promise.all` for mutations across independent days) is more complex to apply correctly than stated.

  The operations are NOT fully independent — within a single day, delete must complete before create. So `Promise.all` can only apply across days, not within a day. CurveEditor's `handleApply` actually already uses `Promise.all` for within-day deletes and creates — that pattern is correct.

  Also, the backend's `reloadScheduler()` call pattern matters: each mutation may trigger a scheduler reload. Parallelizing would cause concurrent scheduler reloads. The existing sequential approach avoids thrashing the scheduler.
- **Alternative**: Use `Promise.all` only across days (outer loop), keeping the within-day delete→create sequence. Batch the final `invalidateAll()` to one call after all days complete.
- **Risk if applied as-is**: Blindly applying `Promise.all` across all mutations in `applyToOtherDays` could result in creating records for a day before its deletions complete, leading to duplicate schedules.

---

### RE: Finding 7 — PowerButton fires concurrent mutations without coordination
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 70
- **Challenge**: The finding is real — firing `setPower.mutate()` twice in a loop (for linked mode) with no atomic guarantee is a split-failure risk. However, the severity (Major) is overstated for this app's context: this is a local home device, not safety-critical infrastructure. Split failure means one side toggles and the other doesn't — the user can see this immediately on the SideSelector and retry.

  The `TempScreen.tsx` power toggle has the same pattern but is not flagged separately by the Optimizer.

  Creating a server-side `setMultiSidePower` endpoint (the Optimizer's suggested fix) is an architectural change that touches the hardware client and router — significant effort for a local-only device with a small user base.
- **Alternative**: Use `Promise.all([mutateAsync, mutateAsync])` with a catch that shows a toast if one side fails. This is lower effort than a new endpoint and still provides coordinated error handling.
- **Risk if applied as-is**: The `Promise.all` + `mutateAsync` approach is safe. The new endpoint approach requires careful implementation to avoid introducing new bugs.

---

### RE: Finding 8 — Dual `useSide` exports create naming confusion
- **Verdict**: ⚠️ Disagree
- **Confidence**: 80
- **Challenge**: The Optimizer characterizes this as a naming hazard, but the design is intentional and documented. `src/hooks/useSide.ts` exports a "compatibility shim" (its own JSDoc says so explicitly) that provides a simpler `{ side, setSide, toggleSide }` interface for components that only need left/right selection. It has a different interface *by design* — components that don't need linked/both mode use the shim; components that do (like `SideSelector`, `TempScreen`) import from `SideProvider` directly.

  Renaming the shim to `useSimpleSide` would require touching ~15+ component files that import `useSide` from `./useSide`. The shim correctly delegates to `SideProvider`, so there's no state fragmentation.

  The real maintenance risk would be if both were in the same barrel index file — but since `import-patterns.md` bans barrel exports, consumers must explicitly choose their import path, which makes the distinction visible at the import line.
- **Alternative**: Adding a comment to both files cross-referencing each other is sufficient documentation.
- **Risk if applied as-is**: Renaming to `useSimpleSide` is a broad refactor that could introduce import errors during migration with zero functional benefit.

---

### RE: Finding 9 — No test coverage for new React components or hooks
- **Verdict**: ✅ Agree
- **Confidence**: 85
- **Challenge**: None. The absence of tests for ~80 new components controlling hardware state is a genuine gap. `--passWithNoTests` silently hides the problem. The priority order suggested (SideProvider, useSchedule, TemperatureDial, useSensorStream) is sensible.
- **Alternative**: N/A.
- **Risk if applied as-is**: None.

---

### RE: Finding 10 — Dead code — NetworkInfoCard never imported
- **Verdict**: ✅ Agree
- **Confidence**: 95
- **Challenge**: Confirmed by grep. `NetworkInfoCard` is only referenced within its own file. The `StatusScreen` already has `InternetToggleCard` which covers internet toggle, and `HealthStatusCard` covers WiFi. The functionality is genuinely redundant.
- **Alternative**: N/A.
- **Risk if applied as-is**: None. Safe to delete.

---

### RE: Finding 11 — Duplicate client-side sleep stage classification
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 65
- **Challenge**: The finding is architecturally valid — the week view in `SleepStagesCard.tsx` fetches raw vitals + movement for all 7 nights and runs `classifySleepStages` client-side, while the server exposes `biometrics.getSleepStages`. However, the optimization tradeoffs are more nuanced:

  1. The server's `getSleepStages` takes a date range, so calling it 7 times serially would be 7 HTTP round-trips vs 1 large query + 1 large query for the current implementation.
  2. The client-side classification avoids the server being a bottleneck.
  3. The data fetch is bounded: 1000 vitals rows across 7 nights is ~143 per night, reasonable for a local server.

  A batch `getSleepStagesForWeek` endpoint would be the cleanest fix, but it's new API surface. Calling `getSleepStages` per night from the client is simpler but creates 7 queries.
- **Alternative**: Add a `getSleepStagesForRange` endpoint that returns multiple nights at once, or live with the current approach given it's a local device.
- **Risk if applied as-is**: Switching to 7 × `getSleepStages` calls without a batch endpoint could be noticeably slower due to sequential query overhead.

---

### RE: Finding 12 — Stale date range memoization in EnvironmentPanel
- **Verdict**: ⚠️ Disagree
- **Confidence**: 75
- **Challenge**: The Optimizer claims "date range becomes stale after selection" but the actual behavior is more nuanced. `getDateRangeFromTimeRange` creates a date range relative to `new Date()` at the moment of the `useMemo` call, and `useMemo` recalculates on `[timeRange]` changes. So whenever the user selects a new time range, the dates are re-computed fresh.

  The staleness only manifests if the component stays mounted for a long time WITHOUT changing the time range selector. With a 60-second `refetchInterval`, the server returns the latest data but filtered by the original window. For a 6-hour window that drifts by a few minutes, this is cosmetically stale but functionally fine.

  The Optimizer's suggestion to "remove useMemo or recompute range in queryFn" is imprecise. "Recompute range in queryFn" isn't directly possible with tRPC's generated hooks since input is passed at hook call time, not inside queryFn.
- **Alternative**: The `refetchInterval: 60_000` already mitigates staleness adequately. The issue is real but severity (Minor) is appropriate.
- **Risk if applied as-is**: Removing `useMemo` entirely could cause date recomputation on every render, potentially causing infinite query refetch loops if date object reference equality is checked by React Query.

---

### RE: Finding 13 — Static SVG gradient ID collision risk
- **Verdict**: ✅ Agree
- **Confidence**: 85
- **Challenge**: None. Hardcoded `id="humidityGradient"` in `HumidityChart.tsx` will cause gradient rendering artifacts if multiple instances are rendered simultaneously. `useId()` is the correct React idiom and a 2-line fix.
- **Alternative**: N/A.
- **Risk if applied as-is**: None.

---

### RE: Finding 14 — Stale closure risk in `handleDialChange`
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 55
- **Challenge**: The stale closure concern is technically correct — `handleDialChange` captures `activeSides` at memoization time. If `activeSides` changes during a 300ms debounce, the fired mutation uses the old sides.

  However, `useCallback` with `[activeSides]` dep means `handleDialChange` IS recreated when `activeSides` changes — the staleness only exists within the 300ms debounce window. This requires the user to (1) start dragging the temperature dial, (2) simultaneously tap the SideSelector to change sides, all within 300ms on a touch screen. In practice this is nearly impossible as the dial takes full-screen focus.
- **Alternative**: A ref-based approach for `activeSides` would be belt-and-suspenders, but adds maintenance complexity for minimal real-world benefit.
- **Risk if applied as-is**: Low. The fix adds complexity. Not worth it.

---

### RE: Finding 15 — `useEffect` dependency on optional-chained values
- **Verdict**: ⚠️ Disagree
- **Confidence**: 70
- **Challenge**: The Optimizer claims that `useEffect` deps `[schedule?.vibrationIntensity, schedule?.alarmTemperature]` "miss identity changes when schedule object swaps but values match." This is partially true but the conclusion is wrong.

  The effect's purpose is to sync local slider state when the *server values* change. If the schedule object is replaced with a new one that has the same vibration intensity and alarm temperature, there is nothing to sync — the slider is already showing the correct values. Including `schedule?.id` would cause unnecessary re-syncs when navigating between days that happen to have different IDs but the same slider values, causing visual flicker.
- **Alternative**: The current behavior is defensible. Adding `schedule?.id` is safe but may cause occasional re-renders that flicker the slider back to server value during rapid switching.
- **Risk if applied as-is**: Adding `schedule?.id` is safe but may cause observable UI flicker.

---

### RE: Finding 16 — `DataPage` inline type may drift from tRPC output
- **Verdict**: ✅ Agree
- **Confidence**: 75
- **Challenge**: The manual `SleepRecordRow` interface in `data/page.tsx` with `as` cast is a type safety gap. tRPC infers the output type and it should be used.
- **Alternative**: N/A.
- **Risk if applied as-is**: None.

---

### RE: Finding 17 — `PrimeCompleteNotification` dismiss only calls refetch
- **Verdict**: ✅ Agree
- **Confidence**: 80
- **Challenge**: Confirmed. The dismiss button is `onDismiss={refetch}` — it only refetches status without calling `device.dismissPrimeNotification`. The mutation exists but isn't wired to the dismiss action.
- **Alternative**: N/A.
- **Risk if applied as-is**: None.

---

### RE: Finding 18 — SideSelector click silently unlinks
- **Verdict**: ⚠️ Disagree
- **Confidence**: 65
- **Challenge**: Tapping a specific side while linked silently breaks the link. The Optimizer flags this as a bug, but this IS the iOS app's behavior. The `SideProvider.selectSide` function makes this explicit in code comments: "If selecting a specific side while linked, unlink." The PR's explicit goal is iOS parity.

  Adding a confirmation guard would diverge from iOS parity and add friction to a common interaction pattern.
- **Alternative**: No change needed. Document the behavior in a comment if it's unclear to future contributors.
- **Risk if applied as-is**: Adding a guard would break iOS parity.

---

### RE: Finding 19 — `user-scalable=no` accessibility concern
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 60
- **Challenge**: WCAG 1.4.4 requires text to be resizable to 200% without assistive technology. `user-scalable=no` violates this. However, this is a deliberate choice for a mobile-first app mimicking native behavior — the viewport meta matches what the iOS app enforces. The project is a private LAN device, not a public-facing service.

  The severity (Nit) is appropriate. However, modern mobile browsers largely ignore `user-scalable=no` for accessibility reasons anyway, so the real-world impact is minimal.
- **Alternative**: Remove `user-scalable=no` but keep `maximum-scale=1` as a soft hint that browsers can override when users zoom.
- **Risk if applied as-is**: Removing `user-scalable=no` may cause layout shifts on some mobile browsers when zooming.

---

### RE: Finding 20 — SleepRecordActions no client-side validation
- **Verdict**: ✅ Agree
- **Confidence**: 80
- **Challenge**: The edit form allows `leftBedAt` (wake time) to be set before `enteredBedAt` (bed time), which would result in a negative `sleepDurationSeconds`. The mutation would succeed server-side unless the server validates this. The resulting corrupted sleep record would show negative durations in charts.
- **Alternative**: A simple guard `if (new Date(editWakeTime) <= new Date(editBedTime)) return` before mutation is sufficient.
- **Risk if applied as-is**: None.

---

### RE: Finding 21 — `formatRelativeTime` returns "past" for stale jobs
- **Verdict**: ✅ Agree
- **Confidence**: 70
- **Challenge**: None. Returning the string literal `"past"` for overdue jobs is poor UX. "overdue" or filtering out stale entries would be clearer. Trivial fix.
- **Alternative**: N/A.
- **Risk if applied as-is**: None.

---

### RE: Finding 22 — 6 tabs vs 5 screens in PR description
- **Verdict**: ⚠️ Disagree
- **Confidence**: 85
- **Challenge**: This is a discrepancy in the PR description, not a code issue. The BottomNav has 6 tabs which is correct. Listing this as a code finding is misleading — it has zero impact on functionality. PR description cleanup should not be elevated to a code review finding.
- **Alternative**: N/A. Not a code issue.
- **Risk if applied as-is**: None.

---

### RE: Finding 23 — `Link` icon shadows Next.js `Link`
- **Verdict**: ⚠️ Disagree
- **Confidence**: 99
- **Challenge**: This is a **false positive**. `src/components/SideSelector/SideSelector.tsx` does NOT import Next.js `Link`. Its imports are exclusively `{ Link, LinkIcon, Power, TrendingDown, TrendingUp }` from `'lucide-react'`. There is no shadowing — `Link` is used as a lucide icon in JSX (`<Link size={16} strokeWidth={2.5} />`). Next.js `Link` is not needed in this file since navigation is handled at `BottomNav` and `SwipeContainer` levels.
- **Alternative**: No change needed. This finding should be withdrawn.
- **Risk if applied as-is**: Renaming to `ChainLinkIcon` would break the import since lucide exports this icon as `Link`, not `ChainLinkIcon`.

---

### RE: Finding 24 — TempTrendChart date bounds frozen at mount
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 70
- **Challenge**: The dates are intentionally frozen. The historical query opts out of re-fetching entirely (`refetchOnWindowFocus: false`, `refetchOnMount: false`, `refetchOnReconnect: false`) — it seeds the chart once, then live frames append via `useOnSensorFrame`. The frozen window is by design for this use case.

  The one real issue: if the Sensors page is left open for >1 hour, new cold loads won't re-seed because `seededRef` prevents it. But since `seededRef` only blocks re-seeding when data arrives, a tab refresh would fix this.
- **Alternative**: A comment clarifying the intentional freeze resolves the confusion without code changes — which is what the Optimizer's "Nit" actually suggests.
- **Risk if applied as-is**: None. The Optimizer's suggested fix (comment) is appropriate.

---

### RE: Finding 25 — PullToRefresh missing `data-scroll-container`
- **Verdict**: ✅ Agree
- **Confidence**: 90
- **Challenge**: Confirmed by grep. `usePullToRefresh` queries `container?.closest('[data-scroll-container]') ?? document.documentElement`. The attribute is never set anywhere in the codebase. The fallback to `document.documentElement` means scroll position detection depends on the global scroll container, which may work correctly in the current layout but will fail if the layout is ever wrapped in a scrollable div rather than using body scroll.
- **Alternative**: Add `data-scroll-container` to the wrapper div in `PullToRefresh.tsx`, or remove the attribute-based lookup and always use `document.documentElement`.
- **Risk if applied as-is**: None.

---

### RE: Finding 26 — useSensorStream non-obvious dependency management
- **Verdict**: 🔄 Agree with modifications
- **Confidence**: 65
- **Challenge**: The `sensorsKey` pattern (sorting and joining sensor types to a string as a useEffect dependency proxy) is non-obvious but is a well-established React pattern for array dependencies. The standard `JSON.stringify(sensors)` alternative has identical semantics but equally non-obvious.

  The Optimizer suggests adding an eslint-disable comment with explanation. This is correct — the current code has no comment explaining why `sensorsKey` is used instead of `sensors` directly, which could confuse future maintainers into "fixing" it by replacing `sensorsKey` with `sensors`, causing the effect to re-run on every render due to array reference instability.
- **Alternative**: The comment approach is the right fix. An alternative of `useRef` + deep comparison adds complexity without benefit.
- **Risk if applied as-is**: Adding the comment is zero risk.

---

## Missed Issues

### Missed Issue 1: UpdateCard recursive setTimeout has no cleanup on unmount
- **File**: `/Users/ng/Documents/GitHub/sleepypod/sleepypod-core/src/components/status/UpdateCard.tsx:73,83`
- **Severity**: 🟡 Major
- **Category**: Race Condition
- **Problem**: `pollForReconnection()` uses recursive `setTimeout(check, 2000)` with up to 60 iterations (~2 minutes). There is no cancellation mechanism. If the user navigates away from the Status screen during update polling, the orphaned timeouts continue calling `version.refetch()` for up to 2 minutes on an unmounted component. The initial 5-second delay `setTimeout(check, 5000)` also has no cleanup. This is more severe than the debounce timer issues in Finding 3, which the Optimizer rated Major.
- **Suggested fix**: Track the active timer with a `useRef<ReturnType<typeof setTimeout>>` and add a `useRef<boolean>` cancellation flag. In a `useEffect` cleanup: set the flag to true and call `clearTimeout`. Check the flag at the start of each `check` call before calling `refetch` or scheduling the next timer.

### Missed Issue 2: SideProvider renders children with wrong default state during hydration
- **File**: `/Users/ng/Documents/GitHub/sleepypod/sleepypod-core/src/providers/SideProvider.tsx:49-96`
- **Severity**: 🟢 Minor
- **Category**: UX
- **Problem**: `SideProvider` initializes with `selectedSide = 'left'` and hydrates from localStorage in a `useEffect`. During the SSR→client hydration window, all components consuming `useSide()` render with `selectedSide = 'left'` regardless of the stored preference. If the user persisted `selectedSide = 'right'`, there will be a visible flash where the layout renders with left-side data before snapping to right-side data. The `hydrated` flag gates persistence writes but not rendering.
- **Suggested fix**: While `!hydrated`, render a skeleton or suppress display of side-dependent UI. Alternatively, read the `sleepypod-side` cookie server-side in the layout component and pass the initial value as a prop to `SideProvider`.

### Missed Issue 3: `useOnSensorFrame` does not manage WebSocket connection ref count
- **File**: `/Users/ng/Documents/GitHub/sleepypod/sleepypod-core/src/hooks/useSensorStream.ts:521-529`
- **Severity**: 🟢 Minor
- **Category**: Blast Radius
- **Problem**: `useOnSensorFrame` registers a frame callback but does not call `connect()` or increment `activeRefCount`. It assumes the WebSocket is already connected by a concurrent `useSensorStream` call. If a future component uses only `useOnSensorFrame` without a parent `useSensorStream`, it will silently receive no frames with no error. Currently safe because `SensorsScreen` always holds the connection, but this is an undocumented fragile assumption.
- **Suggested fix**: Add a JSDoc warning to `useOnSensorFrame`: "Requires that at least one `useSensorStream` hook is mounted in the same component tree to establish the WebSocket connection." Or add a development-mode assertion: `if (process.env.NODE_ENV === 'development' && activeRefCount === 0) console.warn(...)`.

### Missed Issue 4: InternetToggleCard has no confirmation before blocking internet access
- **File**: `/Users/ng/Documents/GitHub/sleepypod/sleepypod-core/src/components/status/InternetToggleCard.tsx:32-36`
- **Severity**: 🟢 Minor
- **Category**: UX
- **Problem**: Toggling internet access (`system.setInternetAccess`) fires directly on button click with no confirmation dialog. This is an iptables-level operation that blocks/unblocks external network access. An accidental tap blocks internet access immediately. Compare with `WaterLevelCard` which correctly shows a two-step confirmation for priming, and `UpdateCard` which uses an `'idle' | 'confirming'` state machine for the update action. The internet toggle should follow the same pattern given its system impact.
- **Suggested fix**: Add a two-step confirm pattern matching `WaterLevelCard`: first click shows an inline "Confirm: Block internet access?" with confirm/cancel buttons before executing the mutation.

### Missed Issue 5: `applyToOtherDays` leaves database in inconsistent state on partial failure
- **File**: `/Users/ng/Documents/GitHub/sleepypod/sleepypod-core/src/hooks/useSchedule.ts:244-335`
- **Severity**: 🟢 Minor
- **Category**: Edge Case
- **Problem**: `applyToOtherDays` has a `try/catch` but if a delete or create mutation fails partway through (e.g., during the 3rd target day), the function has already deleted schedules for days 1 and 2 and may have partially created new ones. The database is left in an inconsistent state — some target days have the source schedule, others have their original schedules deleted with no replacement. No rollback mechanism exists.
- **Suggested fix**: Collect per-day success/failure, report partial failures to the user. Or add a server-side `copyScheduleToDay` procedure that handles delete+create within a database transaction.

### Missed Issue 6: Swipe navigation intercepts horizontal scroll in sub-components
- **File**: `/Users/ng/Documents/GitHub/sleepypod/sleepypod-core/src/hooks/useSwipeNavigation.ts:79-99`
- **Severity**: 🟢 Minor
- **Category**: UX
- **Problem**: `useSwipeNavigation` wraps the entire `SwipeContainer` and intercepts horizontal swipes. The Data page contains horizontally scrollable components (pill selector rows, `WeekNavigator`). A horizontal swipe that starts on one of these components will be consumed by `useSwipeNavigation` before the child's scroll handler can process it. `VERTICAL_LIMIT = 80` prevents vertical scrolling from triggering navigation but does not protect horizontal sub-component scrolling.
- **Suggested fix**: In `onTouchEnd`, check `e.target` and skip navigation if the touch target is inside an element with `overflow-x: scroll` or `overflow-x: auto`. Or add a `data-no-swipe` attribute to horizontal scroll containers and check for its presence in the touch handler.

### Missed Issue 7: `SleepRecordActions` displays stale error when switching between actions
- **File**: `/Users/ng/Documents/GitHub/sleepypod/sleepypod-core/src/components/biometrics/SleepRecordActions.tsx:147`
- **Severity**: ⚪ Nit
- **Category**: UX
- **Problem**: The error display uses `updateMutation.error?.message ?? deleteMutation.error?.message`. If a delete attempt fails after a previous update also failed, the update error is displayed (the `??` short-circuits on the update error). Both errors should be shown, or stale mutation errors should be cleared before each new operation.
- **Suggested fix**: Call `updateMutation.reset()` / `deleteMutation.reset()` before starting each operation. Or display errors separately per action type.

### Missed Issue 8: `scheduleTemps` object keys may collide on identical time strings in CurveEditor
- **File**: `/Users/ng/Documents/GitHub/sleepypod/sleepypod-core/src/components/Schedule/CurveEditor.tsx:138` (via `curveToScheduleTemperatures`)
- **Severity**: ⚪ Nit
- **Category**: Edge Case
- **Problem**: `curveToScheduleTemperatures` returns an object keyed by `HH:MM` time strings. If `generateSleepCurve` produces two curve points that round to the same minute, the latter silently overwrites the former in the object. This means the resulting temperature schedule may have fewer entries than the curve intended, creating a gap in the temperature curve without any error or warning.
- **Suggested fix**: Use an array of `{ time, temperature }` tuples instead of an object, and deduplicate explicitly (keeping last value per time slot), or add a development assertion that logs if collisions occur.

---

## Statistics
- Optimizer findings challenged: 7 (Findings 8, 12, 14, 15, 18, 22, 23 — partial or full disagreement)
- Findings agreed with: 14
- Findings agreed with modifications: 5 (Findings 3, 6, 7, 11, 26)
- Findings that are false positives: 2 (Finding 23 confirmed false; Finding 22 is not a code issue)
- New issues found: 8
