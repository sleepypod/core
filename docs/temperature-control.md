# Temperature ownership and manual holds

The per-side temperature controller resolves manual holds, run-once sessions,
Autopilot requests, and recurring schedules. Producers keep their own clocks;
the controller chooses the current target and serializes writes with
`withSideLock`. Safety protection blocks energizing writes. Ordinary temperature
reconciliation never turns a powered-off side back on.

Priority is manual hold, run-once session, Autopilot (highest rule priority,
then newest activation), then recurring schedule. Equal activations use stable
request IDs as a final tie-break. A hold affects only its bed side and never
changes a schedule's saved enabled setting.

## Rotary dial and other REST consumers

Existing temperature requests acquire a 30-minute hold without a firmware
change:

```http
POST /api/device/temperature
Content-Type: application/json

{"side":"left","temperature":75}
```

An optional `holdMinutes` chooses 1–1440 minutes. Each accepted adjustment
restarts that side's timer. `temperature` is Fahrenheit. `duration` retains its
separate hardware heating-duration meaning in seconds; it is not the hold timer.
An explicit duration becomes a persisted absolute cutoff. Resume, hold expiry,
keepalive, restart, and safety recovery cannot extend it. A new manual adjustment
without a duration starts a normal session again; a scheduled power-on during a
live hold preserves its cutoff. Duration zero shuts the side off without creating
a hold.

```json
{"side":"left","temperature":75,"holdMinutes":60}
```

Read ownership with `GET /api/device/temperature/control?side=left`:

```json
{
  "source":"manual",
  "requestId":"manual",
  "targetTemperature":75,
  "holdUntil":1790636400000,
  "blocked":null
}
```

`holdUntil` is Unix epoch **milliseconds**, or null. `source` is `manual`,
`run-once`, `autopilot`, `schedule`, or null. `blocked` is `safety`, `off`, or
null. The target in this control object is always Fahrenheit, including when
the surrounding device-status request chooses Celsius. The ordinary hardware
status carries the current effective hardware target; a blocked control object
can still describe the target that would win if power were explicitly enabled.

`GET /api/device/status` and WebSocket `deviceStatus` frames include the same
information under `temperatureControl.left` and `temperatureControl.right`.
The field can be absent before the controller starts. Consumers should tolerate
its absence for compatibility with older core versions.

Release a hold explicitly:

```http
POST /api/device/temperature/resume
Content-Type: application/json

{"side":"left"}
```

The response is the updated control object. tRPC consumers use
`device.getTemperatureControl`, `device.resumeTemperature`, and the existing
`device.setTemperature` mutation.

The dial should submit temperature changes only for user adjustments. Polling
must not re-send the target, because each adjustment renews the hold. Continue
using the existing debounce. Display the hold expiry and offer an explicit
Resume action; no client-side scheduling or later reconnect is required. Upgrade
core before sending the new optional field to an older strict-validation API.

## Resume, power, and alarms

Schedule and run-once clocks continue during a hold. On expiry or Resume, core
resolves the applicable point now without replaying earlier points. If no
source has a target, it leaves the current temperature unchanged and releases
ownership. Always-on keepalive can refresh that ownerless target without
creating a new hold.

A power-on API request without a temperature uses the current owner (or 75°F
when none exists) without creating a hold. An explicit power-on temperature
starts a manual hold.

Explicit shutdown ends the hold. Scheduled shutdown, auto-off, and safety
cutoffs remain independent of temperature ownership. Alarm vibration still
fires; an alarm's temperature participates at recurring-schedule priority.
A pending debounced adjustment superseded by Resume or a power command returns
a conflict instead of executing later and undoing that command.

Manual holds are stored in SQLite with their original start and expiry times.
Recreating the controller does not renew the hold. The controller singleton and
periodic reconciler live on `globalThis` so separate server bundles share one
authority. Service shutdown cancels queued reconciliation and drains admitted
writes before hardware/database teardown. Disabling an automation also cancels
its shutdown commands that are still waiting for the side lock.

## Autopilot request lifetime

Each evaluation publishes the complete Autopilot request set for each side in
one batch. Lower-priority rules cannot briefly write before a higher-priority
rule in the same evaluation. Requests remain available under manual/run-once
ownership, while hardware writes remain gated by the controller.

Temperature and power-on actions accept `mode: "policy" | "one-shot"` and
optional `holdMinutes`. By default, a time-of-day action or an expression that
references target/current level temperature is a one-shot; other temperature
policies are continuous. Continuous policy conditions are checked on every
engine tick, including between trigger times. False or unknown conditions
withdraw the policy; enabled policies refresh a two-tick lease so a stopped
engine cannot own a side indefinitely. Edits, deletion, disabling a rule, and
the global kill-switch revoke its requests. A signal-change policy can reacquire
its request after an edit, re-enable, or condition recovery without waiting for
a new signal edge. This does not replay sibling notifications or one-shot
actions; those still require an actual trigger.

One-shot actions resolve a numeric target once and keep it for 30 minutes by
default. Repeated ticks do not compound or extend that active request. A new
trigger after expiry can create another request. Conditions becoming false do
not undo an already-fired one-shot before its expiry; disabling/editing the
rule does.

In action expressions, per-side `targetTemperature` and legacy
`currentTemperature` references use that referenced side's current
schedule/session baseline, with 75°F as the fallback when neither exists.
Windowed action references use a separate history sampled from these baselines;
condition windows still use live observations. They never use the rule's own output. Conditions continue reading the actual
live signals. This defines relative adjustments independently of transient
manual holds and prevents repeated evaluation from ratcheting the target.

Recovery probes remain the pump guard's bounded diagnostic operation. Final
guard-authorized recovery resolves the current temperature request while
preserving the guard's remaining heating duration; it does not issue a second,
default-duration power-on command.

## Diagnostic and recovery writers

Ordinary API, HomeKit, gesture, schedule, run-once, and Autopilot temperature
commands use the shared controller. The raw `/api/device/execute` diagnostic
endpoint remains a low-level bypass, still subject to its existing side locks
and pump-protection checks. It neither acquires nor releases a hold and should
not be used by consumer controls. Subsequent controller reconciliation or
keepalive can replace a diagnostic target with the current owner’s target.
Pump-protection probes and emergency cutoffs remain guard-owned operations;
final recovery uses the current owner and the smaller of the guard’s remaining
duration and the persisted manual hardware cutoff.
