# Temperature Units Action Plan

## Execution Status

Implemented 2026-07-03:

- Priority 1: shared temperature helpers live in `src/lib/tempUtils.ts`; `useTemperatureUnit` delegates to them.
- Priority 2: primary dial, step controls, and side selector render/edit in the preferred unit while sending Fahrenheit mutations.
- Priority 3: schedule cards, charts, set point editor, curve editor controls, and alarm editor/card render/edit in the preferred unit while writing Fahrenheit.
- Priority 4: automation temperature signals are documented as Fahrenheit; diagnostics telemetry remains Fahrenheit and uses shared formatters.
- Priority 5: existing TypeScript/Python normalization fixtures cover live Celsius vs persisted centidegrees, sentinels, and missing zones; Pod 3 partial capSense persistence is now rejected.
- Priority 6: shared schedule/time helpers live in `src/lib/scheduleTime.ts`; `Header`, `useScheduleActive`, `TimeInput`, `DaySelector`, and schedule grouping use/re-export them.

## Goal

Respect the user's temperature preference everywhere temperatures are displayed or edited, while keeping hardware, automation, and storage boundaries explicit.

Canonical units today:

- Hardware setpoints and device state: Fahrenheit.
- Schedule storage: Fahrenheit.
- Live sensor frames: Celsius.
- Biometrics environment storage: centidegrees Celsius.
- HomeKit and MQTT boundaries: Celsius where required by those protocols.
- Automation signals and thermal diagnostics: Fahrenheit by current contract.

## Priority 1: Centralize Temperature Unit Boundaries

### Action

Replace ad hoc display conversion with a single temperature domain module.

Suggested target:

- Extend `src/lib/tempUtils.ts`, or split to `src/lib/temperature.ts` if the file becomes too broad.

Add explicit helpers:

- `setpointFToDisplay(tempF, unit)`
- `displayToSetpointF(value, unit)`
- `sensorCToDisplay(celsius, unit)`
- `centidegreesToDisplay(centidegrees, unit)`
- `formatDisplayTemp(value, unit, options?)`
- `formatSetpointF(tempF, unit, options?)`
- `formatSensorC(celsius, unit, options?)`

Keep low-level conversions:

- `toF`
- `toC`
- `centiDegreesToC`
- `centiDegreesToF`
- `centiPercentToPercent`

### Acceptance Criteria

- Components do not need to know whether a displayed value came from Celsius, centidegrees, or Fahrenheit.
- Existing helpers in `useTemperatureUnit` delegate to the shared module instead of duplicating formulas.
- Names make source units obvious.

### Tests

- Add unit tests for each new helper.
- Include null/undefined formatting behavior.
- Include round trips for Celsius preference editing setpoints back to Fahrenheit.

## Priority 2: Make Primary Temperature Control Preference-Aware

### Files

- `src/components/TempScreen/TempScreen.tsx`
- `src/components/TemperatureDial/TemperatureDial.tsx`
- `src/components/SideSelector/SideSelector.tsx`

### Current Problem

`TempScreen` reads `settings.device.temperatureUnit`, but the primary dial and side selector still display Fahrenheit. Mutations are correctly sent to hardware in Fahrenheit, but user-facing display ignores the preference.

### Action

- Keep `TempScreen` internal state and mutations in Fahrenheit.
- Pass `unit` to `TemperatureDial`.
- Render dial target/current temperatures with `formatSetpointF`.
- Convert drag/key/display values cleanly:
  - Dial geometry can remain Fahrenheit for now.
  - If Celsius editing is desired, map UI increments to the displayed unit and convert committed values back to Fahrenheit.
- Update `SideSelector` to use the same setpoint formatting helper.

### Acceptance Criteria

- With `temperatureUnit = C`, the main dial, current temperature, and side selector show Celsius.
- Hardware mutations still call `device.setTemperature` with Fahrenheit.
- No double conversion occurs when WebSocket status frames update.

### Tests

- Add or update component tests for Fahrenheit and Celsius preference.
- Verify that a Celsius-displayed edit sends the expected Fahrenheit payload.

## Priority 3: Make Schedule Views and Editors Preference-Aware

### Files

- `src/hooks/useSchedule.ts`
- `src/hooks/useSchedules.ts`
- `src/hooks/useScheduleActive.ts`
- `src/components/Schedule/CurveCard.tsx`
- `src/components/Schedule/CurveChart.tsx`
- `src/components/Schedule/CurveEditor.tsx`
- `src/components/Schedule/SetPointEditor.tsx`
- `src/components/Schedule/AlarmCard.tsx`
- `src/components/Schedule/AlarmEditor.tsx`

### Current Problem

The schedules router supports `unit`, but UI callers use the default Fahrenheit response and hardcode `°F`. Editors also write Fahrenheit directly.

### Action

