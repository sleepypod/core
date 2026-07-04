# ADR 0022: Pump stall safety guard and conditional thermal cross-check

**Status:** Proposed
**Date:** 2026-05-25

## Context

The Pod's hub-mounted water temperature sensor sits in the same housing
as the heating and cooling elements. When the circulation pump runs, the
sensor reads the temperature of moving water that has just left the bed
— a meaningful number. When the pump stalls, the sensor reads stagnant
water sitting next to powered heating/cooling elements — a runaway
number that does not reflect what is happening in the bed.

A free-sleep user reported this exact failure mode on 2026-05-24: their
side ran away to 102°F overnight against an 84°F setpoint, the temperature
appeared to fluctuate wildly when the UI refreshed, and a power cycle
cleared it. The most consistent explanation is a stalled pump: water
near the heater stagnates and reads hot at the hub, the control loop
either responds to the high reading with aggressive cooling or simply
displays the misleading value, and the user is woken by the alert /
overcorrection. The bed itself was probably not at 102°F; the sensor
was.

We use the same hardware. This is plausible on sleepypod-core too.

The existing scaffolding partially detects this:
`DeviceStateSync.checkFlowAnomalies` (`src/hardware/deviceStateSync.ts:250`)
already flags pump-running-but-no-flow with a rate-limited `console.warn`.
What it does not do:

- intervene in the temperature command path,
- persist anomalies anywhere a user can see them,
- allow user-tunable thresholds (constants are hard-coded),
- gate detectors on "should this side be circulating right now," so
  `flow_asymmetry` would false-trip any time one side is off.

Live data from `eight-pod` confirms the signal is clean:

- pump running, steady state: 1940–2010 RPM (±10 jitter)
- pump idle: exactly 0 RPM, every row, no warm-up ramp
- the gap between healthy and stalled is ~1900 RPM

The hard-coded `PUMP_FAILURE_RPM_MIN = 50` is therefore safe but
needlessly conservative; any threshold from 200 to 1800 separates the
two states.

Live data also shows the field labelled `flowrate` is **not** volumetric
flow — it reads non-zero (≈26°C) when both pumps are at 0 RPM and barely
changes when they spin up. It is the loop water temperature in
centidegrees C. This is useful for clog detection (compare loop temp to
bed temp under load) but useless for stall detection.

## Decision

Build a `pumpStallGuard` module that owns three coordinated jobs:

1. **Stall detection** — derived from pump RPM, gated on "side commanded
   active," with settings-driven thresholds and sample-based dwell.
2. **Fail-safe power-off** — on confirmed stall, push `setPower(side,
   false)` directly to the hardware. The side is fully de-energized
   until a human re-enables it. Auto-recovery is opt-in.
3. **Conditional cross-check** — when the pod ships bed surface
   thermistors (Pod 4 and Pod 5 cover variants observed; Pod 3 to be
   probed at runtime, not assumed), compare hub temp against bed center
   temp and downgrade the hub reading when they diverge implausibly.

### Settings (new columns on `device_settings`)

```ts
pumpStallProtectionEnabled:   integer({ mode: 'boolean' }).notNull().default(true),
pumpStallRpmThreshold:        integer().notNull().default(500),  // user-tunable 100–1500
pumpStallDwellSamples:        integer().notNull().default(2),    // consecutive sub-threshold frames
pumpStallAutoRecoveryEnabled: integer({ mode: 'boolean' }).notNull().default(false),
pumpStallRecoveryRpm:         integer().notNull().default(1500), // only consulted when auto-recovery is on
pumpStallRecoverySamples:     integer().notNull().default(3),    // healthy frames required before auto-restore
```

Auto-recovery is off by default. The fail-safe mode is "stay off until
a human acknowledges." A pump that stalled once unexpectedly is a
hardware-fault signal, and silently re-enabling at 3am to retry is
exactly the behavior that produces a repeat of the original incident.
Putting recovery behind an explicit setting forces the user to opt in
to that risk after seeing the alert — same model as a furnace
high-limit switch requiring a manual reset.

