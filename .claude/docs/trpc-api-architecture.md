# tRPC API Architecture

Complete type-safe API layer for sleepypod-core. Provides frontend access to hardware control, settings, schedules, and biometrics data.

## Router Structure

```
src/server/routers/
├── app.ts              # Main router aggregator
├── device.ts           # Real-time hardware control
├── settings.ts         # Configuration management
├── schedules.ts        # Automation schedules
└── biometrics.ts       # Health data queries
```

## Design Principles

### 1. Direct Hardware vs Scheduled Operations

**Device Router (device.*)**
- Real-time operations that execute immediately
- Creates new hardware connection per operation
- Use for user-initiated actions (button press, manual control)
- Higher latency due to connection overhead (~25s timeout)

**Schedules Router (schedules.*)**
- Define future/recurring operations
- Executed by background scheduler
- Use for automated temperature changes, alarms, power events
- No immediate hardware interaction

### 2. Connection Management

**Current Pattern:**
```typescript
const client = await createHardwareClient({ socketPath })
try {
  await client.executeCommand(...)
} finally {
  client.disconnect() // Closes connection after every operation
}
```

**Why:** Prevents connection pooling complexity and socket leaks. Trade-off: reconnection overhead for reliability.

**Polling Guidance:**
- `device.getStatus()`: Safe to poll every 5-10 seconds
- For high-frequency reads, query `device_state` table instead
- Hardware can handle multiple concurrent clients

### 3. Error Handling

All hardware operations wrap errors in `TRPCError`:
```typescript
catch (error) {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `Failed to X: ${error.message}`,
    cause: error
  })
}
```

**Limitation:** Generic error code loses hardware-specific error types. Frontend can't distinguish between connection failure vs hardware rejection.

**Future:** Consider error code mapping for common hardware errors (TIMEOUT, HARDWARE_BUSY, INVALID_COMMAND).

### 4. Database State Synchronization

**Pattern:** Optimistic database updates
```typescript
await client.setTemperature(...)
await db.update(deviceState).set({ targetTemperature: ... }) // Optimistic
```

**Race Condition:** Clients calling `getStatus()` immediately after may see:
- Database: Updated target temperature
- Hardware: Still reporting old current temperature

**Why:** Hardware heating/cooling takes time (1-2°F per minute). Database reflects _intent_, hardware reflects _reality_.

## Router Details

### Device Router (`device.*`)

Real-time Pod hardware control.

