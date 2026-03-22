# Optimizer Merged Findings — feat/browser-ui-parity

## Summary
This PR adds a full browser UI matching the iOS app across 5+ screens (Temp, Schedule, Data/Biometrics, Sensors, Status/Settings). It introduces ~80 new components, ~7 hooks, a SideProvider context, WebSocket-based live sensor streaming, a server-side sleep stage classifier, and temperature curve generator. 122 files changed, +18,353/-806 lines.

Overall code quality is solid — well-structured components, thorough tRPC wiring, consistent accessibility patterns. Key concerns: barrel export convention violations, timer/cleanup correctness issues, type safety gaps, and missing test coverage.

## Cross-Model Agreement Key
- **[BOTH]** = Flagged by both Sonnet and Opus (high confidence)
- **[Opus only]** = Flagged by Opus only
- **[Sonnet only]** = Flagged by Sonnet only

---

## Findings

### Finding 1: Seven barrel export files violate project convention [BOTH]
- **Files**: `src/components/DualSideChart/index.ts`, `src/components/Environment/index.ts`, `src/components/Schedule/index.ts`, `src/components/Sensors/index.ts`, `src/components/SleepStages/index.ts`, `src/components/biometrics/index.ts`, `src/lib/sleepCurve/index.ts`
- **Severity**: 🟡 Major
- **Category**: Pattern
- **Problem**: `.claude/docs/import-patterns.md` explicitly bans barrel exports. This PR creates 7 new `index.ts` barrel re-export files. Two are actively consumed by `data/page.tsx`.
- **Suggested fix**: Delete all 7 `index.ts` files. Update consuming imports to reference source files directly (e.g., `@/src/components/SleepStages/SleepStagesCard`).
- **Rationale**: Direct violation of documented project convention.

### Finding 2: Duplicate SideSelector rendered on Temp screen [BOTH]
- **File**: `app/[lang]/layout.tsx:46` + `src/components/TempScreen/TempScreen.tsx:161`
- **Severity**: 🟡 Major (Sonnet Major, Opus Minor — upgraded to Major due to dual-flag)
- **Category**: Correctness
- **Problem**: The root layout renders `<SideSelector />` for every page. `TempScreen` also renders its own `<SideSelector />`. On the Temp screen, users see two stacked side selectors.
- **Suggested fix**: Remove the `<SideSelector />` from `TempScreen.tsx`. The layout already provides it.
- **Rationale**: Duplicate interactive controls confuse users and waste screen space.

### Finding 3: Debounce/setTimeout timers not cleaned up on unmount [BOTH]
- **Files**: `src/components/Schedule/AlarmScheduleSection.tsx:80-81`, `src/components/Schedule/PowerScheduleSection.tsx:51`, `src/components/TempScreen/TempScreen.tsx:66`, `src/hooks/useSchedule.ts:166,169,228,231`, `src/components/Schedule/CurveEditor.tsx:149,153`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: Multiple components store setTimeout handles in refs (`intensityCommitRef`, `alarmTempCommitRef`, `tempCommitRef`) or don't store them at all (`setConfirmMessage` timers). None are cleared on unmount. Navigation during pending debounce fires mutations after unmount.
- **Suggested fix**: Add `useEffect(() => () => { clearTimeout(ref.current) }, [])` cleanup in each component/hook.
- **Rationale**: Mutations firing after unmount can cause unexpected server state changes.

### Finding 4: Pervasive `any` types in schedule/biometrics code [BOTH]
- **Files**: `src/hooks/useSchedules.ts:21-22`, `src/components/Schedule/ScheduleOverview.tsx:57,65,72,111`, `src/components/biometrics/RawDataButton.tsx` (3× eslint-disable), `src/hooks/useDualSideData.ts`
- **Severity**: 🟡 Major (Opus) / 🟢 Minor (Sonnet)
- **Category**: Type Safety
- **Problem**: `ScheduleData.power` and `.alarm` are `any[]`. Schedule card components accept `{ schedule: any }`. CSV export functions accept `any[]`. ~15 occurrences total.
- **Suggested fix**: Import `PowerSchedule`/`AlarmSchedule` types from `useSchedule.ts`. Use typed generics for CSV functions.
- **Rationale**: `any` types hide bugs and make refactoring dangerous. Types already exist in the codebase.

