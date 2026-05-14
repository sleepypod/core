# ADR 0021: Use `ALARM_SOLO` (cmd 2) for cover-only Pod 5 vibration alarms

**Status:** SUPERSEDED 2026-05-11 — see "Correction" below.

## Correction (2026-05-11)

The original decision in this ADR is wrong. Re-verified live on
`eight-pod` (Pod 5 J55, cover only, no Pillow), 2026-05-11:

- `cmd 5` (`ALARM_LEFT`) and `cmd 6` (`ALARM_RIGHT`) with hex-CBOR **do
  fire the cover motor** on cover-only pods. The Pillow.cpp:383 "label
  uninitialized" log line appears, but it does NOT gate the cover-motor
  write. `Sensor.cpp:1221 triggerVibrationAlarm` runs first and
  unconditionally drives the cover via `Sensor.cpp:257 sendCommand
  [alarm io]`; the pillow path is consulted afterward and noisily
  rejects on cover-only pods, but the cover motor has already started.
- `cmd 2` (`ALARM_SOLO`) — what this ADR previously decreed as the
  correct path — has **no registered spark function** on this firmware.
  frank's `dac_loop` logs the incoming frame, then nothing else: no
  `sparkAlarmS` invocation, no motor write, silent drop. The DAC
  response is `0` because no registered function ran (returning
  default), giving the false impression of success at the API layer.

The original "live diagnosis" in this ADR conflated the Pillow.cpp
warning with the cover motor failing to fire. With more frank logging
(`journalctl -u frank` shows the full `triggerVibrationAlarm` →
`alarm io` → `alarm[side] start` chain), it became clear the cover
write was already happening — the user's "no buzz" reports must have
had another cause (cover MCU state, dismiss-clear race, deploy stomp on
the DAC singleton).

**Current decision:** `HardwareClient.setAlarm()` routes to
`ALARM_LEFT` / `ALARM_RIGHT` based on `side`, with the hex-CBOR payload
from `encodeAlarmPayload()`. See `src/hardware/sharedClient.ts`.

The frank-log debugging technique (the only reliable signal — DAC
response codes lie) is documented in
`docs/hardware/dac-socket-takeover.md`.

## Original context (preserved for the record)

The vibration alarm is the wake-up surface for the alarms feature
(`AlarmSection` UI → `device.setAlarm` tRPC → `HardwareClient.setAlarm` →
DAC socket). The hypothesis was that the per-side commands route
through `Pillow.cpp::triggerVibrationAlarm`, which gates on
`leftPillowLabel` / `rightPillowLabel`, and that those being `null` on
cover-only pods would refuse to drive the motor. The hypothesis was
half-true: the pillow path does reject, but the firmware writes to the
cover motor BEFORE consulting the pillow path, so the rejection is
cosmetic.

Reverse-engineering frankenfirmware's string table surfaced strings
suggesting a third "solo" path:

```
[alarm] vib. solo: time %u, power %u, pattern %s, dur %u
[alarm] set to solo trigger
[sensor] enabling Pod 2.0 vibration (simultaneous motors)
setHighCurrentVibration
```

These strings exist in the binary but the corresponding spark function
is not registered with the DAC. Either it's planned/dead code, or the
registration was removed in a firmware update we don't have. Either
way, cmd 2 doesn't drive the motors on the current J55 firmware.

## Consequences of the correction

- Per-side alarms now work: a left alarm at 6am buzzes only left, a
  right alarm at 7am buzzes only right.
- `alarm_schedules` rows with `side` are honored correctly without
  jobManager dedupe.
- Pillow accessory detection becomes irrelevant for the cover-vibration
  feature — cmd 5/6 + CBOR already works on cover-only pods.

## References

- Live re-verification logs: `eight-pod` journalctl 2026-05-11 ~06:53 UTC.
  `dac_loop command: 5` → `sparkAlarmL` → `triggerVibrationAlarm side
  left` → `[alarm io] side 0 power 80 pattern 0 for 30` → user felt the
  buzz.
- Tech doc: [`docs/hardware/alarms.md`](../hardware/alarms.md).
- frank log debugging technique: [`docs/hardware/dac-socket-takeover.md`](../hardware/dac-socket-takeover.md).