**Procedures:**
- `getStatus()` - Current hardware state (temp, power, alarm, priming status)
- `setTemperature(side, temp, duration?)` - Set target temp, optionally with auto-off timer
- `setPower(side, on, temp?)` - Power control (on = heat/cool, off = neutral)
- `setAlarm(side, config)` - Start vibration alarm (patterns: double/rise, 1-100 intensity, 0-180s max)
- `clearAlarm(side)` - Stop vibration
- `startPriming()` - Run water circulation sequence (2-5 min, loud, don't run during sleep)

**Hardware Timing:**
- Commands execute in ~100-500ms
- Temperature changes take 4-7 minutes (1-2°F per minute heating/cooling rate)
- Priming completes in 2-5 minutes
- Connection timeout: 25 seconds

**Temperature Range:** 55-110°F (hardware heating/cooling capacity limits)

**Important:**
- Level 0 = 82.5°F (neutral, no heating/cooling)
- No true "off" state in hardware
- Alarms start immediately (not scheduled)
- Only one alarm per side at a time

### Settings Router (`settings.*`)

Device and side configuration management.

**Procedures:**
- `getAll()` - Fetch all settings (device + both sides + gestures)
- `updateDevice(timezone, tempUnit, reboot, priming)` - Device-wide settings
- `updateSide(side, name, awayMode)` - Per-side configuration
- `setGesture(side, tapType, action, params)` - Configure tap behaviors
- `deleteGesture(side, tapType)` - Remove tap gesture

**Gestures:**
- Tap types: doubleTap, tripleTap, quadTap
- Actions: temperature, alarm, snooze, power, priming
- Hardware executes gestures locally (low latency)

**Away Mode:**
- Disables scheduled operations for a side
- Manual control still works
- Use for extended absences

### Schedules Router (`schedules.*`)

Temperature, power, and alarm automation.

**Procedures:**
- `getAll(side)` - All schedules for a side
- `getByDay(side, day)` - Schedules for specific day of week
- CRUD operations for each schedule type (temperature, power, alarm)

**Schedule Types:**

1. **Temperature Schedules**
   - `time`: When to change temperature (HH:MM format)
   - `temperature`: Target in Fahrenheit (55-110°F)
   - `dayOfWeek`: Which day schedule runs
   - Use case: Warm bed before sleep, cool during night

2. **Power Schedules**
   - `onTime`, `offTime`: Power state change times
   - `onTemperature`: Target temp when powering on
   - Use case: Energy saving, daily rhythm

3. **Alarm Schedules**
   - `alarmTime`: When vibration starts
   - `vibrationIntensity`: 1-100
   - `vibrationPattern`: 'double' or 'rise'
   - `duration`: 0-180 seconds max
   - `alarmTemperature`: Temp to set when alarm activates
   - Use case: Smart wake-up with vibration + temperature

**Execution:**
- Background scheduler (node-schedule) executes schedules
- Timezone-aware (uses device.timezone setting)
- Disabled schedules remain in database but don't execute
- Away mode per side disables all schedules for that side

**Conflict Handling:**
- Multiple schedules at same time: Last created wins (no guaranteed order)
- Manual control doesn't disable schedules
- Next scheduled event will override manual setting

### Biometrics Router (`biometrics.*`)

Query sleep and health data from Pod sensors.

**Procedures:**
- `getSleepRecords(side, dateRange?, limit)` - Sleep session history
- `getVitals(side, dateRange?, limit)` - Heart rate, HRV, breathing rate
- `getMovement(side, dateRange?, limit)` - Activity/restlessness data
- `getLatestSleep(side)` - Most recent sleep session
- `getVitalsSummary(side, startDate, endDate)` - Aggregated vitals statistics

**Data Collection:**
- Vitals: Sampled every ~5 minutes during sleep (ballistocardiography)
- Movement: Continuous tracking via pressure sensors
- Sleep records: Created on bed entry/exit detection

**Data Fields:**
- Heart rate: Beats per minute
- HRV: Heart rate variability in ms (higher = better recovery)
- Breathing rate: Breaths per minute
- Fields may be null if sensor couldn't get reliable reading

**Performance:**
- Historical data only (5-minute lag)
- Large date ranges can be slow (consider caching)
- Default limits sized for typical use cases (30 sleep records = ~1 month, 288 vitals = 24 hours)

## Authentication

**CRITICAL:** All procedures currently use `publicProcedure` - no authentication.

**Before Production:**
```typescript
const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx: { ...ctx, user: ctx.session.user } })
})
```

Replace all `publicProcedure` with `protectedProcedure` once session management is implemented.

## Common Patterns

### Date Range Queries
```typescript
// All biometrics procedures
.input(z.object({
  side: z.enum(['left', 'right']),
  startDate: z.date().optional(), // Inclusive
  endDate: z.date().optional(),   // Inclusive
  limit: z.number().min(1).max(N).default(X)
}))
```

### Hardware Operation
```typescript
const client = await createHardwareClient({ socketPath: DAC_SOCK_PATH })
try {
  await client.executeCommand(...)
  await db.update(...) // Optimistic state sync
  return { success: true }
} catch (error) {
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: ... })
} finally {
  client.disconnect()
}
```

### Drizzle Query with Optional Filters
```typescript
const conditions = [eq(table.side, input.side)]
if (input.startDate) conditions.push(gte(table.timestamp, input.startDate))
if (input.endDate) conditions.push(lte(table.timestamp, input.endDate))

const results = await db
  .select()
  .from(table)
  .where(and(...conditions))
  .orderBy(desc(table.timestamp))
  .limit(input.limit)
```

## Frontend Usage

tRPC auto-generates React Query hooks:

```typescript
import { trpc } from '@/src/utils/trpc'

// Queries (automatic caching, refetching)
const status = trpc.device.getStatus.useQuery()
const vitals = trpc.biometrics.getVitals.useQuery({
  side: 'left',
  limit: 100
})

// Mutations
const setTemp = trpc.device.setTemperature.useMutation()
await setTemp.mutateAsync({
  side: 'left',
  temperature: 72
})
```

## Testing Considerations

**Missing Test Coverage:**
- No unit tests for any routers
- No integration tests for hardware operations
- No mock hardware client for testing

**Recommended:**
1. Unit tests for input validation (Zod schemas)
2. Integration tests with mock hardware client
3. Database query tests with in-memory SQLite
4. Error handling tests (timeout, connection failure, invalid commands)

## Related Documentation

- Hardware abstraction: `src/hardware/client.ts` (detailed hardware protocol docs)
- Database schema: `src/db/schema.ts`
- Scheduling: `src/scheduler/` (execution of scheduled operations)
- Frontend integration: `src/utils/trpc.ts`