### Finding 5: `getSleepStages` endpoint uses `z.any()` output schema [BOTH]
- **File**: `src/server/routers/biometrics.ts:635`
- **Severity**: 🟡 Major (Opus) / 🟢 Minor (Sonnet — noted all 9 procedures use `z.any()`)
- **Category**: Type Safety
- **Problem**: The `getSleepStages` procedure (and all biometrics procedures per Sonnet) uses `.output(z.any())` which bypasses runtime output validation. `SleepStagesResult` type is well-defined but has no Zod schema.
- **Suggested fix**: Define proper Zod schemas for output types, starting with `getSleepStages`.
- **Rationale**: Defeats tRPC's end-to-end type safety guarantee.

### Finding 6: Serial mutations in bulk schedule operations [BOTH]
- **File**: `src/hooks/useSchedule.ts` — `toggleAllSchedules`, `applyToOtherDays`; `src/components/Schedule/CurveEditor.tsx:149-175`
- **Severity**: 🟢 Minor
- **Category**: Performance
- **Problem**: Bulk operations issue sequential `await mutateAsync` calls per schedule per day. For 7 days this can be 20-49 serial HTTP round trips. Each triggers `invalidateAll()`.
- **Suggested fix**: Use `Promise.all` for mutations across independent days. Invalidate once at the end.
- **Rationale**: Sequential processing of independent operations is unnecessarily slow.

### Finding 7: PowerButton fires concurrent mutations without coordination [Opus only]
- **File**: `src/components/PowerButton/PowerButton.tsx:53-60`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: In linked mode, the power toggle fires `setPower.mutate()` twice in a loop. No guarantee both succeed/fail. Same pattern in `TempScreen.tsx` for `setTempMutation.mutate()`. Split failure leaves sides in inconsistent state.
- **Suggested fix**: Use `Promise.all` with `mutateAsync`, or create a server-side `setMultiSidePower` endpoint. Add error handling for partial failure.
- **Rationale**: Hardware control mutations should be atomic across sides.

### Finding 8: Dual `useSide` exports create naming confusion [Opus only]
- **File**: `src/providers/SideProvider.tsx:137-142`, `src/hooks/useSide.ts:1-27`
- **Severity**: 🟡 Major
- **Category**: Architecture
- **Problem**: Two modules export `useSide` with different interfaces. `SideProvider.tsx` returns `{ selectedSide, isLinked, selectSide, toggleLink, activeSides, primarySide }`. `src/hooks/useSide.ts` returns `{ side, setSide, toggleSide }`. Components import inconsistently.
- **Suggested fix**: Rename the shim hook to `useSimpleSide` or consolidate to single export.
- **Rationale**: Same-named exports with different interfaces is a maintenance hazard.

### Finding 9: No test coverage for new React components or hooks [Opus only]
- **File**: (all new components)
- **Severity**: 🟡 Major
- **Category**: Testing
- **Problem**: ~80 new components and ~7 hooks with zero test coverage. Only 2 utility lib tests exist. CI uses `--passWithNoTests` so this passes silently.
- **Suggested fix**: Add tests for critical paths: SideProvider, useSchedule, TemperatureDial, useSensorStream.
- **Rationale**: These components control hardware and schedule state — bugs have real-world impact.

### Finding 10: Dead code — NetworkInfoCard never imported [Sonnet only]
- **File**: `src/components/NetworkInfo/NetworkInfoCard.tsx`
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: Component created but never imported or rendered anywhere. Status screen already covers WiFi/internet.
- **Suggested fix**: Delete the file or integrate it.

### Finding 11: Duplicate client-side sleep stage classification [Sonnet only]
- **File**: `src/components/SleepStages/SleepStagesCard.tsx:213`
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: Week view fetches raw vitals + movement for all 7 nights and runs `classifySleepStages` client-side. Server already exposes `biometrics.getSleepStages`. Two code paths for same algorithm; week view fetches 7 × ~288 vitals rows into browser.
- **Suggested fix**: Call `biometrics.getSleepStages` per night, or add batch endpoint.

### Finding 12: Stale date range memoization in EnvironmentPanel [Opus only]
- **File**: `src/components/Environment/EnvironmentPanel.tsx:17-20`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: `getDateRangeFromTimeRange` uses `new Date()` inside `useMemo` with only `[timeRange]` as dep. Date range becomes stale after selection. The refetchInterval keeps fetching with the stale window.
- **Suggested fix**: Remove useMemo or recompute range in queryFn.

### Finding 13: Static SVG gradient ID collision risk [Opus only]
- **File**: `src/components/Environment/HumidityChart.tsx:58`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: Hardcoded `id="humidityGradient"` will collide if multiple instances render.
- **Suggested fix**: Use `useId()` for unique gradient IDs.

