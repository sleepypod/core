# Hardware Protocol Reference

Low-level details for the Pod hardware daemon communication layer. Covers socket path resolution, protocol specifics, and subsystems not yet implemented.

## Socket Path Resolution

The hardware daemon socket path varies by Pod generation and must be resolved at startup — do not hardcode a single path.

| Pod Generation | Socket Path |
|---|---|
| Pod 3 (no SD card) | `/deviceinfo/dac.sock` |
| Pod 4 | `/persistent/deviceinfo/dac.sock` |
| Pod 5 | `/persistent/deviceinfo/dac.sock` |
| Custom override | Read from config file |

**Resolution logic:**
1. Check config file for user-defined override
2. Probe Pod 4/5 path (`/persistent/deviceinfo/dac.sock`) — if exists, use it
3. Fall back to Pod 3 path (`/deviceinfo/dac.sock`)

Pod generation can be confirmed afterward via the `sensorLabel` field in `DEVICE_STATUS` (see `responseParser.ts:extractPodVersion`).

## Wire Protocol

```
Command:  "{code}\n{argument}\n\n"
Response: "{key} = {value}\n{key} = {value}\n\n"   (status)
          "OK\n\n"                                   (mutation success)
          "{error message}\n\n"                      (failure)
```

- Transport: Unix domain socket (UTF-8 text)
- Delimiter: double newline `\n\n` terminates both commands and responses
- Arguments containing `\n` or `\r` must be stripped before sending (protocol injection)
- A 10ms delay after write is required — the hardware controller buffers writes and may not have the response ready immediately without it

## Command Reference

Numeric codes sent as string (e.g., `"14\n\n"`). Full enum in `src/hardware/types.ts`.

| Code | Name | Argument | Notes |
|---|---|---|---|
| 0 | HELLO | — | Connection handshake, sent on connect |
| 11 | TEMP_LEVEL_LEFT | `-100` to `100` | Level 0 = 82.5°F neutral |
| 12 | TEMP_LEVEL_RIGHT | `-100` to `100` | |
| 9 | LEFT_TEMP_DURATION | seconds | Auto-return to neutral after timeout |
| 10 | RIGHT_TEMP_DURATION | seconds | |
| 5 | ALARM_LEFT | `intensity,pattern,duration` | pattern: 0=double, 1=rise |
| 6 | ALARM_RIGHT | `intensity,pattern,duration` | |
| 16 | ALARM_CLEAR | `0` (left) or `1` (right) | Safe to call with no active alarm |
| 13 | PRIME | — | Starts water circulation (2-5 min) |
| 14 | DEVICE_STATUS | — | Full status + gesture data |
| 8 | SET_SETTINGS | CBOR hex | Writes settings to hardware |

## DEVICE_STATUS Response Fields

```
tgHeatLevelL / tgHeatLevelR   # Target level (-100 to 100)
heatLevelL / heatLevelR       # Current level (-100 to 100)
heatTimeL / heatTimeR         # Remaining duration (seconds)
waterLevel                     # "true" = ok, "false" = low
priming                        # "true" / "false"
sensorLabel                    # e.g. "8SLEEP-SN-12345-H00" (encodes Pod version)
settings                       # CBOR hex (optional)
doubleTap / tripleTap / quadTap  # JSON gesture state (Pod 4+ only)
```

Pod version is encoded in the hardware revision suffix of `sensorLabel`:
- `H00`+ → Pod 3
- `I00`+ → Pod 4
- `J00`+ → Pod 5

## FrankenMonitor (Not Yet Implemented)

Gestures (tap events) are embedded in the `DEVICE_STATUS` response but require a persistent polling loop to act on them. This is a distinct pattern from the per-operation connection used by tRPC routers.

**Required behavior:**
- Maintain a persistent socket connection (not per-operation)
- Poll `DEVICE_STATUS` on a short interval (~1s)
- Compare gesture state against previous poll to detect new taps
- Execute configured action for each side/tapType combination (from `tap_gestures` DB table)
- Gesture actions: temperature change, alarm start, snooze, power toggle, priming

**Tap types:** `doubleTap`, `tripleTap`, `quadTap` — each side independently tracked via `{ l: number, r: number }` counters that increment on each tap event.

**Design note:** The monitor needs its own connection lifecycle, separate from the `HardwareClient` used by routers. It should not compete with the sequential command queue — gesture polling reads are non-mutating and low priority.

## Scheduler: System Date Validation

The Pod can boot with the system clock set to a historical date (e.g., 2010) if network time sync hasn't completed. Scheduling jobs against an invalid date causes all scheduled events to fire immediately or at the wrong time.

**Required behavior at startup:**
- Check system date before initializing `node-schedule` jobs
- If date is clearly invalid (e.g., year < 2020), wait and retry
- Only start the scheduler once a valid date is confirmed
- Log a user-visible warning if startup is delayed waiting for clock sync

## Biometrics Pipeline (Not Yet Implemented)

The Pod's piezo pressure sensors produce raw signal data that must be processed into vitals (HR, HRV, breathing rate). This is a separate daemon, not part of the main server process.

**Data flow:**
```
Pod sensors → RAW CBOR files → stream processor → FFT/signal processing → vitals → SQLite
```

- Piezo sensors sample at 500 Hz (pressure/movement)
- Capacitance sensors sample at 1 Hz (presence detection)
- Vitals are computed and written to `vitals` table approximately every 60 seconds
- Sleep session boundaries are detected from presence data and written to `sleep_records`
- The daemon runs independently and can be enabled/disabled without restarting the main server

The existing DB schema (`vitals`, `movement`, `sleep_records`) is designed for this pipeline's output.
