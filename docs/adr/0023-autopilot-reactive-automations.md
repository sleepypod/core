# ADR 0023: Reactive automations engine (Autopilot)

**Status:** Accepted
**Date:** 2026-06-07

## Context

Everything the Pod does on a timer today is **time-triggered**: a cron
expression feeds `node-schedule`, which feeds `JobManager`, which writes to
the hardware through `getSharedHardwareClient()`. Temperature curves, power
schedules, and alarms are all variations on "at time T, do X." There is no way
for the device to react to a *live signal* — to lower a setpoint because the
sleeper started moving, or to hold a temperature relative to room ambient as
the room warms through the night.

Eight Sleep ships exactly this feature ("autopilot") as an opaque black box:
the bed changes temperature and the user has no way to see why. For a DIY
system whose whole reason to exist is that the owner controls and understands
their hardware, that opacity is the thing to beat. The product wedge is
**transparency** — show *why* a rule fired (an audit log) and *what it would
have done* on a past night (a backtest), so the user can trust the engine
before handing it the thermostat.

The infrastructure a reactive engine needs already exists and is load-bearing
elsewhere: a shared FIFO hardware socket, a per-side mutex (`withSideLock`),
a liveness heartbeat with reboot recovery (the `JobManager` pattern), the
mutation-broadcast event bus (ADR 0015), and a typed live-signal surface from
the DAC monitor and biometrics modules. What is missing is an *evaluation
layer* that reads those signals and decides when to write — not new plumbing.

Two motivating examples bound the design; the engine must handle both:

1. **Continuous policy** — "During 23:00–06:00, hold my temp at `ambient + 3°F`."
   The setpoint is a function of a live signal, re-evaluated as ambient moves.
   Level-triggered, idempotent re-assertion while in-window.
2. **Edge-triggered rule** — "If movement averages > 200 over the last 10 min,
   lower temp by 2°F." A windowed aggregate crossing a threshold fires a
   one-shot action with a cooldown.

The user never picks "continuous" vs "edge" — the distinction is implied by
whether the action references a live signal. The engine handles both through a
per-rule `idle → active → cooldown` state machine.

## Decision

Build an `AutomationEngine` that sits **beside** `JobManager`, reads the same
signal buses, and writes through the same hardware path. No new hardware code.

### The rule model — WHEN / IF / THEN

A small, three-primitive model rather than a full visual programming language:

```text
Automation {
  id, name, enabled, side?, priority, cooldownMin?
  WHEN  trigger          // signal-change | tick | time-of-day
  IF    condition[]      // AND/OR/NOT guard tree
  THEN  action[]         // params may be expressions, e.g. ambient + 3
}
```

- Example 1 → WHEN `ambient.temperature changes` · IF `time 23:00–06:00`
  · THEN `set left.target = clamp(ambient + 3, min, max)`
- Example 2 → WHEN `tick (1m)` · IF `avg(left.movement, 10m) > 200`
  · THEN `set left.target -= 2` (cooldown 30m)

Conditions: numeric comparators, windowed aggregates
(`avg|max|min|sum|count(signal, last N min)`), time-of-day / day-of-week,
state/enum, `AND/OR/NOT`, plus stability primitives (`sustained for N min`
debounce and **hysteresis** with separate on/off thresholds so rules don't
chatter at a boundary). Actions are the existing device verbs
(`setTemperature`, `setPower`, `setLedBrightness`, alarm verbs, `setAwayMode`,
`startPriming`) plus a non-hardware `notify` action that is the safe default
for testing. Action params may be expressions with a visible clamp.

### Data model

Two tables, following `src/db/schema.ts` conventions, with the rule "AST" held
in JSON columns validated by zod at the tRPC boundary:

```text
automations(
  id, name, enabled, side? (left|right|null=both),
  priority, cooldownMin?, trigger(json), conditions(json), actions(json),
  createdAt, updatedAt )

automation_runs(
  id, automationId, firedAt,
  outcome(fired|skipped|clamped|dry_run|error), detail(json) )
```

`automation_runs` is the transparency surface — it is what answers "why did my
bed warm up at 3am." It is not optional telemetry; it is the product.

A tRPC `automations.*` router (CRUD + enable/dry-run + backtest), modelled on
`schedules.*`, hot-reloads the running engine on every write so changes take
effect without a restart (the `schedules.ts → JobManager` pattern).

