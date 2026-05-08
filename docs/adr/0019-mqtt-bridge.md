# ADR 0019: MQTT bridge for Home Assistant integration

## Context

The Pod runs a tRPC HTTP API on port 3000 and a WebSocket sensor stream on
3001. Both are great for the iOS / web app but neither is what smart-home
hubs speak. Home Assistant in particular ships a first-class MQTT
integration with a discovery convention — Pod owners running HA today have
to script `rest_command` blocks against tRPC, which does not surface in HA's
device UI and breaks every time we touch a route.

Adding a single MQTT bridge that publishes state and accepts commands gets
us:

1. **Native HA UX** — climate cards per side, sensors for biometrics and
   water level, switches for priming. No YAML scripting.
2. **Generic interop** — anything that speaks MQTT (Node-RED, openHAB, raw
   `mosquitto_sub`) can read and command the Pod with no Pod-specific code.
3. **No new transport in the iOS app** — the existing tRPC path stays the
   primary control plane. MQTT is an additive surface.

## Decision

Run an in-process MQTT *client* (not a broker) that connects outbound to
the user's broker. The Pod is a single tenant on someone else's bus.

### Transport

- One persistent `mqtt.MqttClient` per process, started from
  `instrumentation.ts` after the piezo stream server.
- LWT publishes `offline` retained on `<prefix>/<device-id>/availability`;
  on `connect` we replace it with `online`.
- `reconnectPeriod` 5 s with the library's built-in exponential backoff
  envelope. Connection failures are non-fatal — the bridge logs and retries
  without blocking the Pod's primary tRPC startup path.
- `keepalive` 30 s. Topic prefix configurable; default `sleepypod`.
- TLS optional. When enabled we set `rejectUnauthorized: false` so users
  with self-signed broker certs (the common HA case) work out of the box.
  Stricter cert-pinning is deferred until protectedProcedure-style auth
  lands.

### LAN-only default

The broker URL defaults to *unset*. The bridge stays dormant until either
`device_settings.mqtt_url` or `MQTT_URL` is provided. We do not ship a
default broker, do not autodiscover one, and do not punch a hole in
`iptables` for outbound MQTT. The user opts in.

When enabled, traffic flows Pod → user-supplied broker. The broker is
expected to be on the same LAN; no public broker is recommended. The pod
already runs WAN-blocked behind the iptables LAN-only policy; opening MQTT
to the public internet is the operator's choice.

### Credentials: plaintext in `device_settings`

The bridge reads username/password from `device_settings.mqtt_username` and
`device_settings.mqtt_password`. Both columns are plaintext.

We considered three alternatives and rejected each:

1. **Keychain / OS secret store** — the Pod's Yocto image has no secret
   service running. Wiring one up just for MQTT credentials adds a
   meaningful surface (D-Bus, Avahi exclusions, install-time bootstrap)
   for one route's worth of secret material.
2. **Encrypted at rest with a Pod-derived key** — without a tamper-resistant
   key store the "key" is just another file on the same eMMC; the
   encryption is theatre.
3. **Hashed credential round-trip via a protected tRPC procedure** — would
   require landing real auth on tRPC first, which is its own multi-week
   project. We have no `protectedProcedure` today; everything is
   `publicProcedure` because the Pod is LAN-isolated.

The threat model that justifies plaintext: an attacker who has read access
to `/persistent/sleepypod.dev.db` already has full control of the Pod.
Protecting the broker password against that attacker buys nothing. The
Settings UI never returns the stored password — `getSettings` reports
`passwordSet` and `updateSettings` accepts write-only — so it is not
exposed beyond the SQLite row.

**Revisit when** `protectedProcedure` lands. At that point we should:

- Move credentials behind an authenticated read endpoint (or stop reading
  them outside the bridge entirely).
- Reconsider whether the row should hold the password at all, vs deriving
  it from a credential service called at bridge start.

### Configuration precedence: DB > env > default

Each MQTT field on `device_settings` is nullable. Resolution at bridge
start picks the first non-null source per field:

```
device_settings.mqtt_<field>  >  process.env.MQTT_<FIELD>  >  hard default
```

This lets a headless deployment ship secrets via env (e.g. systemd
`EnvironmentFile`) while a UI-driven setup writes to the DB. The Settings
UI gets per-field source attribution from `mqtt.getSettings` so it can
render "Set in environment" hints next to fields the operator can't change
without sshing in.

### HA discovery

On `connect` we publish retained discovery payloads under
`homeassistant/<comp>/<device-id>/<entity>/config` for:

- `climate` per side — current/target temperature, mode (`off|heat`),
  command topics that round-trip through `cmd/set-temperature` and
  `cmd/set-power`.
- `sensor` for water level, per-side heart rate, breathing rate, HRV.

Discovery prefix is overridable via `MQTT_HA_DISCOVERY_PREFIX` for users
who run a non-default HA install.

### Command routing through tRPC

Commands arriving on `cmd/<verb>` are dispatched to the same `appRouter`
procedures the iOS app calls (`device.setTemperature`, `setPower`,
`setAlarm`, `clearAlarm`, `startPriming`). The bridge does *no* input
validation of its own — Zod input schemas on the procedures are the single
source of truth. A malformed payload throws inside the caller and the error
is logged; we do not surface command failures back over MQTT in v1.

This matters: it means the bridge cannot accidentally diverge from the iOS
app's safety envelope. Every constraint (temperature range, alarm
duration, side enum) lives on the procedure and is enforced once.

## Consequences

- One outbound TCP connection per Pod when enabled. No effect on Pods that
  leave it disabled.
- Adds the `mqtt` npm package to runtime deps (~200 KB). Bridge module is
  lazy in spirit: it only opens the connection when configured.
- The `device_settings` row gains seven nullable columns. Migration
  `0007_round_hardball.sql`.
- Plaintext credential storage is a known compromise; tracked above.

## Refs

- Epic: sleepypod-core-26
- Backend ticket: sleepypod-core-27
- Settings UI ticket: sleepypod-core-28
