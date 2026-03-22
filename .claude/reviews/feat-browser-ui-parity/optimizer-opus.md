# Optimizer Findings (Opus) -- feat/browser-ui-parity

## Summary
This PR adds a full browser UI matching the iOS app across 5 screens (Temp, Schedule, Data/Biometrics, Sensors, Status/Settings) plus a new Sensors screen. It introduces a shared `SideProvider` for left/right/linked side selection, wires ~80 new UI components to real tRPC endpoints (device status, schedules, biometrics, environment, settings), and adds WebSocket-based live sensor streaming. The implementation also includes a server-side sleep stage classifier, temperature curve generator with tests, and extensive charting via Recharts.

Overall code quality is solid for a feature of this scope -- the components are well-structured, the tRPC wiring is thorough, and accessibility patterns (min touch targets, ARIA labels) are consistently applied. However, there are several convention violations (barrel exports), type safety gaps, and a few correctness issues that should be addressed before merge.

## Findings

### Finding 1: Seven barrel export files violate project convention
- **File**: `src/components/DualSideChart/index.ts`, `src/components/Environment/index.ts`, `src/components/Schedule/index.ts`, `src/components/Sensors/index.ts`, `src/components/SleepStages/index.ts`, `src/components/biometrics/index.ts`, `src/lib/sleepCurve/index.ts`
- **Severity**: 🟡 Major
- **Category**: Pattern
- **Problem**: The project convention doc (`.claude/docs/import-patterns.md`) explicitly bans barrel exports: "NEVER create barrel exports (index.ts re-exports) -- Adds indirection, circular dependency risks, slows bundlers". This PR creates 7 new `index.ts` barrel files.
- **Suggested fix**: Delete all 7 `index.ts` files and update all consuming imports to reference source files directly. For example, change `import { SleepStagesCard } from '@/src/components/SleepStages'` to `import { SleepStagesCard } from '@/src/components/SleepStages/SleepStagesCard'`.
- **Rationale**: Direct violation of `.claude/docs/import-patterns.md` "never create barrel exports" rule.

### Finding 2: `getSleepStages` endpoint uses `z.any()` output schema
- **File**: `src/server/routers/biometrics.ts`:635 (`.output(z.any())`)
- **Severity**: 🟡 Major
- **Category**: Type Safety
- **Problem**: The new `getSleepStages` procedure uses `.output(z.any())` which bypasses runtime output validation entirely. Since the `SleepStagesResult` type is already well-defined, there is no reason to skip validation. This defeats one of tRPC's core benefits: guaranteed contract safety between server and client.
- **Suggested fix**: Define a proper Zod schema for `SleepStagesResult` and use it as the output validator. At minimum, use a `z.object({...})` matching the shape of epochs, blocks, distribution, qualityScore, totalSleepMs, sleepRecordId, enteredBedAt, leftBedAt.
- **Rationale**: tRPC's output validation ensures the API contract is enforced at runtime. Using `z.any()` makes the contract meaningless and could leak unexpected data shapes to the client.

### Finding 3: Dual `useSide` exports create naming confusion and interface divergence
- **File**: `src/providers/SideProvider.tsx`:137-142, `src/hooks/useSide.ts`:1-27
- **Severity**: 🟡 Major
- **Category**: Architecture
- **Problem**: Two different modules export a function called `useSide` with different return interfaces. `SideProvider.tsx` exports `useSide()` returning `{ selectedSide, isLinked, selectSide, toggleLink, activeSides, primarySide }`, while `src/hooks/useSide.ts` exports `useSide()` returning `{ side, setSide, toggleSide }`. Components import from inconsistent sources -- some from the provider, some from the hook. This creates confusion about which `useSide` is being used and makes refactoring error-prone.
- **Suggested fix**: Rename the shim hook to `useSimpleSide` or `usePrimarySide` to distinguish it, or consolidate to a single export. At minimum, add a deprecation comment directing new code to the provider version.
- **Rationale**: Same-named exports from different modules with different interfaces is a maintenance hazard.