Dwell is measured in consecutive frames, not wall-clock seconds, because
`recordFlowData` is rate-limited to one write per 60s. Two consecutive
sub-threshold frames covers a single dropped frame and is ~2 minutes of
real time, which is well within the safety budget for stagnant heating
near the hub.

### Alerts (new table `pump_alerts`)

Clone of `water_level_alerts`:

```ts
type: text({ enum: ['stall_left', 'stall_right',
                    'no_flow_left', 'no_flow_right',
                    'asymmetry', 'clog_suspected',
                    'hub_temp_disputed'] }),
side: 'left' | 'right' | null,
rpm: integer(),
flowrateCd: integer(),
durationSeconds: integer(),
action: text({ enum: ['power_off', 'auto_recovered', 'warned', 'none'] }),
acknowledgedAt: integer({ mode: 'timestamp' }),  // user re-enabled the side
dismissedAt: integer({ mode: 'timestamp' }),
```

Persistent and dismissible. Surfaces in the existing alert banner.

### Bed temp cross-check — capability-gated

The hub-vs-bed cross-check is a redundancy layer, not the primary
defense. Bed center thermistors exist on most cover hardware we have
verified, but we have not verified all variants and we do not assume.

Follow the existing probe-first capabilities pattern
(`scripts/pod/capabilities`): determine sensor availability from data,
not from `POD_GEN`. At guard startup and every N minutes:

```
hasBedCenterSensors = exists row in bed_temp within last 10 min
                      where left_center_temp IS NOT NULL
                      AND right_center_temp IS NOT NULL
```

When `hasBedCenterSensors` is false, the guard runs RPM-only and the
cross-check layer is disabled silently. When true, the guard also flags
"hub temp disputed" whenever:

- pod is commanded active,
- hub-reported current temp diverges from the matching bed center temp
  by more than 5°C for ≥2 consecutive frames,
- pump RPM is healthy (so this is genuinely a sensor disagreement, not
  a stall already caught upstream).

A "hub temp disputed" alert does not trigger cutoff on its own — it
suppresses aggressive control response (don't max-cool because of one
runaway reading), and it surfaces the discrepancy in the UI. Cutoff
remains stall-driven; cross-check is for sensor sanity.

### Control intervention

`pumpStallGuard.shouldBlock(side)` is consulted at three points:

- `device.setTemperature` (`src/server/routers/device.ts:232`),
- `device.setPower` when raising a side,
- `temperatureKeepalive` re-issue path (`src/services/temperatureKeepalive.ts`).

On a confirmed stall, the guard:

1. issues `setPower(side, false)` directly via the hardware client,
2. writes a `pump_alerts` row with `action: 'power_off'`, capturing the
   pre-stall target temperature and duration in the row so a later
   acknowledgement can restore them,
3. emits an event on the existing bus so the UI banner updates immediately,
4. parks the side. No further commands to that side are accepted until
   either the user acknowledges the alert or auto-recovery (if enabled)
   restores it.

**Acknowledgement path (always available, default fail-safe).** The
alert banner shows the side, the RPM at trip, and a re-enable button.
Tapping it stamps `acknowledgedAt`, restores the pre-stall target +
duration via the normal command path, and clears the guard's per-side
stall flag. If RPM is still bad, the guard will simply re-trip on the
next frame — the user has not bypassed the protection, only retried.

**Auto-recovery path (opt-in via `pumpStallAutoRecoveryEnabled`).** When
enabled, the guard watches for `pumpStallRecoverySamples` consecutive
frames at or above `pumpStallRecoveryRpm` (default 3 healthy frames ≈
3 minutes of stable circulation). On recovery, restore the pre-stall
target + duration, write `action: 'auto_recovered'` to the alert row,
and surface a less-prominent "side restored" notification — the user
should still see that something happened overnight even if they did not
have to intervene.

