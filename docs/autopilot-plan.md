# Autopilot — User-Built Automations: Build Plan

Status: planning → ready to build
Branch context: worktree `diy-autopilot` (branch `pr-624`)
Last updated: 2026-06-07

## TL;DR

Everything today is **time-triggered** (cron → `node-schedule` → `JobManager` →
hardware). "Autopilot" adds a **reactive rules engine** that responds to live
signals. It sits beside `JobManager`, reads the same signal buses, and writes
through the same `getSharedHardwareClient()` + `broadcastMutationStatus()` path.
The infrastructure (shared FIFO socket, per-side mutex, liveness heartbeat,
mutation broadcast, typed signal catalog) already exists — we add an evaluation
layer + a builder UI, not new plumbing.

**Differentiator vs Eight Sleep autopilot:** transparency. Eight Sleep's is an
opaque black box. Ours shows *why* a rule fired (audit log) and *what it would
have done* (backtest chart). That is the product wedge — design for it.

## Two motivating examples (the engine must handle both)

1. **Continuous policy** — "During 23:00–06:00, hold my temp at `ambient + 3°F`."
   The setpoint is a *function of a live signal*, re-evaluated as ambient moves.
   Level-triggered / idempotent re-assertion while in-window.
2. **Edge-triggered rule** — "If movement averages > 200 over last 10 min, lower
   temp by 2°F." Windowed aggregate crossing a threshold fires a one-shot action.

The engine handles both via a per-rule state machine. Users don't see the
distinction — it's implied by whether the action references a live signal.

---

## 1. The model (the "language")

Three primitives — **WHEN / IF / THEN** — plus **expressions** for action params.
Not a full visual programming language.

```
Automation {
  id, name, enabled, side?, priority, cooldownMin?
  WHEN  trigger          // signal-change | tick | time-of-day
  IF    condition[]      // AND/OR/NOT guards
  THEN  action[]         // params may be expressions (e.g. ambient + 3)
}
```

Example 1 → WHEN `ambient.temperature changes` · IF `time between 23:00–06:00`
· THEN `set left.target = clamp(ambient + 3, myMin, myMax)`

Example 2 → WHEN `tick (1m)` · IF `avg(left.movement, 10m) > 200`
· THEN `set left.target -= 2` (cooldown 30m)

---

## 2. What we expose

### Signals (read-only inputs) — typed catalog

Each signal carries: type, unit, freshness/cadence, per-side flag. The builder
uses this metadata to offer only valid operators.

| Signal | Type | Cadence | Source (verified in repo) |
|---|---|---|---|
| `ambient.temperature` | °F/°C | ~60s | `roomClimate.temperatureC` / `bedTemp.ambientTemp` |
| `ambient.humidity` | % | ~60s | `bedTemp.humidity` |
| `ambient.light` | lux | sensor-dep | `environment.getAmbientLight` |
| `{side}.currentTemperature` / `targetTemperature` | °F | ~2s | device status frame |
| `{side}.currentLevel` | -100..100 | ~2s | device status frame |
| `{side}.occupied` / `available` | bool | real-time | `biometrics.getOccupancy` |
| `{side}.movement` | score 0–1000 | 60s + windowed | `getMovement` / `getMovementBuckets` |
| `{side}.heartRate` / `hrv` / `breathingRate` | bpm/ms/brpm | ~5min | `getVitals` |
| `{side}.{vital}.zscore` | σ vs 30d | derived | `getVitalsBaseline` (mean/SD) |
| `{side}.sleepStage` | wake/light/deep/rem | epoch | `getSleepStages` |
| `water.level` | low/ok | event | `waterLevel` |
| `clock` / `dayOfWeek` | time/enum | — | timezone-aware (see `timeUtils.ts`) |

Note: `zscore` conditions (e.g. "HR > baseline + 2σ") are nearly free —
`getVitalsBaseline` already returns mean + SD. Good anomaly-detection wedge.

### Operators / conditions

- Numeric: `> >= < <= == between changed-by`
- **Windowed aggregate** (key primitive for example 2): `avg | max | min | sum | count(signal, last N min)`
- Time: `between HH:MM–HH:MM`, `on [days]`
- State/enum: `occupied`, `sleepStage is deep`, `water.level == low`
- Combinators: `AND / OR / NOT`
- Stability: `sustained for N min` (debounce); **hysteresis** (separate on/off thresholds) — required so rules don't chatter at the boundary.

