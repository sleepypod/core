# Schedule Page Redesign Plan

## Goal
Achieve visual and functional parity between web and iOS schedule pages. Move from a flat list of controls to a smart-first experience with manual controls in a bottom sheet.

## Target Layout (both platforms)
1. Side selector (left/right/both)
2. Day picker (7 days, multi-select for bulk ops)
3. Curve presets (horizontal scroll: Hot Sleeper, Cold Sleeper, Balanced + Custom)
4. Visual temperature curve chart (bedtime → wake, color-coded phases)
5. Bedtime/wake time pickers + temperature range
6. Schedule Active toggle
7. "Manual Controls" → bottom sheet with set points, power schedule, alarm schedule

## Steps

### Step 1: Fix toggle bug
**Files:** `src/hooks/useSchedule.ts`
- `toggleAllSchedules` updates existing power schedules but can't create new ones
- If no power schedule exists for the selected day, the toggle does nothing
- Fix: create a default power schedule (on=22:00, off=07:00, temp=75) when toggling on if none exists
- Ensure `isPowerEnabled` reflects actual state after toggle
- Test: toggle on/off on a day with no existing schedules

### Step 2: Add curve presets to web schedule page
**Files:** `src/components/Schedule/SchedulePage.tsx` (new section), new `CurvePresets.tsx` component
- Horizontal scroll of profile cards matching iOS SmartCurveView profiles
- Profiles: Hot Sleeper, Cold Sleeper, Balanced (from `src/lib/sleepCurve/`)
- "Custom" button opens a curve picker (saved templates + "Design Your Own")
- Applying a preset creates/updates temperature schedules for the selected day
- Reference iOS: `Sleepypod/Views/Schedule/SmartCurveView.swift` for profile definitions

### Step 3: Add visual curve chart to web
**Files:** New `CurveChart.tsx` component, integrate into `SchedulePage.tsx`
- Recharts-based temperature curve visualization
- X-axis: time (bedtime through wake), Y-axis: temperature offset from 80°F
- Color-coded line segments by phase (warm-up, cool-down, deep sleep, maintain, pre-wake)
- Min/max horizontal dashed lines
- Bedtime/wake time pickers (input type="time")
- Chart updates reactively when presets or set points change
- Reference web: `src/lib/sleepCurve/generate.ts` for curve generation
- Reference iOS: `SmartCurveView.swift` for chart layout

### Step 4: Restructure web schedule page layout
**Files:** `src/components/Schedule/SchedulePage.tsx`
- Reorder: side selector → day picker → curve presets → chart → schedule toggle
- Remove inline set points / power / alarm sections (moving to sheet)
- Clean up spacing to match iOS visual rhythm
- Keep ScheduleWeekOverview at the bottom

### Step 5: Manual Controls as bottom sheet (web)
**Files:** New `ManualControlsSheet.tsx`, update `SchedulePage.tsx`
- Bottom sheet/drawer component (use Radix Dialog or custom CSS transform)
- Contains: TemperatureSetPoints, PowerScheduleSection, AlarmScheduleSection, ApplyToOtherDays
- "Manual Controls" button opens the sheet
- Sheet slides up, has a drag handle, dismissible by swipe or X
- All existing CRUD functionality preserved inside the sheet

### Step 6: iOS parity check
**Files:** `Sleepypod/Views/Schedule/ScheduleScreen.swift`, power/alarm compact views
- Power/alarm cards in the iOS disclosure should be editable (currently display-only)
- Add edit capabilities: tap to change time, toggle enable, adjust intensity
- Verify both platforms have identical capabilities
- Test: create schedule on web, verify it shows correctly on iOS, and vice versa

### Step 7: Commit + deploy both
- Commit core changes
- Commit iOS changes
- Push to pod + phone
- Verify end-to-end

## Current State
- Step 1: DONE — toggle bug fixed, creates default power schedule (on=22:00, off=07:00, temp=75) when none exists
- Step 2: DONE — CurvePresets.tsx created (Hot Sleeper / Balanced / Cold Sleeper horizontal scroll)
- Step 3: DONE (was already done) — CurveChart.tsx exists with recharts AreaChart
- Step 4: DONE — SchedulePage restructured: day selector → presets → time pickers + chart → toggle → manual controls sheet → week overview
- Step 5: DONE — ManualControlsSheet.tsx created (bottom sheet with drag-to-dismiss, contains set points/power/alarm/apply-to-days)
- Step 6: TODO — iOS parity check
- Step 7: TODO — Commit + deploy

## Reference Files
- Web schedule: `src/components/Schedule/SchedulePage.tsx`
- Web curve gen: `src/lib/sleepCurve/generate.ts`
- Web schedule hook: `src/hooks/useSchedule.ts`
- iOS schedule: `Sleepypod/Views/Schedule/ScheduleScreen.swift`
- iOS curve: `Sleepypod/Views/Schedule/SmartCurveView.swift`
- iOS profiles: `Sleepypod/Models/SleepProfile.swift`