Hysteresis between trip and recovery thresholds (500 vs 1500 RPM)
prevents flapping. The 3-frame recovery dwell prevents a single
favorable sample during a flaky stall from prematurely restoring
heating.

### HomeKit and HA exposure

- **HomeKit:** per-side `LeakSensor` accessory (`pumpHealthSensor.ts`,
  mirroring `ambientSensor.ts`). `LeakDetected` is the natural automation
  trigger and surfaces as a red alert in the Home app. RPM is not
  exposed to HomeKit — a number with no setpoint context is meaningless
  to a Home-app user, and the Fan service invites taps that do nothing.
- **Home Assistant via MQTT bridge:** publish raw signals so power users
  can chart, threshold, and automate themselves:

  ```
  sleepypod/pump/{side}/rpm              numeric, unit: rpm
  sleepypod/pump/{side}/loop_temp_c      numeric, unit: °C  (the misnamed "flowrate")
  sleepypod/pump/{side}/stall            binary, device_class: problem
  sleepypod/pump/{side}/clog_detected    binary, device_class: problem
  sleepypod/pump/{side}/hub_temp_disputed  binary, device_class: problem
  ```

### Clog detection (separate, lower priority)

Different signal, same alert sink. A nightly job in the existing
biometrics-pruner timer computes rolling 7-day median loop temp delta
(loop temp − bed center temp under active heating). When the latest
window exceeds the 90-day median by more than the calibrated tolerance,
write a `clog_suspected` alert. No control action — surfaces a "time to
clean your pod" banner with the chart. Capability-gated identically to
the cross-check.

## Alternatives Considered

### 1. Trust the hub temp sensor alone (status quo)

The control loop responds to whatever the firmware reports. This is what
failed in the incident report: the hub said 102°F, and either the
firmware or the user-visible UI acted on it.

**Rejected.** A single sensor near powered elements with no flow gating
is not a defensible safety surface. The hardware will keep being the
hardware; the protection layer needs to live in our control plane.

### 2. Hardware watchdog only (no software response)

The pump and elements share a power rail; in principle the firmware
could detect a stall and cut the heater itself. We do not control the
firmware. Even if a future firmware shipped this, it would only protect
the firmware-local control loop — it would not stop our scheduler from
re-commanding heat on the next cycle.

**Rejected** as a sole defense. Welcome as an additional layer if it
arrives.

### 3. Universal bed-temp cross-check, no capability gate

Simpler implementation. Assume all hardware has center thermistors and
just read them.

**Rejected.** Pod 3 hardware variants, refurbished units, and cover-only
configurations are known to exist in the field with sparse sensor
coverage. Hard-coding the assumption produces silent false positives or
null-dereference bugs on the pods that need this feature most. The
probe-first pattern in `scripts/pod/capabilities` is the project's
established answer to this exact class of question; apply it here.

### 4. Cutoff via `setTemperature(side, 0, 0)` instead of `setPower(false)`

Push the side to neutral but keep it powered on. The argument was that
this preserves scheduled state for clean recovery once the pump returns.

**Rejected.** "Neutral" still expects circulation — the pump is still
supposed to be running and the elements are still on the same power
rail. A stalled pump is a hardware fault, and the safe response to a
hardware fault is to de-energize, not to hold at a different setpoint.
More importantly, leaving the side "on" enables the original failure
mode to repeat: the next scheduled adjustment, keepalive re-issue, or
auto-recovery would silently re-engage heating against a still-stalled
pump. Hard power-off forces a deliberate re-enable — either by an
opted-in auto-recovery path that has confirmed sustained healthy RPM,
or by a human who has seen the alert.

### 5. Auto-recovery enabled by default

Once the pump returns to healthy RPM, automatically restore the
pre-stall state. Less disruption to the user.

**Rejected as default.** A pump that stalled once is showing a fault
signal we do not understand yet. Auto-restoring at 3am sets up the same
incident to repeat the next night, with the user no better informed.
The setting exists for users who have a known-flaky pump and would
rather risk re-trips than wake up cold, but the default must be the
conservative "stay off until acknowledged" mode.

