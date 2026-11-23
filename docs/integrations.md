# HomeKit and MQTT reference

Setup steps live in the user guide: **[HomeKit and MQTT](https://sleepypod.github.io/core/integrations/)**. This page keeps the protocol-level reference that changes with the code: accessory mappings, identity, topics, and environment variables.

---

## HomeKit bridge

The Pod ships an embedded [hap-nodejs](https://github.com/homebridge/HAP-NodeJS)
bridge that publishes itself as a native HomeKit accessory over Bonjour. No
Homebridge install, no Apple cloud round-trip — pairing and control happen
entirely on your LAN.

```mermaid
graph LR
  iOS[iPhone / iPad<br/>Home app] -- HAP / mDNS --> Pod[Pod<br/>sleepypod-core<br/>:51827]
  Pod -- setPower / setTemperature --> DAC[Pod hardware]
  Pod -. occupancy / vitals .- BIO[(biometrics.db)]
```

The bridge is **off by default** — toggle it on from **Settings → HomeKit**.
The installer's iptables rules accept HAP (tcp/51827) only from LAN address
ranges; mDNS discovery (udp/5353) is accepted without a source restriction,
so the bridge is discoverable but not pairable or controllable from outside
the LAN.

### Accessories

Each side (`left`, `right`) gets its own set; switches that act on the whole
pod ship once.

| Accessory | Type | Reads from | Writes to |
|---|---|---|---|
| `Bed <side>` | Thermostat (single setpoint) | `deviceStatus.<side>` | `setTemperature` / `setPower` |
| `Bed <side> power` | Switch | `deviceStatus.<side>.powered` | `setPower` (preserves last setpoint) |
| `Bed <side> occupancy` | OccupancySensor | `sleep_records` (latest with `leftBedAt IS NULL`) | — |
| `Snooze <side>` | Switch | `snoozeManager` | `snoozeAlarm` / `cancelSnooze` |
| `Prime` | Switch | `primeNotification` (auto-off on completion) | `startPriming` |
| `Pod ambient` | TemperatureSensor | `bed_temp.ambient_temp` (centidegrees → °C) | — |

Thermostat is HomeKit's single-setpoint primitive (the pod hardware exposes
one setpoint, not a heat/cool deadband). Mode `off` cuts power; `auto` powers
on at the last requested temperature. HomeKit Celsius is converted at the
boundary; the in-app unit preference is unaffected.

### Identity durability

The bridge's HomeKit identity (MAC-style username, pincode, setupId) is
**deterministically derived** from a hardware-rooted seed (eMMC CID →
machine-id → random fallback) via HKDF, and cached at
`$DATA_DIR/homekit/identity.json` (where `$DATA_DIR` is the picker-chosen
data dir — see [`scripts/README.md`](../scripts/README.md#file-locations);
typically `/persistent/sleepypod-data/homekit/identity.json` on Pod 4/5).
As long as the selected seed is unchanged, a `/persistent` wipe or
firmware reflash regenerates the **same** identity, so iOS still recognizes
the bridge — you only re-pair, your automations and rooms stay intact. When
the seed comes from `machine-id` (which does not survive a factory reset) or
the `random-dev` fallback, deleting `identity.json` produces a new identity,
and the bridge must be removed and re-added in iOS. See
**[ADR 0020](adr/0020-homekit-identity-derivation.md)** for the full
rationale, seed chain, and what the design intentionally does *not* protect
against.

### Environment variables

Headless deployments can override the auto-detected mDNS advertiser. All
other config (enable/disable, pairing) lives in `device_settings` and is
managed from the UI.

| Variable | Default | Description |
|---|---|---|
| `HOMEKIT_ADVERTISER` | auto (`avahi` if `/run/avahi-daemon/socket` exists, else `ciao`) | mDNS advertiser; force `avahi` to coexist with the existing `_sleepypod._tcp` service file, or `ciao` for pods without avahi |

---

## MQTT bridge

The Pod can connect outbound to an MQTT broker you already run (typically the
[Mosquitto add-on](https://github.com/home-assistant/addons/tree/master/mosquitto)
that ships with Home Assistant). Off by default — opt in from
**Settings → MQTT** in the web UI.

```mermaid
graph LR
  Pod[Pod<br/>sleepypod-core] -- mqtt:// --> Broker[(MQTT broker<br/>e.g. Mosquitto)]
  Broker --> HA[Home Assistant]
  Broker --> NR[Node-RED]
  Broker --> Other[anything that<br/>speaks MQTT]
  HA -. cmd/* .-> Broker
  NR -. cmd/* .-> Broker
  Broker -. cmd/* .-> Pod
```

The Pod is a **client**, not a broker. It does not embed a broker, does not
listen on 1883, and does not punch holes in the LAN-only iptables policy.

### Configuration

Headless deployments can skip the UI by setting environment variables;
the bridge resolves config in this order: `device_settings` row > env var > built-in default.

| UI field | Env var | Default |
|---|---|---|
| Enable bridge | `MQTT_ENABLED` | `false` |
| Broker URL | `MQTT_URL` | _(unset — bridge stays dormant)_ |
| Username | `MQTT_USERNAME` | _(none)_ |
| Password | `MQTT_PASSWORD` | _(none)_ |
| Topic prefix | `MQTT_TOPIC_PREFIX` | `sleepypod` |
| HA discovery | `MQTT_HA_DISCOVERY` | `true` |
| HA discovery prefix | `MQTT_HA_DISCOVERY_PREFIX` | `homeassistant` |
| TLS | `MQTT_TLS` | `false` |
| TLS allow self-signed | `MQTT_TLS_INSECURE` | `false` |
| Presence hold (s) | `MQTT_PRESENCE_HOLD_SECONDS` | `0` |
| Out-of-bed line (%) | `MQTT_PRESENCE_EXIT_PERCENT` | `50` |

The URL scheme decides whether the connection is encrypted: `mqtts://` uses
TLS, `mqtt://` is plain TCP. The TLS toggle does not upgrade an `mqtt://` URL;
it only gates `MQTT_TLS_INSECURE`, which skips certificate verification when
both are on.

### Topics

`<prefix>` defaults to `sleepypod`. `<device-id>` is the slugified hostname
(override with `MQTT_DEVICE_ID`). All state topics are retained.

| Topic | Direction | Payload |
|---|---|---|
| `<prefix>/<device-id>/availability` | pod → broker | `online` / `offline` (LWT) |
| `<prefix>/<device-id>/state/device-status` | pod → broker | full deviceStatus JSON |
| `<prefix>/<device-id>/state/<side>/climate` | pod → broker | per-side temp / mode |
| `<prefix>/<device-id>/state/water-level` | pod → broker | `low` / `ok` / `unknown` |
| `<prefix>/<device-id>/state/biometrics/<side>` | pod → broker | latest HR / HRV / BR |
| `<prefix>/<device-id>/state/environment/ambient` | pod → broker | `{"ts": <epoch_ms>, "temperature": <number\|null>, "humidity": <number\|null>}` (°C, %) |
| `<prefix>/<device-id>/state/<side>/alarm` | pod → broker | `{"ts", "nextAlarm": <ISO\|null>, "time": "HH:mm", "day", "wakeWindowMinutes", "wakeWindowStart": <ISO\|null>, "ringing", "snoozedUntil": <ISO\|null>}` |
| `<prefix>/<device-id>/state/<side>/presence` | pod → broker | `{"ts", "inBed": <bool\|null>, "since": <ISO\|null>, "raw": <bool\|null>, "load": <number\|null>, "threshold", "exitThreshold", "holdSeconds"}` |
| `<prefix>/<device-id>/cmd/set-temperature` | broker → pod | `{"side","temperature","duration?"}` |
| `<prefix>/<device-id>/cmd/set-power` | broker → pod | `{"side","powered","temperature?"}` |
| `<prefix>/<device-id>/cmd/set-alarm` | broker → pod | `{"side","vibrationIntensity","vibrationPattern","duration"}` |
| `<prefix>/<device-id>/cmd/clear-alarm` | broker → pod | `{"side"}` (stops the alarm and any snooze) |
| `<prefix>/<device-id>/cmd/snooze-alarm` | broker → pod | `{"side","duration?"}` (seconds, 60–1800) |
| `<prefix>/<device-id>/cmd/start-priming` | broker → pod | `{}` |

With Home Assistant discovery on, each side also gets a **Next alarm**
sensor (a timestamp: when that side's alarm next goes off, in the pod's
timezone, unknown when none is set or the side is away) with the set time,
day, wake window and snooze as attributes, and an **Alarm ringing** binary
sensor. Use them to, say, open the blinds at the alarm or turn the lights on
when it rings. The next alarm is the set time; with a wake window it can go
off earlier, from `wakeWindowStart`. State refreshes every 30 s, so an alarm
change shows up in Home Assistant within half a minute. **Alarm ringing**
updates as soon as the alarm starts or stops.

Each side also gets **Snooze alarm** and **Stop alarm** buttons, which
publish `cmd/snooze-alarm` and `cmd/clear-alarm`. A snooze works like tapping
the bed: it lasts the ringing alarm's own snooze length (shortened by its
snooze taper, kept within 1–30 min) and the alarm comes back with the same
vibration. Put `duration` in the payload to snooze for a set time instead.

### Bed presence

Each side gets an **In bed** binary sensor (occupancy) and a **Bed load**
sensor. The bridge reads the live capacitance sensor about twice a second
and compares it with the sleep-detector's empty-bed baseline, so the sensor
changes within a few seconds of getting in or out of bed, without the
sleep-detector's 30 s wait.

- `load` is the side's summed rise over its empty-bed level. Presence starts
  above `threshold` and ends below `exitThreshold`, so a reading near the line
  doesn't flap. `exitThreshold` is the **Out-of-bed line** (Settings → MQTT,
  25–90% of `threshold`, default 50% as the sleep-detector uses). A mattress
  just vacated can read well above its empty level for a minute or more
  (warmth, compressed foam), so with the default line the exit can show 10–20 s
  late. Raising the line reports it sooner; keep it under the lowest `load` you
  see while asleep, or a sleeper who shifts can read as out.
- `raw` is the sensor's reading right now. `inBed` is the same reading after
  the **Presence hold** (Settings → MQTT, default off): a change counts once it
  has lasted that long, so rolling onto the edge for a moment doesn't read as
  leaving. `since` is when the current state began, not when it was reported.
- With one sleeper (one side away, or a solo bed), the sleeper's side reads
  the combined load of both sides, so lying across the middle still counts.
  It also reads out of bed when that load collapses: under 30% of what it was
  a minute earlier, by at least 2.5 thresholds, for 10 s. Getting up does
  that; rolling over doesn't, since the load only moves. This catches an exit
  that the line misses, such as pillows or bedding left on the bed or a
  mattress slow to settle. The load left behind is then treated as empty
  (`residual`), and getting back in counts from it. `residual` falls with the
  load as the mattress settles or things are taken off, and is `null` on a
  side without a single sleeper. The other side's sensor keeps its own
  reading.
- The state is unknown (`null`) while the sleep-detector isn't running or the
  sensor stops reporting.

An automation that should ignore a short trip out of bed can also add `for:`
to its trigger, which leaves the sensor itself instant.

Commands route through the same tRPC procedures the iOS app calls, so Zod
input schemas validate every payload — the bridge cannot accidentally
diverge from the app's safety envelope.

### Example: turn off the left side from any MQTT client

```bash
mosquitto_pub -h broker.lan \
  -t 'sleepypod/eight-pod/cmd/set-power' \
  -m '{"side":"left","powered":false}'
```

State mirrors back on `sleepypod/eight-pod/state/left/climate` within ~1 s.

See **[ADR 0019](adr/0019-mqtt-bridge.md)** for the design rationale —
why client-not-broker, the credential storage decision, the tRPC dispatch
model, and what's deferred until `protectedProcedure` lands.