Choose one of these patterns and apply consistently:

1. Preferred: keep schedule tRPC reads/writes canonical in Fahrenheit and convert only in UI.
2. Alternative: request schedules in the user's unit and convert mutation payloads back to Fahrenheit before writes.

The preferred pattern is simpler because storage and scheduler execution are already Fahrenheit.

Implementation steps:

- Read temperature preference with `useTemperatureUnit`.
- Render schedule setpoints using `formatSetpointF`.
- In editors, display values in the preferred unit but convert submitted values to Fahrenheit.
- Rename local variables where useful:
  - `temperatureF` for canonical values.
  - `displayTemperature` for UI values.

### Acceptance Criteria

- Schedule cards, next-event labels, chart labels, setpoint editor, and alarm editor honor Celsius preference.
- Database writes remain Fahrenheit.
- Scheduler execution receives Fahrenheit.
- Existing Fahrenheit behavior is unchanged.

### Tests

- Add hook tests for schedule display conversion.
- Add mutation tests proving Celsius display input writes Fahrenheit.
- Keep existing router tests for `unit=C`, or remove router display conversion later if it becomes unused.

## Priority 4: Codify Automation and Diagnostics Units

### Files

- `src/automation/signals.biometrics.ts`
- `src/automation/backtest.ts`
- `src/components/Autopilot/*`
- `src/server/routers/health.ts`
- `src/components/diagnostics/diagnosticsLogic.ts`
- `src/components/diagnostics/ThermalTrendChart.tsx`

### Current State

Automation and thermal diagnostics use Fahrenheit. This appears intentional because automation actions target hardware setpoints.

### Action

- Add a short code comment or type alias documenting that automation temperature signals are Fahrenheit.
- Use shared Fahrenheit formatting helpers instead of inline strings like `${value}°F`.
- Decide whether Autopilot builder labels should honor user preference. If not, label them as automation/setpoint units rather than general display units.

### Acceptance Criteria

- Automation unit contract is explicit.
- Diagnostics hardcoded Fahrenheit is either documented as engineering telemetry or made preference-aware.
- Future UI code cannot accidentally treat automation values as user-preferred values.

### Tests

- Update existing Autopilot and diagnostics tests only where output labels change.

## Priority 5: Strengthen Sensor Normalization Contract Tests

### Files

- `src/streaming/normalizeFrame.ts`
- `modules/common/dialect.py`
- `modules/environment-monitor/main.py`
- `src/streaming/tests/normalizeFrame.test.ts`
- `modules/common/test_dialect.py`

### Current State

TypeScript live-frame normalization and Python DB ingestion both normalize firmware dialects. They are conceptually aligned but can drift.

### Action

- Add shared fixture payloads for:
  - `bedTemp`
  - `bedTemp2`
  - `frzTemp`
  - sentinel values
  - partial/missing zone arrays
- Verify TypeScript live normalization returns Celsius.
- Verify Python module normalization returns centidegrees Celsius for DB storage.
- Document that difference in the fixture test names.

### Acceptance Criteria

- A future firmware dialect change fails tests in both paths.
- Sentinel behavior is consistent between live UI and persisted DB data.

## Priority 6: Consolidate Time and Schedule Helpers

### Files

- `src/scheduler/timeUtils.ts`
- `src/components/Header/Header.tsx`
- `src/hooks/useScheduleActive.ts`
- `src/components/Schedule/DaySelector.tsx`
- `src/components/Schedule/TimeInput.tsx`
- `src/lib/scheduleGrouping.ts`

### Current Problem

Time parsing, minutes conversion, day ordering, and night-window checks are spread across components and hooks.

### Action

- Move shared helpers into a non-React module:
  - `hhmmToMinutes`
  - `formatTime12h`
  - `getCurrentDay`
  - `isInWindow`
  - `isInWindowForTimezone`
  - `DAYS_OF_WEEK`
- Keep UI components importing helpers rather than defining their own.

### Acceptance Criteria

- `Header` uses the shared timezone-aware night-window helper.
- `useScheduleActive` uses shared day ordering and time parsing.
- `TimeInput` can remain a component, but its pure helpers live outside the component folder.

### Tests

- Add DST/wrapped-window tests for the shared helpers.
- Preserve existing `TimeInput` helper test coverage after moving functions.

## Suggested Implementation Order

1. Add the new temperature helper API and tests.
2. Refactor `useTemperatureUnit` to delegate to it.
3. Update primary temperature UI.
4. Update schedule UI and editor flows.
5. Codify automation/diagnostics unit contracts.
6. Add cross-path sensor normalization fixture tests.
7. Consolidate schedule/time helpers.

## Quality Gates

Run after each priority or before PR:

```bash
pnpm lint
pnpm tsc
pnpm test
```

For Python module changes:

```bash
python -m pytest modules
```