### 6. Aggressive cooling instead of cutoff on hub-disputed reading

Treat a high hub reading as a real reading and cool harder, on the
theory that being too cold is safer than being too hot.

**Rejected.** This is what likely woke the user in the original
incident. If the bed is actually at 84°F and the hub falsely reads
102°F, max-cooling overshoots in the other direction and is its own
hazard. Cutoff (neutral) is the correct conservative response to a
sensor reading we have evidence to distrust.

### 7. Trip the safety on a single bad RPM sample

Lower latency. Avoids the 2-minute dwell.

**Rejected for the default.** The frame cadence is 60s — a single
dropped or malformed frame would false-trip. The settings expose
`pumpStallDwellSamples` for operators who want to tune this down once
they have confidence in their hardware, but the default must tolerate
the wire protocol's actual reliability.

## Consequences

### Positive

- Closes a real safety gap that has bitten free-sleep users.
- Builds on existing detectors rather than replacing them — the work is
  promotion (warn → persistent alert → control action) plus settings.
- Capability gating keeps Pod 3 and uncommon variants supported without
  branching by `POD_GEN`.
- HomeKit `LeakSensor` per side gives users a first-class automation
  surface ("turn off pod, send notification, run scene") that the
  existing tRPC and MQTT paths cannot provide.

### Negative

- Adds a new failure mode: false-positive stall detection powers down a
  healthy pod, and with auto-recovery off (default), the user wakes up
  to a cold bed and an unread alert. This is the cost of the fail-safe
  default — it is the correct tradeoff against the alternative (a
  stalled pump heating stagnant water unattended) but it will produce
  bad nights when the detector is wrong. Mitigations are the
  dwell-samples default, the per-pod sparkline in settings so users can
  pick thresholds from real data, and the auto-recovery opt-in for
  users who would rather risk a re-trip than risk a cold night.
- Settings UI grows. We have been adding to it steadily; this is another
  section. Worth doing because the alternative (hard-coded thresholds)
  has the false-positive risk above and no escape hatch.
- The `flowrate` field is misnamed in `flow_readings`. This ADR does not
  rename it — that is a separate small task touching the schema, the
  router, the chart, and the MQTT topic name. Until it ships, this ADR
  treats `flowrateCd` as loop temp where it matters.

### Open questions

- Empirical threshold defaults. The 500 RPM / 2-sample / 1500 RPM
  recovery numbers come from one pod (`eight-pod`, Pod 5 cover). Before
  GA, sample at least one Pod 3 and one Pod 4 to confirm the running
  RPM distribution. If running RPM differs materially across gens, the
  default may need to be a percentage of observed steady-state rather
  than a fixed number.
- Whether the keepalive path can race the guard. The guard sets level 0;
  the keepalive may re-issue the user's commanded level on the next
  tick. Resolution: keepalive consults the guard before re-issuing
  (already in the design above), but this needs a test.
- Clog tolerance value. The 25%-below-90-day-median threshold is a
  placeholder. Needs data from a pod with a known clog episode to
  calibrate, or a longer in-field bake before enabling by default.

## References

- Incident report: Discord, 2026-05-24, free-sleep user thread.
- Existing detection code: `src/hardware/deviceStateSync.ts:250`.
- Live `eight-pod` flow data: 240 rows pulled 2026-05-25 17:15 local,
  showing 1940–2010 RPM running, 0 RPM idle, no intermediate values.
- Capability detection pattern: `scripts/pod/capabilities`,
  `src/hardware/pods.ts`.
- Alert UI pattern to follow: `water_level_alerts` table,
  `src/server/routers/waterLevel.ts`.
- HomeKit accessory pattern to follow:
  `src/homekit/accessories/ambientSensor.ts`.
- MQTT bridge: ADR 0019, `src/streaming/mqttBridge.ts`.
- Sensor calibration philosophy (probe over assume): ADR 0014.