### Finding 4: Multiple `any` types in schedule components and data exports
- **File**: `src/components/Schedule/ScheduleOverview.tsx`:585,593,600,639; `src/hooks/useSchedules.ts`:22-23; `src/components/biometrics/RawDataButton.tsx`:100,109,118
- **Severity**: 🟡 Major
- **Category**: Type Safety
- **Problem**: At least 15 occurrences of `any` across schedule and biometrics components: `power.map((ps: any) => ...)`, `schedule: any`, `function generateVitalsCSV(vitals: any[])`, and `ScheduleData` containing `power: any[]` and `alarm: any[]`. These bypass TypeScript's type checking entirely.
- **Suggested fix**: Define proper interfaces for `PowerSchedule`, `AlarmSchedule` in `useSchedules.ts` (some are already defined in `useSchedule.ts`), and use typed generics for CSV generation functions. The schedule data shapes are known from the tRPC router outputs.
- **Rationale**: `any` types hide bugs and make refactoring dangerous. The CI rule `pnpm tsc` may pass, but the code loses compile-time safety.

### Finding 5: PowerButton fires multiple concurrent mutations in loop without coordination
- **File**: `src/components/PowerButton/PowerButton.tsx`:53-60
- **Severity**: 🟡 Major
- **Category**: Correctness
- **Problem**: When in linked mode (`activeSides = ['left', 'right']`), the power toggle fires `setPower.mutate()` twice in a `for` loop. Each call is independent -- there is no guarantee both succeed or both fail. If the first mutation succeeds but the second fails, the sides will be in an inconsistent state (one on, one off). The same pattern exists in `TempScreen.tsx` for `setTempMutation.mutate()`.
- **Suggested fix**: Use `Promise.all` with `mutateAsync` and handle the error case atomically, or create a server-side `setMultiSidePower` endpoint that toggles both sides in one operation. At minimum, add error handling that retries or reverts the first side if the second fails.
- **Rationale**: Hardware control mutations should be atomic when applied to multiple sides simultaneously. Split failures leave the device in an undefined state.

### Finding 6: `getDateRangeFromTimeRange` is memoized with stale `Date()`
- **File**: `src/components/Environment/EnvironmentPanel.tsx`:17-20 (via `TimeRangeSelector.tsx`:17-20)
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: `getDateRangeFromTimeRange` calls `new Date()` inside the function, but it is wrapped in `useMemo` with only `[timeRange]` as a dependency. This means the date range is computed once when `timeRange` changes and then stays stale. If the user sits on the page for 30 minutes, the "last 1 hour" range still reflects the time when the range was first selected, not the current time. The `refetchInterval: 60_000` will keep fetching, but always with the same stale date window.
- **Suggested fix**: Either remove the `useMemo` and let it recompute on each render (acceptable since it is cheap), or add a refresh interval that updates the date range periodically, or compute the range inside the query's `queryFn` so each refetch uses the current time.
- **Rationale**: For time-based data visualization, the query window should advance with time, especially when the component uses refetch intervals.

### Finding 7: Static SVG gradient ID `humidityGradient` will collide if multiple HumidityChart instances render
- **File**: `src/components/Environment/HumidityChart.tsx`:58
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The `HumidityChart` component uses a hardcoded `id="humidityGradient"` for its SVG `<linearGradient>`. If multiple `HumidityChart` instances were ever rendered on the same page, they would share/collide on this ID, causing gradient rendering artifacts.
- **Suggested fix**: Use `useId()` from React to generate a unique gradient ID per component instance, consistent with how `DualSideChart` already uses a `gradientId` prop pattern.
- **Rationale**: SVG IDs are document-global. Hardcoded IDs are fragile even if only one instance exists today.

### Finding 8: Stale closure risk in `handleDialChange` callback
- **File**: `src/components/TempScreen/TempScreen.tsx`:92-100
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: `handleDialChange` is wrapped in `useCallback` with `[activeSides, setTempMutation]` as dependencies. Inside the debounced timeout, it captures `activeSides` at the time of the callback creation. If the user changes the side selection during the 300ms debounce window, the mutation will fire for the old set of sides, not the current one.
- **Suggested fix**: Use a ref for `activeSides` inside the debounced callback, or read `activeSides` from the provider at mutation time. Alternatively, since `activeSides` rarely changes during a dial drag, this is low-risk but worth documenting.
- **Rationale**: Debounced callbacks that close over React state can fire with stale values.

