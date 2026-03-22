# Optimizer Findings (Sonnet) — feat/browser-ui-parity

## Summary

This PR adds a complete browser UI matching the iOS app across all 5 main screens: Temperature (270° SVG dial), Schedule (curve editor, day selector, bulk ops), Data/Biometrics (sleep stages, vitals, environment charts), Sensors (real-time WebSocket waveforms), and Status/Settings. It introduces a shared `SideProvider` context, a singleton WebSocket manager, a server-side sleep stage classifier ported from iOS, and mobile-first UX (swipe navigation, pull-to-refresh, 44px touch targets).

Overall code quality is high — well-documented, thoughtful decomposition, and solid tRPC/React Query patterns. The main issues are 7 barrel export files that violate explicit project conventions, a duplicate `SideSelector` on the Temp screen, several `any` types, and unguarded `setTimeout` calls that can fire on unmounted components.

## Findings

### Finding 1: 7 Barrel Export Files Violate Project Convention
- **Files**: `src/components/DualSideChart/index.ts`, `src/components/Environment/index.ts`, `src/components/Schedule/index.ts`, `src/components/Sensors/index.ts`, `src/components/SleepStages/index.ts`, `src/components/biometrics/index.ts`, `src/lib/sleepCurve/index.ts`
- **Severity**: 🟡 Major
- **Category**: Pattern
- **Problem**: `.claude/docs/import-patterns.md` explicitly states "NEVER create barrel exports (index.ts re-exports)". All 7 files are pure re-export barrels. Two are actively consumed: `app/[lang]/data/page.tsx` imports `SleepStagesCard` from `@/src/components/SleepStages` (barrel) and `EnvironmentPanel` from `@/src/components/Environment` (barrel).
- **Suggested fix**: Delete all 7 `index.ts` files. Update the two barrel consumers in `data/page.tsx` to direct imports: `@/src/components/SleepStages/SleepStagesCard` and `@/src/components/Environment/EnvironmentPanel`.

### Finding 2: Duplicate SideSelector Rendered on Temp Screen
- **File**: `app/[lang]/layout.tsx:46` + `src/components/TempScreen/TempScreen.tsx:161`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: The global `LangLayout` renders `<SideSelector />` for every page. `TempScreen.tsx` renders its own `<SideSelector />` again. On the Temp screen, two stacked side selectors appear. Each instance independently subscribes to `trpc.device.getStatus` with a 10s poll (React Query deduplicates the request, but two separate subscription lifetimes exist).
- **Suggested fix**: Remove the `<SideSelector />` import and render from `TempScreen.tsx`. The layout already provides it.

### Finding 3: Unguarded setTimeout Calls Can Update Unmounted Components
- **File**: `src/hooks/useSchedule.ts:166,169,228,231` (also `src/components/Schedule/CurveEditor.tsx:149,153`)
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: `togglePowerSchedule`, `toggleAllSchedules`, and `applyToOtherDays` call `setTimeout(() => setConfirmMessage(null), ...)` without storing the timer ID. If the component using this hook unmounts while the timer is pending, the state setter fires on an unmounted component.
- **Suggested fix**: Use a `useRef` to store the timer ID and clear it in a `useEffect` cleanup.

### Finding 4: Slider Debounce Timers Not Cleaned Up on Unmount
- **Files**: `src/components/Schedule/AlarmScheduleSection.tsx`, `src/components/Schedule/PowerScheduleSection.tsx`, `src/components/TempScreen/TempScreen.tsx:66`
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: `intensityCommitRef`, `alarmTempCommitRef`, and `tempCommitRef` hold debounce timer IDs but no `useEffect` cleanup clears them on unmount. A slider interaction followed by immediate navigation will still fire the mutation after the component is gone.
- **Suggested fix**: Add `useEffect(() => () => { clearTimeout(ref.current) }, [])` in each component.

### Finding 5: Pervasive `any` Types in Schedule and Export Code
- **Files**: `src/hooks/useSchedules.ts:21-22`, `src/components/Schedule/ScheduleOverview.tsx:57,65,72,111`, `src/components/biometrics/RawDataButton.tsx` (3× eslint-disable-next-line), `src/hooks/useDualSideData.ts`
- **Severity**: 🟢 Minor
- **Category**: Type Safety
- **Problem**: `ScheduleData.power` and `ScheduleData.alarm` are `any[]`. `PowerScheduleCard`/`AlarmScheduleCard` accept `{ schedule: any }`. CSV functions accept `any[]`. All bypass type checking on database-sourced data.
- **Suggested fix**: Import and reuse `PowerSchedule`/`AlarmSchedule` types already defined in `src/hooks/useSchedule.ts`. Use proper generics for the tRPC optimistic update setters.

### Finding 6: tRPC Procedures Use `z.any()` Output Types
- **File**: `src/server/routers/biometrics.ts` — all query procedures
- **Severity**: 🟢 Minor
- **Category**: Type Safety
- **Problem**: All 9 biometrics procedures use `.output(z.any())`. This loses runtime validation, type inference for callers, and OpenAPI schema correctness. `getSleepStages` already has a TypeScript return type (`Promise<SleepStagesResult>`) but no matching Zod schema.
- **Suggested fix**: Define Zod schemas for the return types, starting with `getSleepStages` since its shape is fully known.