### Actions (writes) + expression parameters

| Action | Params (literal or expression) | Backed by |
|---|---|---|
| `setTemperature` | `temp = ambient + 3`, `clamp(lo,hi)`, `duration?` | `device.setTemperature` |
| `setPower` | on/off, temp? | `device.setPower` |
| `setLedBrightness` | 0–100 | `SET_SETTINGS` `lb` key |
| `setAlarm` / `clearAlarm` / `snoozeAlarm` | intensity, pattern, duration | `device.*Alarm` |
| `setAwayMode` | bool | side settings |
| `startPriming` | (guarded: only if unoccupied) | `device.startPriming` |
| `notify` | message — **non-hardware, safe default for testing** | new |

Action modifiers: `for-duration then-revert`, `cooldown N min`, `only-if-occupied`.

---

## 3. Safety & precedence (must not be hand-waved)

Drives a device someone sleeps on. Non-negotiables:

- **Two-layer clamp** — every temp expression clamped to per-user `[min,max]`,
  then to hardware 55–110°F.
- **Anti-thrash** — only re-assert a setpoint when it moves ≥0.5°F (temp changes
  1–2°F/min; spamming the pump is pointless). Reuse the existing 200ms debounce;
  add a per-rule rate cap.
- **Runaway guard** — max actions/hour per automation; trip → auto-disable +
  surface in `/debug`.
- **Manual override wins** — user touching the dial suspends autopilot for that
  side ~30–60min (or until next session). Mirror the existing run-once gate
  (`hasActiveRunOnceSession()`).
- **Kill switch & away mode** — global autopilot off; away mode already disables
  per side.
- **Dry-run mode** — rule runs "notify-only" for a few nights, logging
  *would-fire* events without touching hardware. Trust before handing over the
  thermostat.

### Precedence stack (highest wins) — proposed, confirm before P0

1. Manual override (timed hold)
2. Active run-once session *(existing)*
3. **Autopilot automations** (by `priority`, then most-recent)
4. Recurring temperature/power schedules *(existing)*
5. Neutral default

OPEN QUESTION: should an autopilot rule be allowed to override a recurring
schedule, or coexist? Proposed: autopilot sits above schedules but below
run-once and manual. Confirm.

---

## 4. Data model & engine integration

### New tables (mirror `src/db/schema.ts` conventions; JSON columns hold the rule "AST", validated by zod)

```
automations (
  id            integer pk autoincrement
  name          text not null
  enabled       boolean not null default true
  side          text enum(left,right) nullable     -- null = both/system
  priority      integer not null default 0
  cooldownMin   integer nullable
  trigger       text (json) not null
  conditions    text (json) not null               -- AST, AND/OR/NOT tree
  actions       text (json) not null               -- AST, with expression params
  createdAt     integer timestamp
  updatedAt     integer timestamp
)

automation_runs (                                  -- audit log → powers transparency
  id            integer pk autoincrement
  automationId  integer fk
  firedAt       integer timestamp
  outcome       text enum(fired,skipped,clamped,dry_run,error)
  detail        text (json)                         -- evaluated values, action result
)
```

The `automation_runs` log is what answers "why did my bed warm up at 3am" — the
transparency Eight Sleep lacks.

### New `AutomationEngine` (beside `JobManager`)

- **Time-triggered** automations → register cron jobs (reuse `node-schedule`,
  exactly like today).
- **State-triggered** → subscribe to the existing event bus / DacMonitor stream
  + a periodic evaluator tick (~30–60s, matching biometrics cadence).
- Shares `getSharedHardwareClient()`, `withSideLock()` per-side mutex,
  `broadcastMutationStatus()`, and the liveness-heartbeat recovery pattern.
  **No new hardware path.**
- Per-rule state machine: idle → active → cooldown. Persist state across reboot
  (mirror jobManager liveness pattern; restore on startup).
- tRPC `automations.*` router (CRUD + `test`/backtest + `enable`), parallel to
  `schedules.*`. Reuse zod validation-schemas conventions.

### Key files to touch / create (verified locations)

- `src/db/schema.ts` — add the two tables + migration in `src/db/migrations/`.
- `src/server/routers/automations.ts` — new router (model on `schedules.ts`).
- `src/server/validation-schemas.ts` — add automation AST zod schemas.
- `src/automation/` (new dir) — `engine.ts`, `evaluator.ts`, `expressions.ts`,
  `types.ts`, `windows.ts` (windowed-aggregate buffers).
