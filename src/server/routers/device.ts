import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { db, biometricsDb } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { bedTemp, waterLevelReadings } from '@/src/db/biometrics-schema'
import { eq, desc } from 'drizzle-orm'
import { withHardwareClient } from '@/src/server/helpers'
import { getPrimeCompletedAt, dismissPrimeNotification } from '@/src/hardware/primeNotification'
import { snoozeAlarm, cancelSnooze, getSnoozeStatus } from '@/src/hardware/snoozeManager'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { HardwareCommand, fahrenheitToLevel } from '@/src/hardware/types'
import { sendCommand } from '@/src/hardware/dacTransport'
import {
  sideSchema,
  temperatureSchema,
  vibrationIntensitySchema,
  vibrationPatternSchema,
  alarmDurationSchema,
} from '@/src/server/validation-schemas'
import { toC, centiDegreesToC, centiPercentToPercent } from '@/src/lib/tempUtils'
import { getWifiInfo } from '@/src/hardware/wifi'

// ---------------------------------------------------------------------------
// Command name → HardwareCommand mapping for the raw execute endpoint
// ---------------------------------------------------------------------------

const COMMAND_MAP: Record<string, HardwareCommand> = {
  SET_TEMP: HardwareCommand.SET_TEMP,
  SET_ALARM: HardwareCommand.SET_ALARM,
  ALARM_LEFT: HardwareCommand.ALARM_LEFT,
  ALARM_RIGHT: HardwareCommand.ALARM_RIGHT,
  SET_SETTINGS: HardwareCommand.SET_SETTINGS,
  PRIME: HardwareCommand.PRIME,
  DEVICE_STATUS: HardwareCommand.DEVICE_STATUS,
  ALARM_CLEAR: HardwareCommand.ALARM_CLEAR,
}

// ---------------------------------------------------------------------------
// Server-side temperature debounce
// Collapses rapid setTemperature calls (e.g. dial drag) into one hardware command.
// Each side has its own debounce timer. Last value wins.
// ---------------------------------------------------------------------------

const TEMP_DEBOUNCE_MS = 200

interface PendingTemp {
  temperature: number
  duration?: number
  timer: ReturnType<typeof setTimeout>
  resolve: (value: { success: boolean }) => void
  reject: (error: unknown) => void
}

const pendingTemps = new Map<string, PendingTemp>()

/**
 * Device control router - direct hardware control for immediate operations.
 *
 * Use this router when you need real-time control vs scheduled operations.
 * Operations execute immediately against hardware and sync state to database.
 *
 * Note: Each operation creates a new hardware connection. For high-frequency
 * polling, consider caching device state from database instead.
 */