### Finding 9: No test coverage for any of the new React components or hooks
- **File**: (multiple -- all new components)
- **Severity**: 🟡 Major
- **Category**: Testing
- **Problem**: The PR adds ~80 new React components and ~7 new hooks, but only includes tests for 2 pure utility libraries (`sleep-stages.test.ts`, `generate.test.ts`). There are no component tests, no hook tests, and no integration tests for any of the new UI code. Critical user-facing flows like the temperature dial interaction, schedule CRUD, power toggle, and WebSocket sensor stream have zero test coverage.
- **Suggested fix**: At minimum, add tests for: (1) `SideProvider` context behavior (link/unlink, persistence), (2) `useSchedule` hook mutation flows, (3) `TemperatureDial` drag interaction, (4) `useSensorStream` connection lifecycle. The CI config runs `pnpm test run --coverage --passWithNoTests`, so this passes silently.
- **Rationale**: `.claude/docs/ci-checks.md` shows the test suite uses `--passWithNoTests`, which means zero coverage goes undetected. These components control hardware and schedule state -- bugs have real-world impact.

### Finding 10: `useEffect` dependency uses optional chaining on `schedule` object
- **File**: `src/components/Schedule/AlarmScheduleSection.tsx`:87-90
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The `useEffect` that syncs local slider state uses `[schedule?.vibrationIntensity, schedule?.alarmTemperature]` as dependencies. When `schedule` changes from one object to another with the same vibration intensity value, the effect will not re-run (values are referentially equal). More importantly, if `schedule` becomes `undefined` (user deletes the schedule), the local state retains the old value until the component re-mounts. The same pattern appears in `PowerScheduleSection.tsx`.
- **Suggested fix**: Include `schedule?.id` in the dependency array so the effect fires when switching between different schedule objects that happen to share the same values.
- **Rationale**: `useEffect` deps on optional-chained primitive values can miss identity changes.

### Finding 11: `AlarmScheduleSection` and `PowerScheduleSection` debounce timers leak on unmount
- **File**: `src/components/Schedule/AlarmScheduleSection.tsx`:80-81; `src/components/Schedule/PowerScheduleSection.tsx`:51
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: `intensityCommitRef`, `alarmTempCommitRef`, and `tempCommitRef` hold `setTimeout` handles that are never cleared on component unmount. If the user changes tabs or the day selector while a debounced mutation is pending, the timeout fires after unmount, calling `handleUpdateIntensity` which calls `updateMutation.mutate()` on an unmounted component.
- **Suggested fix**: Add a cleanup `useEffect` that clears all pending timeouts on unmount:
  ```tsx
  useEffect(() => {
    return () => {
      clearTimeout(intensityCommitRef.current)
      clearTimeout(alarmTempCommitRef.current)
    }
  }, [])
  ```
- **Rationale**: Mutations firing after unmount can cause unexpected server state changes.

### Finding 12: `TempScreen` renders `SideSelector` redundantly with layout
- **File**: `src/components/TempScreen/TempScreen.tsx`:10, `app/[lang]/layout.tsx`:53
- **Severity**: 🟢 Minor
- **Category**: Architecture
- **Problem**: The root layout (`app/[lang]/layout.tsx`) already renders `<SideSelector />` above the `{children}` slot. Then `TempScreen` (the home page component) also renders its own `<SideSelector />`. This means on the Temp screen, users see two side selectors stacked.
- **Suggested fix**: Remove the `<SideSelector />` from either the layout or from `TempScreen`. The layout version ensures it appears on all pages; the TempScreen version was likely added to match the iOS structure where each screen manages its own header.
- **Rationale**: Duplicate interactive controls confuse users and waste screen space.

### Finding 13: `CurveEditor` saves schedules in a sequential loop per day
- **File**: `src/components/Schedule/CurveEditor.tsx`:149-175
- **Severity**: 🟢 Minor
- **Category**: Performance
- **Problem**: The `handleApply` function loops over `selectedDays` and for each day: fetches existing schedules, deletes them, then creates new ones -- all sequentially with `await`. For 7 days, this creates ~7 fetch + ~14 delete + ~28 create = ~49 sequential network round trips. On a local network this may be acceptable, but it is unnecessarily slow.
- **Suggested fix**: Parallelize across days with `Promise.all(daysArray.map(async day => { ... }))`. The per-day operations can still be sequential to avoid race conditions, but different days can be processed in parallel.
- **Rationale**: Sequential processing of independent operations is unnecessarily slow.

### Finding 14: BottomNav has 6 tabs but PR scope describes 5 screens
- **File**: `src/components/BottomNav/BottomNav.tsx`:8-14
- **Severity**: ⚪ Nit
- **Category**: Completeness
- **Problem**: The BottomNav defines 6 tabs (Temp, Schedule, Data, Sensors, Status, Settings), but the PR description mentions "5 screens." The Sensors screen appears to be an additional screen beyond the iOS parity scope. This is not a bug, but the PR description should be updated to reflect 6 screens or clarify that Sensors is a bonus addition.
- **Suggested fix**: Update PR body to mention 6 screens or clarify Sensors as an extra.
- **Rationale**: PR description accuracy helps reviewers and future archaeology.

