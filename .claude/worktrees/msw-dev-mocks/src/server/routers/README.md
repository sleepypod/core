# tRPC API Routers

This directory contains all tRPC router definitions for the SleepyPod API.

## Router Overview

| Router | File | Queries | Mutations | Purpose |
|--------|------|---------|-----------|---------|
| **device** | `device.ts` | 1 | 5 | Hardware control (temperature, power, alarm, priming) |
| **biometrics** | `biometrics.ts` | 5 | 0 | Health data queries (sleep, vitals, movement) |
| **schedules** | `schedules.ts` | 2 | 9 | Recurring operations (temperature/power/alarm schedules) |
| **settings** | `settings.ts` | 1 | 4 | Device configuration (device, sides, gestures) |
| **app** | `app.ts` | 1 | 0 | Root router aggregator + healthcheck |

**Total:** 10 queries, 18 mutations (28 procedures)

## Authentication Status

**Current:** All procedures use `publicProcedure` (no authentication)

**Reason:** Local hardware deployment with no network exposure. See [`app/api/(auth)/README.md`](../../../app/api/(auth)/README.md) for detailed explanation of deployment context and future auth strategy.

## Router Details

### device.ts - Hardware Control

Direct hardware operations for immediate control:

- `getStatus` - Query real-time hardware state (~25s timeout)
- `setTemperature` - Set target temperature (55-110°F) with optional duration
- `setPower` - Control side power (ON/OFF)
- `setAlarm` - Trigger vibration alarm immediately
- `clearAlarm` - Stop active vibration
- `startPriming` - Initiate water system priming sequence

### biometrics.ts - Health Data

Historical sensor data queries:

- `getSleepRecords` - Sleep session history with optional date range
- `getVitals` - Heart rate, HRV, breathing rate measurements
- `getMovement` - Activity/restlessness data
- `getLatestSleep` - Most recent sleep record
- `getVitalsSummary` - Aggregated statistics for date range

### schedules.ts - Recurring Operations

CRUD operations for automated schedules:

**Temperature Schedules:**
- `createTemperatureSchedule` / `updateTemperatureSchedule` / `deleteTemperatureSchedule`

**Power Schedules:**
- `createPowerSchedule` / `updatePowerSchedule` / `deletePowerSchedule`

**Alarm Schedules:**
- `createAlarmSchedule` / `updateAlarmSchedule` / `deleteAlarmSchedule`

**Queries:**
- `getAll` - Fetch all schedules for a side
- `getByDay` - Fetch schedules for specific day of week

### settings.ts - Device Configuration

Device and side configuration management:

- `getAll` - Fetch all settings (device, sides, gestures)
- `updateDevice` - Update device-level settings (timezone, temperature unit, reboot/prime schedules)
- `updateSide` - Update side-specific settings (name, away mode)
- `setGesture` - Create/update tap gesture mappings (double/triple/quad tap actions)
- `deleteGesture` - Remove tap gesture mapping

## Type Safety

- ✅ 100% Zod schema coverage on inputs
- ✅ Full TypeScript inference on outputs
- ✅ Exported `AppRouter` type for frontend client
- ✅ No `any` types in procedure definitions

## Error Handling Status

| Router | Error Handling | Status |
|--------|----------------|--------|
| device.ts | ✅ Full | All procedures wrapped in try-catch-finally |
| biometrics.ts | ❌ None | Needs error handling added |
| schedules.ts | ❌ None | Needs error handling added |
| settings.ts | ❌ None | Needs error handling added |

See [tRPC Review Report](../../../docs/trpc-review-2026-02-23.md) for detailed analysis and recommendations.

## Usage

### Server-Side
```typescript
import { appRouter } from '@/src/server/routers/app'
import { createCallerFactory } from '@trpc/server'

const createCaller = createCallerFactory(appRouter)
const caller = createCaller({})

// Call procedures
const status = await caller.device.getStatus({ side: 'left' })
```

### Client-Side (Next.js)
```typescript
import { trpc } from '@/src/lib/trpc'

export default function Component() {
  const { data } = trpc.device.getStatus.useQuery({ side: 'left' })
  const setTemp = trpc.device.setTemperature.useMutation()

  return <button onClick={() => setTemp.mutate({ side: 'left', temperature: 70 })}>
    Set Temperature
  </button>
}
```

## API Endpoint

All routers are accessible via:
- **Endpoint:** `/api/trpc` (handled by Next.js App Router)
- **Route Handler:** [`app/api/(auth)/trpc/[trpc]/route.ts`](../../../app/api/(auth)/trpc/[trpc]/route.ts)
- **Protocol:** HTTP/HTTPS (tRPC over Fetch adapter)

## Related Documentation

- [Authentication Strategy](../../../app/api/(auth)/README.md) - Why no auth currently
- [Hardware Integration](../../hardware/README.md) - Physical device communication
- [Database Schema](../../db/README.md) - Data storage architecture
- [tRPC Review Report](../../../docs/trpc-review-2026-02-23.md) - Comprehensive analysis

---

**Last Updated:** 2026-02-23