### Finding 14: Stale closure risk in `handleDialChange` [Opus only]
- **File**: `src/components/TempScreen/TempScreen.tsx:92-100`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: `handleDialChange` captures `activeSides` at callback creation time. Side changes during 300ms debounce fire mutation for wrong sides.
- **Suggested fix**: Use a ref for `activeSides` inside debounced callback.

### Finding 15: `useEffect` dependency on optional-chained values [Opus only]
- **File**: `src/components/Schedule/AlarmScheduleSection.tsx:87-90`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: `useEffect` deps `[schedule?.vibrationIntensity, schedule?.alarmTemperature]` miss identity changes when schedule object swaps but values match.
- **Suggested fix**: Include `schedule?.id` in dependency array.

### Finding 16: `DataPage` inline type may drift from tRPC output [Opus only]
- **File**: `app/[lang]/data/page.tsx:187-194`
- **Severity**: 🟢 Minor
- **Category**: Type Safety
- **Problem**: Manual `SleepRecordRow` interface with `as` cast could drift from actual tRPC output.
- **Suggested fix**: Use tRPC inferred output type.

### Finding 17: `PrimeCompleteNotification` dismiss only calls refetch [Opus only]
- **File**: `src/components/TempScreen/TempScreen.tsx:152`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: Dismiss callback is `onDismiss={refetch}`. If server doesn't clear notification on refetch, it reappears. `dismissPrimeNotification` mutation exists but isn't wired.
- **Suggested fix**: Call dismiss mutation then refetch.

### Finding 18: SideSelector click silently unlinks [Opus only]
- **File**: `src/components/SideSelector/SideSelector.tsx:80-81`, `src/providers/SideProvider.tsx:93-97`
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: Clicking a side button while linked silently sets `isLinked = false`. Accidental click exits linked mode.
- **Suggested fix**: Confirm this matches iOS behavior, or add guard.

### Finding 19: `user-scalable=no` accessibility concern [Sonnet only]
- **File**: `app/[lang]/layout.tsx:33`
- **Severity**: ⚪ Nit
- **Category**: Architecture
- **Problem**: Viewport meta prevents browser zoom. WCAG 1.4.4 requires text resizability.
- **Suggested fix**: Remove `maximum-scale=1, user-scalable=no`.

### Finding 20: SleepRecordActions no client-side validation [Sonnet only]
- **File**: `src/components/biometrics/SleepRecordActions.tsx:73-80`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: Edit form allows submitting wake time before bed time.
- **Suggested fix**: Add client-side validation before save.

### Finding 21: `formatRelativeTime` returns "past" for stale jobs [Sonnet only]
- **File**: `src/components/status/StatusScreen.tsx:57`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: Returns literal string "past" for overdue scheduler entries.
- **Suggested fix**: Return "overdue" or filter past entries.

### Finding 22: 6 tabs vs 5 screens in PR description [Opus only]
- **File**: `src/components/BottomNav/BottomNav.tsx:8-14`
- **Severity**: ⚪ Nit
- **Category**: Completeness
- **Problem**: BottomNav has 6 tabs but PR says 5 screens.
- **Suggested fix**: Update PR description.

### Finding 23: `Link` icon shadows Next.js `Link` [Opus only]
- **File**: `src/components/SideSelector/SideSelector.tsx:4`
- **Severity**: ⚪ Nit
- **Category**: Architecture
- **Problem**: lucide `Link` import shadows Next.js `Link` in scope.
- **Suggested fix**: Import as `ChainLinkIcon`.

### Finding 24: TempTrendChart date bounds frozen at mount [Sonnet only]
- **File**: `src/components/Sensors/TempTrendChart.tsx:41-43`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: `oneHourAgo` and `now` computed once, never refreshed.
- **Suggested fix**: Update comment to clarify intent.

### Finding 25: PullToRefresh missing `data-scroll-container` [Sonnet only]
- **File**: `src/hooks/usePullToRefresh.ts:50,74`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: Hook looks for `[data-scroll-container]` but component never sets it.
- **Suggested fix**: Add attribute to wrapper div.

### Finding 26: useSensorStream non-obvious dependency management [Opus only]
- **File**: `src/hooks/useSensorStream.ts`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: Uses derived `sensorsKey` as dependency proxy instead of `sensors` array.
- **Suggested fix**: Add eslint-disable comment with explanation.

---

## Statistics
- Total findings: 26
- Flagged by BOTH models: 6 (high confidence)
- Opus only: 13
- Sonnet only: 7
- 🔴 Critical: 0
- 🟡 Major: 9
- 🟢 Minor: 10
- ⚪ Nit: 7
- 🟣 Pre-existing: 0
