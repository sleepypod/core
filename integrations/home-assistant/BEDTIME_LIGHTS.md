# Bed entry → dim the lights that are already on

This implements the lighting part of the requested bedtime ritual. It uses Home
Assistant's existing accessory integrations and the Pod's qualified MQTT occupancy
sensors. It does not require replacing Homebridge or Apple Home pairings.

The default behavior is simple: between **22:00 and 05:00**, a known empty-to-
occupied transition that lasts **one minute** requests **10% brightness** from
the selected individual lamps that are still on and brighter than that level.
Either selected bed side can trigger it. Being in bed before the window starts
does not trigger a catch-up action at 22:00.

## What is preserved

- Lamps that are off stay out of the request. Lamps already dimmer are not
  brightened. Unselected lamps are untouched. Duplicate selected IDs are deduplicated.
- Home Assistant light groups and Hue rooms/zones are skipped: a group can report
  on while some of its lamps are off. Select the actual individual lamps instead.
  Other integrations' opaque groups must also be excluded during qualification.
- Missing brightness, unavailable state and unsupported dimming are skipped.
  Commands request brightness only; no color, color-temperature or effect change
  is requested, and no scene is activated.
- Every selected pause helper must be known off. A helper such as **Partner
  resting** can suppress the whole routine, including remaining lamps if it turns
  on during dispatch. The blueprint does not create or infer that helper.
- Occupancy recovery from unknown/unavailable is not a bed-entry event. The
  source must still be occupied in the same continuous interval before each
  command. A stopped or stale publisher must withdraw its MQTT entity normally.
- Commands expire 30 seconds after the one-minute hold. Outages and reloads do
  not create a backlog. There is no delayed restoration over a manual change.

The automation uses the current Home Assistant report immediately before each
request. A simultaneous physical/manual change can race any network command;
the integration cannot make that check atomic with the actual lamp. Successful
service dispatch is not proof of the physical brightness.

## Configure once, then qualify

1. Import [the blueprint](blueprints/bedtime_lights.yaml) in Home Assistant and
   create an automation. Choose the calibrated, expiring Pod occupancy entities.
2. Select individual lights. For the requested whole-home behavior, choose all
   intended lamps across rooms; exclude guests' rooms or any lamp you want to
   control separately. Review hidden/group entities before selecting them.
3. Optionally choose existing pause helpers. Keep **Allow bedtime dimming** off
   while selecting entities. The automation itself starts disabled too.
4. During an attended test, verify one selected light at a time, then the selected
   set: a bright lamp dims, an off lamp stays off, and a lamp below 10% stays dim.
   Verify unavailable occupancy and the pause helper prevent actions.
5. Inspect the automation trace and the physical result separately. After those
   checks, decide whether to retain this qualification template's disabled-after-
   restart behavior or take control of the automation and use HA's persisted
   enabled state. Installation and Git merges never enable it automatically.

This is an occupancy-based house routine, not a person recognizer. Keep it
separate from Marissa's future explicit side assignment and shared quiet policy.
Shades, purifier/humidity responses, Endel and HomePod audio remain separate
workstreams; this blueprint cannot start iPhone audio or set a diffuser humidity
target. Pod temperature, alarms, vibration and base movement are unchanged.

## Implementation evidence

Tests load the real Home Assistant 2026.10.4 blueprint/automation schemas and run
the script engine with synthetic sensor states and captured light services. They
cover permission/manual-run guards, source transitions and dispatch expiry,
midnight windows, optional pauses, individual/group capabilities, current light
state, deduplication, unavailable values and interruptions between lamps. They
do not operate real accessories or prove live deployment.

References: [blueprint inputs](https://www.home-assistant.io/docs/blueprint/schema/),
[state triggers](https://www.home-assistant.io/docs/automation/trigger/),
[light actions](https://www.home-assistant.io/integrations/light/), and
[group semantics](https://www.home-assistant.io/integrations/group/).