- `src/automation/instance.ts` — singleton getter (mirror `scheduler/instance.ts`).
- Wire engine startup alongside `getJobManager()` boot.
- `app/[lang]/autopilot/` — page.
- `src/components/Autopilot/` — builder + backtest components.
- `src/hooks/useAutopilot.ts` — editor state, save/load.
- `src/components/diagnostics/DiagnosticsConsole.tsx` — add Autopilot status panel.

---

## 5. UI plan

`@xyflow/react` is in deps (read-only in `DataPipeline.tsx`); `dnd-kit` is NOT
installed. Decision: **structured WHEN/IF/THEN forms, not a node-graph canvas**
for v1. Node graph is a possible Phase-3, not the start.

### Screens (priority order)

1. **Automations list** — cards/table. Per row: name, rule rendered as a
   plain-English sentence, side, enabled toggle, last-fired, dry-run/active
   badge. "New" CTA + empty state.
2. **Rule editor** (full-screen modal, mirrors `Schedule/CurveEditor.tsx`) —
   WHEN / IF / THEN sections, typed pickers (valid operators per signal), and:
   - **Live natural-language sentence preview** that assembles as you build.
   - Action params accept **expressions** (`ambient + 3`) with a visible clamp
     control.
3. **Backtest panel** (the centerpiece) — pick a past night; recharts overlay of
   the signal trace + markers where the rule would fire + resulting setpoint
   line. This is the trust-builder.
4. **Autopilot status panel** in `/debug` — live per-rule state (next/last fire,
   current evaluated value vs threshold), run log, global kill switch, per-rule
   dry-run toggle.

### Stack to match

Dark theme only; zinc/slate + one accent. Tailwind v4. `@base-ui/react` headless
primitives. `lucide-react` icons. `class-variance-authority`. Charts: **recharts
only**. Reuse `src/ui/` `Card`/`Button`/`Badge`/`Tabs`/`DataTable`. Editors =
full-screen modal w/ local state until explicit Save (no autosave).

A ready-to-use system prompt for designing this UI in claude.ai lives in the
appendix below.

---

## 6. Phasing

- **P0 — Engine + model.** Tables, migration, zod AST, `AutomationEngine`,
  precedence, two-layer clamp, anti-thrash, runaway guard, dry-run, audit log.
  Ship with notify-only actions + a couple hardcoded rules to validate. No UI.
- **P1 — Structured builder + backtest.** Form UI, sentence preview, recharts
  backtest, enable/disable, `/debug` panel.
- **P2 — Expressions & windowed aggregates.** `ambient + Y`, `avg(movement,10m)`,
  hysteresis, baseline z-scores. (Both motivating examples need P2.)
- **P3 — Node-graph builder** for advanced multi-condition logic (optional).

---

## Open decisions — RESOLVED for P0 (2026-06-07)

1. **Precedence — RESOLVED: autopilot sits above recurring schedules, below
   run-once + manual.** The engine refuses to write a side while
   `hasActiveRunOnceSession(side)` is true or a manual-override hold is active
   (those outcomes log `skipped`). It does not coordinate with recurring
   temperature/power schedules at write time — last-writer-wins on the shared
   `withSideLock(side)` — which realizes "above schedules" in practice: an
   enabled autopilot rule re-asserts its setpoint each tick and wins the steady
   state. Constant-policy rules are therefore the supported way to override a
   schedule.
2. **Manual-override hold — RESOLVED: 30 min in-memory hold per side.**
   `AUTOMATION_MANUAL_OVERRIDE_MS = 30 * 60_000`. `registerManualOverride(side)`
   is the hook a router/gesture handler calls when the user touches the dial;
   the engine skips that side until the hold expires. In-memory (cleared on
   reboot — safe default: autopilot resumes).
3. **Evaluator cadence — RESOLVED: single global 60s tick** (`AUTOMATION_TICK_MS`)
   plus a per-tick signal sample feeding the windowed-aggregate ring buffers.
   60s aligns to the ambient/movement cadence and is well below the 1–2°F/min
   thermal slew, so a coarser tick loses nothing while avoiding pump spam.
   Per-signal cadence is a P2+ refinement, not needed for either motivating
   example.
