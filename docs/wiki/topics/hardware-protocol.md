# Hardware Protocol

How sleepypod-core communicates with the Pod hardware via the DAC Unix socket.

## Architecture

The Pod runs three stock processes:
- **frankenfirmware** — controls hardware (temperature, pumps, sensors, alarms) via UART to STM32 MCUs
- **Eight.Capybara** — cloud connectivity (blocked by [[deployment|network security]])
- **DAC** — replaced by sleepypod-core

sleepypod-core replaces the DAC process. frankenfirmware connects TO us on `dac.sock`.

## Connection Architecture

```
SocketListener (listens on dac.sock)
  └── DacTransport (wraps connected socket)
       └── SequentialQueue (one command at a time)
            └── MessageStream (binary-split on double-newline)
```

All consumers share a single `DacTransport` via `getSharedHardwareClient()`:
- **DacMonitor** — polls every 2s for device status
- **Device Router** — ad-hoc API calls from [[api-architecture]]
- **Job Manager** — scheduled operations
- **Health Router** — connectivity checks
- **Gesture Handler** — tap actions

### Design Principles

- **Queue, don't replace** — incoming connections are queued; consumer pulls when ready
- **One transport for all consumers** — multiple independent connections cause each to be treated as a new frankenfirmware, destroying the real one
- **Sequential commands** — one command, one response; 10ms delay between write and read
- **Restart frank after deploy** — it only discovers `dac.sock` on startup

## Wire Protocol

Text-based, double-newline delimited:

```
Request:  {command_number}\n{argument}\n\n
Response: {data}\n\n
```

### Commands

| Code | Command | Argument | Description |
|------|---------|----------|-------------|
| `0` | HELLO | — | Ping/connectivity check |
| `5`/`6` | ALARM_LEFT/RIGHT | hex CBOR | Configure alarm |
| `8` | SET_SETTINGS | hex CBOR | LED brightness, etc. |
| `9`/`10` | TEMP_DURATION_L/R | seconds | Auto-off duration |
| `11`/`12` | TEMP_LEVEL_L/R | -100 to 100 | Set temperature level |
| `13` | PRIME | — | Start water priming |
| `14` | DEVICE_STATUS | — | Get all device status |
| `16` | ALARM_CLEAR | 0 or 1 | Clear alarm (0=left, 1=right) |

### Temperature Scale

| Level | Fahrenheit | Description |
|-------|-----------|-------------|
| -100 | 55°F | Maximum cooling |
| 0 | 82.5°F | Neutral (no heating/cooling) |
| +100 | 110°F | Maximum heating |

Formula: `F = 82.5 + (level / 100) × 27.5`

### Raw Command Execution

The `device.execute` tRPC mutation (OpenAPI: `POST /device/execute`) provides passthrough access to the frank command protocol. Power user feature for debugging and testing — no input validation beyond command name allowlisting. Not covered by standard safety/debounce mechanisms.

### Timing

- **10ms** delay between write and read
- **2s** DacMonitor polling interval
- **25s** timeout waiting for frankenfirmware to connect

## Sources

- `docs/hardware/DAC-PROTOCOL.md`
- `docs/adr/0016-raw-command-execution.md`