### Finding 15: `SideSelector` imports `Link` from `lucide-react` which shadows Next.js `Link`
- **File**: `src/components/SideSelector/SideSelector.tsx`:4
- **Severity**: ⚪ Nit
- **Category**: Architecture
- **Problem**: The import `import { Link, LinkIcon, Power, TrendingDown, TrendingUp } from 'lucide-react'` uses the name `Link` for the lucide chain-link icon. This shadows Next.js's `Link` component in the module scope. While `SideSelector` does not use Next.js routing, future edits that add routing links would hit a confusing name collision.
- **Suggested fix**: Import as `import { Link as ChainLinkIcon, LinkIcon, ... }` or use a different lucide icon name.
- **Rationale**: Name shadowing reduces code clarity and introduces subtle import errors during maintenance.

### Finding 16: `DataPage` uses inline type `SleepRecordRow` that may drift from tRPC output
- **File**: `app/[lang]/data/page.tsx`:187-194
- **Severity**: 🟢 Minor
- **Category**: Type Safety
- **Problem**: `DataPage` defines a local `SleepRecordRow` interface and casts the tRPC query result with `as SleepRecordRow[]`. This manual type definition could drift from the actual tRPC router output type. If the server schema changes (e.g., renames `enteredBedAt` to `bedEntryTime`), the cast silently succeeds but the runtime data will not match.
- **Suggested fix**: Use the tRPC inferred output type: `type SleepRecordRow = RouterOutput['biometrics']['getSleepRecords'][number]` (or equivalent from `@trpc/react-query`).
- **Rationale**: Manual type casts defeat TypeScript's end-to-end type safety that tRPC provides.

### Finding 17: `PrimeCompleteNotification` dismiss handler only calls `refetch`
- **File**: `src/components/TempScreen/TempScreen.tsx`:152
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The `PrimeCompleteNotification` dismiss callback is `onDismiss={refetch}` which re-fetches device status. But if the server does not clear the notification flag on re-fetch, the notification will reappear. The comment in the TempScreen JSDoc mentions `device.dismissPrimeNotification (mutation)` but it is not actually wired up in the handler.
- **Suggested fix**: Call the `dismissPrimeNotification` mutation followed by `refetch()` in the dismiss handler, or confirm that re-fetching alone clears the notification server-side.
- **Rationale**: Dismiss UX that does not persist the dismissal creates a frustrating loop.

### Finding 18: `SideSelector` click on a side button while in linked mode silently unlinks
- **File**: `src/components/SideSelector/SideSelector.tsx`:80-81, `src/providers/SideProvider.tsx`:93-97
- **Severity**: 🟢 Minor
- **Category**: Correctness
- **Problem**: The `SideButton` `onSelect` callback calls `selectSide('left')` or `selectSide('right')`. In the `SideProvider`, `selectSide` sets `isLinked` to `false` whenever the side is not `'both'`. This means clicking either side button while in linked mode silently unlinks the sides. The user must click the center link button to enter linked mode, but a single misclick on a side button exits it.
- **Suggested fix**: This may be intentional UX (matching iOS), but if not, add a guard: when linked, clicking a side should either be a no-op or should select that side as primary without unlinking.
- **Rationale**: Accidental unlink during linked mode could cause temperature changes to apply to only one side unexpectedly.

### Finding 19: `useSensorStream` useEffect has non-obvious dependency omission
- **File**: `src/hooks/useSensorStream.ts` (connection useEffect)
- **Severity**: ⚪ Nit
- **Category**: Correctness
- **Problem**: The subscription `useEffect` uses `sensorsKey` (a derived string) as a dependency proxy for the `sensors` array, and the connection `useEffect` depends on `[enabled]` only. While this works correctly, the ESLint `exhaustive-deps` rule would flag `sensors` and `enabled` as missing. The non-obvious dependency management should be documented.
- **Suggested fix**: Add an `// eslint-disable-next-line react-hooks/exhaustive-deps` comment with explanation, or refactor to make the dependency relationship explicit.
- **Rationale**: Non-obvious dependency management should be documented to prevent future "fix lint" PRs from breaking the hook.

## Statistics
- Total findings: 19
- 🔴 Critical: 0
- 🟡 Major: 6
- 🟢 Minor: 10
- ⚪ Nit: 3
- 🟣 Pre-existing: 0