### Safety stack (non-negotiable — this drives a device someone sleeps on)

- **Two-layer clamp** — every temperature expression is clamped first to the
  action's own `[min,max]` band, then unconditionally to the hardware bound
  55–110°F.
- **Anti-thrash** — a setpoint is only re-asserted when it moves ≥0.5°F. Bed
  temp slews 1–2°F/min, so spamming the pump with sub-threshold moves is
  pointless and harmful.
- **Runaway guard** — a per-rule actions/hour cap; tripping it auto-disables
  the rule and surfaces it in `/debug`.
- **Manual override wins** — touching the dial suspends autopilot on that side
  for a hold window; the engine logs `skipped` rather than fighting the user.
- **Kill switch & away mode** — a global, persisted off-switch
  (`device_settings.autopilotEnabled`) that short-circuits the tick and is
  restored at boot; away mode already disables a side.
- **Dry-run** — a rule can run notify-only for several nights, logging
  *would-fire* events without touching hardware, so the user builds trust
  before the engine controls the bed.

### Precedence stack (highest wins)

1. Manual override (timed hold)
2. Active run-once session *(existing)*
3. **Autopilot automations** (by `priority`, then most recent)
4. Recurring temperature/power schedules *(existing)*
5. Neutral default

Autopilot sits **above recurring schedules, below run-once and manual.** It is
realized without an explicit coordinator: the engine refuses to write a side
while `hasActiveRunOnceSession(side)` is true or a manual-override hold is
active (both log `skipped`); against recurring schedules it is last-writer-wins
on the shared `withSideLock(side)`, and because a continuous-policy rule
re-asserts its setpoint every tick, it wins the steady state. Constant-policy
rules are therefore the supported way to override a schedule.

### Resolved tunables (P0, 2026-06-07)

- **Manual-override hold** — `AUTOMATION_MANUAL_OVERRIDE_MS = 30 min`, in-memory
  per side. Cleared on reboot (safe default: autopilot resumes).
- **Evaluator cadence** — a single global 60s tick (`AUTOMATION_TICK_MS`) that
  also samples signals into the windowed-aggregate ring buffers. 60s matches
  the ambient/movement cadence and sits well under the thermal slew, so a
  coarser tick loses nothing while avoiding pump spam. Per-signal cadence is a
  later refinement.
- **Clamp band** — the per-action `clamp {min,max}` (default
  `AUTOMATION_DEFAULT_USER_MIN/MAX = 60/100°F`) is layer 1; the hardware bound
  55–110°F is layer 2, always applied. No new global per-user setting in P0 —
  the per-action band is strictly inside the hardware range and is the smallest
  surface that satisfies the two-layer requirement.

### UI — structured forms, not a node graph

`@xyflow/react` is already a dependency but read-only (`DataPipeline.tsx`);
`dnd-kit` is not installed. v1 is **structured WHEN/IF/THEN forms** with a live
plain-English sentence preview, not a node-graph canvas. The builder uses the
typed signal catalog to offer only valid operators per signal. The backtest
panel — pick a past night, overlay the signal trace with fire markers and the
resulting setpoint line — is the centerpiece, because it is the trust-builder
that a black-box competitor cannot offer. A `/debug` status panel shows live
per-rule state, the run log, the kill switch, and per-rule dry-run.

## Alternatives Considered

### 1. Extend the existing scheduler instead of a parallel engine

Bolt reactive triggers onto `JobManager`.

**Rejected.** `JobManager` is built around cron → fire-once semantics with a
liveness model tuned to that. Reactive rules need a continuous evaluator,
windowed buffers, and a per-rule state machine — a different lifecycle. Forcing
both into one component couples two concerns that fail differently. A parallel
engine that *shares the hardware path and locks* gets the reuse without the
coupling.

### 2. A full visual programming language

Let users compose arbitrary logic blocks.

**Rejected for v1.** WHEN/IF/THEN with expression params and AND/OR/NOT covers
both motivating examples and the foreseeable ones. A general language is more
surface to validate, secure, and explain — against a transparency-first product
goal it is a net negative until a concrete need exists.

### 3. Node-graph builder (drag-and-drop canvas)