4. **Clamp source — RESOLVED: per-action clamp band, default `[60,100]°F`.**
   Layer 1 is the action's own `clamp {min,max}` (defaults to
   `AUTOMATION_DEFAULT_USER_MIN/MAX` = 60/100°F when omitted); layer 2 is the
   hardware bound 55–110°F applied unconditionally. No new global setting in
   P0 — the per-action band is strictly inside the hardware range and is the
   smallest surface that satisfies the two-layer requirement. A global per-user
   band can replace the default in a later phase without changing the engine.

---

## Appendix A — UI design system prompt (for claude.ai artifacts)

````markdown
# Role
You are a senior product designer + front-end engineer designing the UI for
**Autopilot**, a user-built automation feature for a DIY smart sleep system (a
temperature-regulated mattress pad with biometric sensors). Produce React +
Tailwind artifacts. Favor clean, dense, desktop-first interfaces. State layout
reasoning in one line per decision.

# Product context
The device heats/cools each side of the bed (55–110°F) and reads live sensors
(ambient temp, movement, heart rate, occupancy, sleep stage). Today users only
get time-based schedules. Autopilot adds reactive rules.
Two examples the UI must make easy:
1. "During 23:00–06:00, hold my temp at ambient + 3°F." (continuous policy)
2. "If movement averages > 200 over 10 min, lower temp by 2°F." (edge-triggered)
Differentiator: the competitor's autopilot is an opaque black box. Ours must be
transparent — users see why a rule fired and what it would have done.

# Rule model (what the builder edits): WHEN / IF / THEN
- WHEN: trigger (signal changes | periodic tick | time of day)
- IF: conditions combined with AND/OR/NOT
- THEN: actions; params can be expressions (e.g. ambient + 3)
Plus: name, enabled, side (left/right/both), priority, cooldown.

## Signals (condition/trigger dropdowns)
ambient.temperature(°F), ambient.humidity(%), ambient.light(lux),
{side}.currentTemperature/targetTemperature(°F), {side}.occupied(bool),
{side}.movement(0–1000), {side}.heartRate(bpm)/hrv(ms)/breathingRate(brpm),
{side}.{vital}.zscore(σ vs 30d baseline), {side}.sleepStage(wake/light/deep/rem),
water.level(low/ok), clock, dayOfWeek.

## Operators
Numeric > >= < <= == between changed-by; windowed avg|max|min|sum|count(signal,last N min);
time between HH:MM–HH:MM, on [days]; stability sustained for N min + hysteresis.

## Actions
setTemperature (literal °F or expression like ambient+3, clamped to user min/max),
setPower(on/off), setLedBrightness(0–100), setAlarm/clearAlarm/snoozeAlarm,
setAwayMode, startPriming, notify(message — the safe no-hardware action).
Modifiers: for [duration] then revert, cooldown [N min], only if occupied.

# Design system (match exactly)
Dark theme only. Zinc/slate neutrals, near-black bg, one accent. Subtle borders,
no heavy shadows. Tailwind v4. Headless primitives like @base-ui/react (you style
them). lucide-react icons. class-variance-authority. Charts: recharts only
(LineChart/AreaChart/ResponsiveContainer). Reuse component shapes: Card, Button,
Badge, Tabs, sortable DataTable. Editors = full-screen modal, local state until
explicit Save (no autosave). Dashboards = left side-nav + dense content pane,
full-bleed. Per-side (left/right) is everywhere. Temp displays in °F or °C.

# Screens (priority order)
1. Automations list — cards/table: name, rule as plain-English sentence, side,
   enabled toggle, last-fired, dry-run/active badge, New CTA, empty state.
2. Rule editor (full-screen modal) — WHEN/IF/THEN sections, typed pickers (valid
   operators per signal), prominent live natural-language sentence preview, and
   action params that accept expressions (ambient+3) with a clamp control.
3. Backtest panel — pick a past night; recharts overlay of signal trace + markers
   where the rule would have fired + resulting setpoint line. The centerpiece.
4. Autopilot status panel (diagnostics console) — live per-rule state (next/last
   fire, evaluated value vs threshold), recent run log, global kill switch,
   per-rule dry-run toggle.

# Constraints
Safety is visible (clamps, cooldowns, dry-run, manual-override indicator). No
node-graph canvas for v1 — structured forms + sentence preview. Keep to the stack
above; flag + justify any new dependency. Composable, typed components, realistic
mock data (real signal names, plausible nighttime values).

Start with the Rule editor (hardest), then the list, then backtest. Ask before
assuming layout specifics you're unsure about.
````
