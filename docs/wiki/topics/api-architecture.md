# API Architecture

Type-safe API layer providing frontend access to hardware control, settings, schedules, and biometrics. Built on tRPC with WebSocket push for real-time data.

## Router Structure

| Router | Purpose | Transport |
|--------|---------|-----------|
| `device.*` | Real-time hardware control | HTTP mutations, WS push for status |
| `settings.*` | Configuration management | HTTP |
| `schedules.*` | Automation schedules | HTTP |
| `biometrics.*` | Health data queries | HTTP |

## Device Status: WebSocket-First

Device status is primarily pushed via WebSocket on port 3001. tRPC HTTP remains for initial page load, non-WS clients (iOS, CLI), and fallback.

### Read Bus (DacMonitor)
DacMonitor polls [[hardware-protocol|dac.sock]] for device status (defaults to 2s, adapts based on activity: 1s active / 2s normal / 5s idle) and broadcasts a `deviceStatus` frame via WebSocket to all clients.

### Write Bus (Mutation Broadcast)
After any hardware mutation (user-initiated via device router OR automated via scheduler), `broadcastMutationStatus()` overlays the mutation onto the last polled status and broadcasts immediately (~200ms). Fire-and-forget — DacMonitor's 2s poll is the consistency backstop.

All hardware commands go through `dacTransport`'s `SequentialQueue`, serializing writes from concurrent sources.

### Frontend Hooks

```typescript
// Primary: WS push for device status
const { status, isLoading, isStreaming } = useDeviceStatus()

// Sensor data subscriptions
const { status, latestFrames } = useSensorStream({ sensors: ['capSense', 'bedTemp'] })

// Historical data, settings — HTTP
const vitals = trpc.biometrics.getVitals.useQuery({ side: 'left', limit: 100 })

// Mutations — always HTTP
const setTemp = trpc.device.setTemperature.useMutation()
```

| Data type | Transport | Hook |
|-----------|-----------|------|
| Device status | WebSocket push | `useDeviceStatus()` |
| Sensor data | WebSocket push | `useSensorStream()` / `useSensorFrame()` |
| Mutations | tRPC HTTP | `trpc.device.*.useMutation()` |
| Historical data | tRPC HTTP | `trpc.biometrics.*.useQuery()` |
| Settings | tRPC HTTP | `trpc.settings.*.useQuery()` |
| Schedules | tRPC HTTP | `trpc.schedules.*.useQuery()` |

## Device Router

Real-time Pod control via [[hardware-protocol]]:

- `setTemperature(side, temp, duration?)` — 55-110°F range, optional auto-off
- `setPower(side, on, temp?)` — level 0 = 82.5°F neutral (no true "off")
- `setAlarm(side, config)` — vibration patterns: double/rise, 1-100 intensity, 0-180s
- `clearAlarm(side)` / `snoozeAlarm(side, duration, config)`
- `startPriming()` — water circulation (2-5 min, loud, don't run during sleep)

Hardware timing: commands ~100-500ms, temperature changes 4-7 min (1-2°F/min).

## Schedules Router

Temperature, power, and alarm automation executed by background scheduler (node-schedule):

- **Temperature schedules** — time + target temp per day of week
- **Power schedules** — on/off times with target temp
- **Alarm schedules** — vibration + temperature wake-up

Timezone-aware. Away mode disables schedules per side without affecting manual control.

## Biometrics Router

Query data from the [[biometrics-system]]:

- `getSleepRecords` / `getLatestSleep` — session history
- `getVitals` / `getVitalsSummary` — HR, HRV, breathing rate
- `getMovement` — movement score per 60s epoch (0-1000)

Data fields may be null if sensor couldn't get a reliable reading. Default limits sized for typical use (30 records ≈ 1 month, 288 vitals ≈ 24 hours).

## Authentication

All procedures currently use `publicProcedure` — no authentication. Protected procedure middleware is defined but not yet active.

## Sources

- `docs/trpc-api-architecture.md`
- `docs/adr/0015-event-bus-mutation-broadcast.md`