### Finding 7: Serial Mutations in Bulk Schedule Operations (N+1 Pattern)
- **File**: `src/hooks/useSchedule.ts` — `toggleAllSchedules`, `applyToOtherDays`
- **Severity**: 🟢 Minor
- **Category**: Performance
- **Problem**: `toggleAllSchedules` issues one `await mutateAsync` per schedule per day serially. For 7 days × 3 types × multiple schedules, this can be 20+ serial HTTP calls. `applyToOtherDays` deletes and recreates individually. Each triggers `invalidateAll()` on success.
- **Suggested fix**: Use `Promise.all` for mutations across independent days, and invalidate once at the end rather than per-mutation. A backend `bulkUpdateEnabled` endpoint would be ideal.

### Finding 8: Dead Code — NetworkInfoCard Never Imported
- **File**: `src/components/NetworkInfo/NetworkInfoCard.tsx`
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: This component is created but never imported or rendered anywhere. The Status screen already covers WiFi info in `HealthStatusCard` and internet toggle in `InternetToggleCard`.
- **Suggested fix**: Delete the file, or integrate it into the Status screen if it provides unique value.

### Finding 9: Duplicate Client-Side Sleep Stage Classification
- **File**: `src/components/SleepStages/SleepStagesCard.tsx:213`
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: The week view fetches raw vitals + movement for all 7 nights and runs `classifySleepStages` client-side in a `useMemo`. The server already exposes `biometrics.getSleepStages`. This is two code paths for the same algorithm; the week view also fetches 7 × ~288 vitals rows plus movement into the browser.
- **Suggested fix**: Call `biometrics.getSleepStages` for each night in parallel, or add a `biometrics.getWeeklySleepStages` batch endpoint.

### Finding 10: `user-scalable=no` Accessibility Concern
- **File**: `app/[lang]/layout.tsx:33`
- **Severity**: ⚪ Nit
- **Category**: Architecture
- **Problem**: Viewport meta includes `maximum-scale=1, user-scalable=no`. This prevents browser zoom, blocking users who rely on text magnification. WCAG 1.4.4 (Level AA) requires text resizability.
- **Suggested fix**: Remove `maximum-scale=1, user-scalable=no`, keep `viewport-fit=cover`.

### Finding 11: SleepRecordActions Edit Form Has No Client-Side Validation
- **File**: `src/components/biometrics/SleepRecordActions.tsx:73-80`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: The bed-time/wake-time edit inputs allow submitting wake before bed. The server rejects this, but the small error message placement may be non-obvious.
- **Suggested fix**: Add `if (new Date(editWakeTime) <= new Date(editBedTime)) return` in `handleSave` with a visible inline error.

### Finding 12: `useSchedules.ts` `invalidate` Captures Stale `queryKey`
- **File**: `src/hooks/useSchedules.ts:62-65`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: `queryKey` is constructed inline but the `invalidate` callback lists `selectedDay` in its `useCallback` deps rather than the stable `queryKey` object.
- **Suggested fix**: `const queryKey = useMemo(() => ({ side, dayOfWeek: selectedDay }), [side, selectedDay])`.

### Finding 13: `formatRelativeTime` Returns Unhelpful `"past"` for Stale Jobs
- **File**: `src/components/status/StatusScreen.tsx:57`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: If `nextRun` is in the past (stale scheduler state), the function returns the literal string `"past"`.
- **Suggested fix**: Return `"overdue"` or filter out past-due entries from the display.

### Finding 14: `TempTrendChart` Date Bounds Frozen at Mount Time
- **File**: `src/components/Sensors/TempTrendChart.tsx:41-43`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: `oneHourAgo` and `now` have empty `useMemo` deps so they are set once at component mount and never refresh.
- **Suggested fix**: Update the comment to clarify "snapshot of last hour at mount time" to match the implementation.

### Finding 15: `PullToRefresh` Container Missing `data-scroll-container` Attribute
- **File**: `src/components/PullToRefresh/PullToRefresh.tsx` / `src/hooks/usePullToRefresh.ts:50,74`
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: `usePullToRefresh` looks for `closest('[data-scroll-container]')` to determine if the page is scrolled to top, falling back to `document.documentElement`. The `PullToRefresh` component never adds this attribute.
- **Suggested fix**: Add `data-scroll-container` to the PullToRefresh wrapper div.

### Finding 16: `ScheduleOverview.tsx` Redefines Types Already Exported from `useSchedule.ts`
- **File**: `src/components/Schedule/ScheduleOverview.tsx:72,111`
- **Severity**: ⚪ Nit
- **Category**: Type Safety
- **Problem**: `PowerScheduleCard` and `AlarmScheduleCard` are typed `{ schedule: any }` rather than importing the `PowerSchedule`/`AlarmSchedule` interfaces from `useSchedule.ts`.
- **Suggested fix**: Import and use the existing types.

## Statistics
- Total findings: 16
- 🔴 Critical: 0
- 🟡 Major: 4 (barrel exports, duplicate SideSelector, unguarded setTimeout, slider debounce leak)
- 🟢 Minor: 5 (any types, z.any() output, N+1 mutations, dead NetworkInfoCard, duplicate classification)
- ⚪ Nit: 7
- 🟣 Pre-existing: 0