export const deviceRouter = router({
  /**
   * Get current device status directly from hardware.
   *
   * Queries the Pod hardware controller for current temperature, power state,
   * and alarm status. Use this when you need authoritative real-time data.
   * For less critical reads, query device_state table instead to avoid
   * hardware connection overhead.
   *
   * Behavior:
   * - Connects to hardware, reads status, disconnects
   * - Updates database with current readings
   * - Connection has ~25s timeout (hardware may be slow to respond)
   * - Safe to poll every ~5-10 seconds (hardware controller can handle it)
   *
   * Database Sync:
   * - Uses separate updates per side (not bulk insert) to handle primary key
   *   constraint (side) correctly with onConflictDoUpdate
   * - If database update fails, hardware read still succeeds but state isn't cached
   *
   * @throws {TRPCError} INTERNAL_SERVER_ERROR if hardware connection fails
   * @throws {TRPCError} INTERNAL_SERVER_ERROR if hardware doesn't respond within timeout
   */
  getStatus: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/device/status', protect: false, tags: ['Device'] } })
    .input(z.object({ unit: z.enum(['F', 'C']).default('F') }).strict())
    .output(z.any())
    .query(async ({ input }) => {
      return withHardwareClient(async (client) => {
        const status = await client.getDeviceStatus()

        // Best-effort DB sync — next getStatus() call will re-sync if this fails
        try {
          await db
            .insert(deviceState)
            .values({
              side: 'left',
              currentTemperature: status.leftSide.currentTemperature,
              targetTemperature: status.leftSide.targetTemperature,
              isPowered: status.leftSide.targetLevel !== 0,
              lastUpdated: new Date(),
            })
            .onConflictDoUpdate({
              target: deviceState.side,
              set: {
                currentTemperature: status.leftSide.currentTemperature,
                targetTemperature: status.leftSide.targetTemperature,
                isPowered: status.leftSide.targetLevel !== 0,
                lastUpdated: new Date(),
              },
            })

          await db
            .insert(deviceState)
            .values({
              side: 'right',
              currentTemperature: status.rightSide.currentTemperature,
              targetTemperature: status.rightSide.targetTemperature,
              isPowered: status.rightSide.targetLevel !== 0,
              lastUpdated: new Date(),
            })
            .onConflictDoUpdate({
              target: deviceState.side,
              set: {
                currentTemperature: status.rightSide.currentTemperature,
                targetTemperature: status.rightSide.targetTemperature,
                isPowered: status.rightSide.targetLevel !== 0,
                lastUpdated: new Date(),
              },
            })
        }
        catch (dbError) {
          console.error('Failed to sync device status to DB:', dbError)
        }

        const primeCompletedAt = getPrimeCompletedAt()
        const leftSnooze = getSnoozeStatus('left')
        const rightSnooze = getSnoozeStatus('right')

        const convertTemp = (f: number) => input.unit === 'C' ? Math.round(toC(f) * 10) / 10 : f

        // Best-effort enrichment — nulls on failure
        let wifiStrength: number = -1
        let wifiSSID: string = 'unknown'
        let roomClimate: { temperatureC: number | null, humidity: number | null, timestamp: number | null } = { temperatureC: null, humidity: null, timestamp: null }
        let waterLevel: { level: 'low' | 'ok' | null, timestamp: number | null } = { level: null, timestamp: null }
        try {
          const wifi = getWifiInfo()
          wifiStrength = wifi.wifiStrength
          wifiSSID = wifi.wifiSSID

          const [latestBed] = await biometricsDb.select().from(bedTemp).orderBy(desc(bedTemp.timestamp)).limit(1)
          if (latestBed) {
            roomClimate = {
              temperatureC: latestBed.ambientTemp !== null ? centiDegreesToC(latestBed.ambientTemp) : null,
              humidity: latestBed.humidity !== null ? centiPercentToPercent(latestBed.humidity) : null,
              timestamp: latestBed.timestamp ? latestBed.timestamp.getTime() : null,
            }
          }
          const [latestWater] = await biometricsDb.select().from(waterLevelReadings).orderBy(desc(waterLevelReadings.timestamp)).limit(1)
          if (latestWater) {
            waterLevel = {
              level: latestWater.level,
              timestamp: latestWater.timestamp ? latestWater.timestamp.getTime() : null,
            }
          }
        }
        catch { /* enrichment is best-effort */ }

        return {
          ...status,
          leftSide: {
            ...status.leftSide,
            currentTemperature: convertTemp(status.leftSide.currentTemperature),
            targetTemperature: convertTemp(status.leftSide.targetTemperature),
          },
          rightSide: {
            ...status.rightSide,
            currentTemperature: convertTemp(status.rightSide.currentTemperature),
            targetTemperature: convertTemp(status.rightSide.targetTemperature),
          },
          ...(primeCompletedAt && { primeCompletedNotification: { timestamp: primeCompletedAt } }),
          snooze: { left: leftSnooze, right: rightSnooze },
          wifiStrength,
          wifiSSID,
          roomClimate,
          waterLevel,
        }
      }, 'Failed to get device status')
    }),

  /**
   * Set target temperature for a pod side.
   *
   * Hardware Timing:
   * - Command executes immediately but physical temperature change takes time
   * - Pod heats/cools at approximately 1-2°F per minute
   * - Temperature change from 68°F to 75°F takes roughly 4-7 minutes
   * - Poll getStatus() to monitor actual temperature progress
   *
   * Temperature Range (55-110°F):
   * - Constrained by hardware heating/cooling capacity
   * - Values outside range will fail validation before reaching hardware
   *
   * Duration Parameter:
   * - If provided: Hardware maintains temperature for N seconds, then returns to neutral (82.5°F)
   * - If omitted: Defaults to 28800 seconds (8 hours)
   * - Hardware handles timing automatically (no background jobs needed)
   *
   * Database State:
   * - Updates target temperature immediately (optimistic)
   * - Race condition: getStatus() called immediately after may show old current temp
   *   but new target temp while hardware is still heating/cooling
   *
   * Concurrent Operations:
   * - Commands are queued and executed sequentially at hardware level
   * - Safe to call from multiple clients, but later calls override earlier targets
   *
   * @param side - Which side to control ('left' or 'right')
   * @param temperature - Target in Fahrenheit (hardware limits: 55-110°F)
   * @param duration - Optional: seconds to maintain temperature before returning to neutral
   * @throws {TRPCError} INTERNAL_SERVER_ERROR if hardware connection fails or rejects command
   */
  setTemperature: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/device/temperature', protect: false, tags: ['Device'] } })
    .input(
      z
        .object({
          side: sideSchema,
          temperature: temperatureSchema,
          duration: z.number().int().min(0).optional(),
        })
        .strict()
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      // Server-side debounce: collapse rapid dial-drag calls into one hardware command.
      // Cancel any pending hardware call for this side BEFORE the first await
      // so ordering is consistent with other side commands (setPower, setAlarm, etc.)
      const existing = pendingTemps.get(input.side)
      if (existing) {
        clearTimeout(existing.timer)
        existing.resolve({ success: true }) // resolve the earlier promise immediately
      }

      // The DB is updated optimistically on every call for responsive UI.
      try {
        await db
          .update(deviceState)
          .set({
            targetTemperature: input.temperature,
            isPowered: true,
            lastUpdated: new Date(),
          })
          .where(eq(deviceState.side, input.side))
      }
      catch (dbError) {
        console.error('Failed to sync temperature state to DB:', dbError)
      }

      return new Promise<{ success: boolean }>((resolve, reject) => {
        // Register the pending entry synchronously so later calls can cancel it
        const timer = setTimeout(async () => {
          pendingTemps.delete(input.side)
          try {
            await withHardwareClient(async (client) => {
              await client.setTemperature(input.side, input.temperature, input.duration)
              return { success: true }
            }, 'Failed to set temperature')
            broadcastMutationStatus(input.side, {
              targetTemperature: input.temperature,
              targetLevel: fahrenheitToLevel(input.temperature),
            })
            resolve({ success: true })
          }
          catch (error) {
            reject(error)
          }
        }, TEMP_DEBOUNCE_MS)

        pendingTemps.set(input.side, {
          temperature: input.temperature,
          duration: input.duration,
          timer,
          resolve,
          reject,
        })
      })
    }),

  /**
   * Control power state for a pod side.
   *
   * Hardware Behavior:
   * - ON (powered=true): Sets temperature (default 75°F) and activates heating/cooling
   *   75°F chosen as comfortable neutral temperature for most users
   * - OFF (powered=false): Sets temperature level to 0 (neutral/82.5°F), stops regulation
   *   Note: Hardware has no true "off" state - level 0 achieves same effect
   *
   * Temperature Parameter:
   * - Only used when powering ON
   * - If omitted when powering on, defaults to 75°F
   * - Ignored when powering OFF
   *
   * Relationship to Schedules:
   * - Manual power changes don't disable scheduled power operations
   * - Next scheduled power event will override manual setting
   *
   * @param side - Which side to control
   * @param powered - true to power on, false to set to neutral
   * @param temperature - Target temp when powering on (default: 75°F, range: 55-110°F)
   * @throws {TRPCError} INTERNAL_SERVER_ERROR if hardware connection fails
   */
  setPower: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/device/power', protect: false, tags: ['Device'] } })
    .input(
      z
        .object({
          side: sideSchema,
          powered: z.boolean(),
          temperature: temperatureSchema.optional(),
        })
        .strict()
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      return withHardwareClient(async (client) => {
        await client.setPower(input.side, input.powered, input.temperature)

        // Best-effort DB sync — next getStatus() call will re-sync if this fails
        try {
          await db
            .update(deviceState)
            .set({
              isPowered: input.powered,
              ...(input.temperature && { targetTemperature: input.temperature }),
              lastUpdated: new Date(),
            })
            .where(eq(deviceState.side, input.side))
        }
        catch (dbError) {
          console.error('Failed to sync power state to DB:', dbError)
        }

        broadcastMutationStatus(input.side, input.powered
          ? { targetTemperature: input.temperature ?? 75, targetLevel: fahrenheitToLevel(input.temperature ?? 75) }
          : { targetLevel: 0 },
        )
        return { success: true }
      }, 'Failed to set power')
    }),

  /**
   * Configure and activate vibration alarm for a pod side.
   *
   * Timing:
   * - Alarm starts vibrating IMMEDIATELY when command executes
   * - This is NOT for scheduling future alarms - use schedules router for that
   * - Runs for specified duration, then stops automatically
   *
   * Vibration Patterns:
   * - 'double': Two quick bursts - more abrupt, better for heavy sleepers
   * - 'rise': Gradually increasing intensity - gentler wake-up experience
   *
   * Hardware Limits:
   * - Intensity: 1-100 (hardware vibration motor capability)
   * - Duration: 0-180 seconds max (firmware protection against motor overheating)
   * - Only one alarm can be active per side at a time - new alarm overrides previous
   *
   * Concurrent Alarms:
   * - Left and right alarms are independent, can run simultaneously
   * - Setting alarm while one is already running replaces it immediately
   *
   * Database State:
   * - Sets isAlarmVibrating to true
   * - Database doesn't track when alarm stops - poll getStatus() for current state
   *
   * @param side - Which side to vibrate
   * @param vibrationIntensity - Motor intensity 1-100 (1=barely perceptible, 100=maximum)
   * @param vibrationPattern - 'double' for abrupt wake, 'rise' for gradual
   * @param duration - How long to vibrate in seconds (max 180 to protect motor)
   * @throws {TRPCError} INTERNAL_SERVER_ERROR if hardware rejects config or connection fails
   */
  setAlarm: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/device/alarm', protect: false, tags: ['Device'] } })
    .input(
      z
        .object({
          side: sideSchema,
          vibrationIntensity: vibrationIntensitySchema,
          vibrationPattern: vibrationPatternSchema,
          duration: alarmDurationSchema,
        })
        .strict()
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      return withHardwareClient(async (client) => {
        cancelSnooze(input.side)
        await client.setAlarm(input.side, {
          vibrationIntensity: input.vibrationIntensity,
          vibrationPattern: input.vibrationPattern,
          duration: input.duration,
        })

        // Best-effort DB sync — next getStatus() call will re-sync if this fails
        try {
          await db
            .update(deviceState)
            .set({
              isAlarmVibrating: true,
              lastUpdated: new Date(),
            })
            .where(eq(deviceState.side, input.side))
        }
        catch (dbError) {
          console.error('Failed to sync alarm state to DB:', dbError)
        }

        broadcastMutationStatus(input.side, { isAlarmVibrating: true })
        return { success: true }
      }, 'Failed to set alarm')
    }),

  /**
   * Stop the vibration alarm for a pod side.
   *
   * Behavior:
   * - Stops currently vibrating alarm immediately
   * - Safe to call even if no alarm is active (hardware ignores redundant clears)
   * - Only affects currently running alarm, not scheduled future alarms
   *
   * @param side - Which side alarm to stop
   * @throws {TRPCError} INTERNAL_SERVER_ERROR if hardware connection fails
   */
  clearAlarm: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/device/alarm/clear', protect: false, tags: ['Device'] } })
    .input(
      z
        .object({
          side: sideSchema,
        })
        .strict()
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      return withHardwareClient(async (client) => {
        await client.clearAlarm(input.side)
        cancelSnooze(input.side)

        // Best-effort DB sync — next getStatus() call will re-sync if this fails
        try {
          await db
            .update(deviceState)
            .set({
              isAlarmVibrating: false,
              lastUpdated: new Date(),
            })
            .where(eq(deviceState.side, input.side))
        }
        catch (dbError) {
          console.error('Failed to sync alarm clear state to DB:', dbError)
        }

        broadcastMutationStatus(input.side, { isAlarmVibrating: false })
        return { success: true }
      }, 'Failed to clear alarm')
    }),

  /**
   * Snooze an active alarm. Stops vibration immediately, restarts after duration.
   */
  snoozeAlarm: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/device/alarm/snooze', protect: false, tags: ['Device'] } })
    .input(
      z.object({
        side: sideSchema,
        duration: z.number().int().min(60).max(1800).default(300),
        vibrationIntensity: vibrationIntensitySchema.default(50),
        vibrationPattern: vibrationPatternSchema.default('rise'),
        alarmDuration: alarmDurationSchema.default(120),
      }).strict()
    )
    .output(z.object({ success: z.boolean(), snoozeUntil: z.number() }))
    .mutation(async ({ input }) => {
      return withHardwareClient(async (client) => {
        await client.clearAlarm(input.side)

        const snoozeUntil = snoozeAlarm(input.side, input.duration, {
          vibrationIntensity: input.vibrationIntensity,
          vibrationPattern: input.vibrationPattern,
          duration: input.alarmDuration,
        })

        try {
          await db
            .update(deviceState)
            .set({ isAlarmVibrating: false, lastUpdated: new Date() })
            .where(eq(deviceState.side, input.side))
        }
        catch (dbError) {
          console.error('Failed to sync snooze state to DB:', dbError)
        }

        broadcastMutationStatus(input.side, { isAlarmVibrating: false })
        return { success: true, snoozeUntil: Math.floor(snoozeUntil.getTime() / 1000) }
      }, 'Failed to snooze alarm')
    }),

  /**
   * Initiate the pod water system priming sequence.
   *
   * Purpose:
   * - Circulates water through the system to remove air bubbles
   * - Ensures proper thermal performance by eliminating air pockets
   * - Required for optimal heating/cooling efficiency
   *
   * When to Prime:
   * - After initial pod setup or water fill
   * - When water level indicator shows low
   * - After extended periods of non-use (>1 week without operation)
   * - If heating/cooling performance seems degraded
   *
   * Timing:
   * - Typically completes in 2-5 minutes
   * - Hardware handles the sequence automatically
   * - Poll getStatus() to check when isPriming field returns to false
   * - No database state tracking - status only available from hardware
   *
   * IMPORTANT WARNINGS:
   * - Do NOT run priming while someone is lying on the pod
   * - Process is loud and causes noticeable vibrations
   * - Will interrupt sleep if run during use
   *
   * Concurrent Execution:
   * - Calling while already priming will likely error from hardware
   * - Check getStatus().isPriming before calling if unsure
   *
   * @throws {TRPCError} INTERNAL_SERVER_ERROR if hardware rejects command (e.g., already priming)
   * @throws {TRPCError} INTERNAL_SERVER_ERROR if hardware connection fails
   */
  startPriming: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/device/prime', protect: false, tags: ['Device'] } })
    .input(z.object({}))
    .output(z.object({ success: z.boolean() }))
    .mutation(async () => {
      return withHardwareClient(async (client) => {
        await client.startPriming()
        return { success: true }
      }, 'Failed to start priming')
    }),

  /**
   * Dismiss the prime completion notification.
   * No-op if no notification is active.
   */
  dismissPrimeNotification: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/device/prime/dismiss', protect: false, tags: ['Device'] } })
    .input(z.object({}))
    .output(z.object({ success: z.boolean() }))
    .mutation(() => {
      dismissPrimeNotification()
      return { success: true }
    }),

  // ---------------------------------------------------------------------------
  // POWER USER / DEBUG FEATURE — Raw Hardware Command Execution
  //
  // This endpoint is a passthrough to the hardware command protocol. It does
  // NOT validate arguments, does NOT apply safety/debounce mechanisms, and
  // does NOT sync state to the database. Misuse can damage hardware or cause
  // unexpected behavior. Use at your own risk.
  //
  // See ADR 0016 for rationale and consequences.
  // ---------------------------------------------------------------------------

  /**
   * Execute a raw hardware command by name.
   *
   * Bypasses all high-level validation, debounce, and DB sync. The command
   * name is allowlisted but the args string is passed through verbatim.
   */
  execute: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/device/execute', protect: false, tags: ['Device'] } })
    .input(z.object({
      command: z.enum(['SET_TEMP', 'SET_ALARM', 'ALARM_LEFT', 'ALARM_RIGHT', 'SET_SETTINGS', 'PRIME', 'DEVICE_STATUS', 'ALARM_CLEAR']),
      args: z.string().optional(),
    }).strict())
    .output(z.any())
    .mutation(async ({ input }) => {
      const hwCommand = COMMAND_MAP[input.command]

      try {
        const response = await sendCommand(hwCommand, input.args)

        return {
          command: input.command,
          args: input.args ?? null,
          response,
          disclaimer: 'WARNING: Raw command execution. No validation, no safety checks. Misuse can damage hardware or cause unexpected behavior. Use at your own risk. This feature is unsupported.',
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to execute raw command: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