`@xyflow/react` is already in the tree.

**Deferred, not rejected.** A node canvas is a plausible future for advanced
multi-condition logic, but it needs `dnd-kit` (a new dependency) and is a much
larger UI surface. Structured forms + a sentence preview ship the value now;
the node graph can come later without changing the engine or data model.

### 4. New dedicated hardware write path for autopilot

Give the engine its own client to avoid contending on the shared socket.

**Rejected.** The shared FIFO socket, per-side mutex, and mutation broadcast
exist precisely to serialize all writers. A second path would reintroduce the
race conditions those primitives were built to remove and would bypass the
mutation broadcast the UI depends on. The engine is just another writer on the
existing lock.

### 5. Explicit coordination with recurring schedules

Have the engine read the schedule table and negotiate who owns a side.

**Rejected for P0.** Last-writer-wins on the shared side lock already produces
the desired "autopilot above schedules" behavior, because a continuous-policy
rule re-asserts every tick. Explicit negotiation adds a stateful coupling
between two subsystems for a case the lock already resolves. Revisit only if a
concrete conflict appears that last-writer-wins gets wrong.

### 6. A global per-user temperature band setting in P0

Add a `device_settings` min/max consulted by every clamp.

**Deferred.** The per-action clamp band is strictly inside the hardware range
and satisfies the two-layer safety requirement today. A global band is a
strictly-additive change later — it can replace the default without touching
the engine — so shipping it in P0 is premature surface.

## Consequences

### Positive

- Adds reactive automation as an evaluation layer over existing, battle-tested
  plumbing — shared client, side mutex, mutation broadcast, liveness recovery —
  rather than new hardware code.
- The `automation_runs` audit log plus the backtest panel deliver the
  transparency wedge the black-box competitor structurally cannot match.
- The safety stack (two-layer clamp, anti-thrash, runaway guard, manual
  override, kill switch, dry-run) is defense-in-depth on a device someone
  sleeps on, with the conservative default at every layer.
- z-score conditions ("HR > baseline + 2σ") are nearly free —
  `getVitalsBaseline` already returns mean and SD — giving an anomaly-detection
  capability for little extra cost once vitals signals are wired.

### Negative / costs

- A second long-lived background component beside `JobManager` to operate,
  observe, and reason about during incidents. Mitigated by sharing the locks
  and the `/debug` status panel.
- Both motivating examples depend on expression evaluation and windowed
  aggregates (the "P2" capability set). The engine supports them; what gates
  them firing on live data is the **signal-source wiring**, not the engine.
- The engine handles **numeric** signals only. The builder's catalog is
  therefore the numeric/backtestable subset; enum/bool signals (sleep stage,
  occupancy) in the full catalog read `undefined` → "skip" until their sources
  are wired. This is the safe degradation, but it means the shipped builder is
  intentionally a subset of the documented catalog.

### Open questions

- **Live signal coverage.** P0/P1 wire only the reliably-available device
  signals (per-side temperature/level, `water.low`). Biometric, ambient, and
  enum/bool signals read `undefined`→skip until their readers land. Active
  rules can only fire on what is wired; backtests already replay the full
  recorded series. Tracked as the next phase.
- **Per-signal cadence.** A single 60s tick is correct for the current signal
  set; faster-moving signals may later justify per-signal sampling.
- **Per-side target history is not persisted**, so edge-mode backtests compute
  setpoints relative to a nominal baseline rather than the true historical
  target. Called out at the backtest boundary; revisit if it proves misleading.

## References

- Beside `JobManager`: `src/scheduler/jobManager.ts`,
  `src/scheduler/instance.ts`.
- Engine: `src/automation/` (`engine.ts`, `evaluator.ts`, `expressions.ts`,
  `windows.ts`, `signals.ts`, `backtest.ts`, `types.ts`, `instance.ts`).
- Router + validation: `src/server/routers/automations.ts`,
  `src/server/validation-schemas.ts`.
- Kill-switch column: `device_settings.autopilotEnabled` (migration 0014).
- Mutation-broadcast event bus: ADR 0015.
- Vitals baseline (z-score source): `getVitalsBaseline`.
- UI: `app/[lang]/autopilot/`, `src/components/Autopilot/`,
  `src/components/diagnostics/DiagnosticsConsole.tsx`.
