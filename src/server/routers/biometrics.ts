import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb } from '@/src/db'
import { sleepRecords, vitals, movement } from '@/src/db/biometrics-schema'
import { eq, and, gte, lte, desc, avg, min, max, count } from 'drizzle-orm'
import { sideSchema, validateDateRange } from '@/src/server/validation-schemas'
import { isIosProcessing, getConnectedSince } from '@/src/streaming/processingState'

/**
 * Biometrics router - query sleep and health data collected by Pod sensors.
 *
 * Data Collection:
 * - Vitals (heart rate, HRV, breathing): Collected every ~5 minutes during sleep
 * - Movement: Tracked continuously via pressure/accelerometer sensors
 * - Sleep records: Created when user enters/exits bed, tracks sleep sessions
 *
 * Data Sources:
 * - All data comes from Pod hardware sensors (ballistocardiography for vitals)
 * - Historical data only - not suitable for real-time monitoring
 * - Data is synced to database periodically by hardware layer
 *
 * Performance:
 * - Date range queries can be expensive on large datasets
 * - Consider caching summary data for frequently accessed ranges
 * - Limit parameter helps control query size
 */
export const biometricsRouter = router({
  /**
   * Get sleep records for a side within optional date range.
   *
   * Sleep Records:
   * - Created when hardware detects user entering bed (pressure sensors)
   * - Tracks sleep session from enteredBedAt to exitedBedAt
   * - Includes sleep quality metrics, interruptions, and total sleep time
   *
   * Query Behavior:
   * - Returns most recent records first (DESC order by enteredBedAt)
   * - Date filters are inclusive (startDate <= record <= endDate)
   * - Default limit of 30 covers roughly 1 month of nightly sleep data
   *
   * @param side - Which side's sleep records to query
   * @param startDate - Optional: only records on or after this date (inclusive)
   * @param endDate - Optional: only records on or before this date (inclusive)
   * @param limit - Max records to return (default: 30, max: 100)
   * @returns Array of sleep records, most recent first
   */
  getSleepRecords: publicProcedure
    .input(
      z
        .object({
          side: sideSchema,
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict()
        .refine(
          (data) => {
            // Validate date range if both dates are provided
            if (data.startDate && data.endDate) {
              return validateDateRange(data.startDate, data.endDate)
            }
            return true
          },
          {
            message: 'startDate must be before or equal to endDate',
            path: ['endDate'],
          }
        )
    )
    .query(async ({ input }) => {
      try {
        const conditions = [eq(sleepRecords.side, input.side)]

        if (input.startDate) {
          conditions.push(gte(sleepRecords.enteredBedAt, input.startDate))
        }

        if (input.endDate) {
          conditions.push(lte(sleepRecords.enteredBedAt, input.endDate))
        }

        const records = await biometricsDb
          .select()
          .from(sleepRecords)
          .where(and(...conditions))
          .orderBy(desc(sleepRecords.enteredBedAt))
          .limit(input.limit)

        return records
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch sleep records: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get vitals measurements (heart rate, HRV, breathing rate) for a side.
   *
   * Collection Frequency:
   * - Hardware samples vitals every ~5 minutes during detected sleep
   * - Default limit of 288 = 24 hours of 5-minute intervals (24 * 60 / 5)
   * - Covers one full night of sleep with typical 8-10 hour duration
   *
   * Vitals Data:
   * - heartRate: Beats per minute, detected via ballistocardiography
   * - hrv: Heart rate variability in milliseconds (higher = better recovery)
   * - breathingRate: Breaths per minute
   * - Fields may be null if sensor couldn't get reliable reading
   *
   * Use Cases:
   * - Historical vitals analysis and trending
   * - Sleep quality assessment
   * - NOT for real-time monitoring (5-minute lag from hardware)
   *
   * @param side - Which side's vitals to query
   * @param startDate - Optional: only vitals on or after this timestamp
   * @param endDate - Optional: only vitals on or before this timestamp
   * @param limit - Max records (default: 288 for ~24hrs, max: 1000)
   * @returns Array of vitals measurements, most recent first
   */
  getVitals: publicProcedure
    .input(
      z
        .object({
          side: sideSchema,
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          limit: z.number().int().min(1).max(1000).default(288), // Default: 24 hours of 5-min intervals
        })
        .strict()
        .refine(
          (data) => {
            // Validate date range if both dates are provided
            if (data.startDate && data.endDate) {
              return validateDateRange(data.startDate, data.endDate)
            }
            return true
          },
          {
            message: 'startDate must be before or equal to endDate',
            path: ['endDate'],
          }
        )
    )
    .query(async ({ input }) => {
      try {
        const conditions = [eq(vitals.side, input.side)]

        if (input.startDate) {
          conditions.push(gte(vitals.timestamp, input.startDate))
        }

        if (input.endDate) {
          conditions.push(lte(vitals.timestamp, input.endDate))
        }

        const records = await biometricsDb
          .select()
          .from(vitals)
          .where(and(...conditions))
          .orderBy(desc(vitals.timestamp))
          .limit(input.limit)

        return records
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch vitals: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get movement/activity data for a side.
   *
   * Movement Tracking:
   * - Captured via pressure sensors and accelerometers in Pod
   * - Records body movement, position changes, and restlessness
   * - Higher movement values indicate more restless sleep
   *
   * Collection:
   * - Sampled at same frequency as vitals (~5 minute intervals)
   * - Default limit matches vitals (288 = ~24 hours)
   * - Provides context for vitals data (movement affects heart rate readings)
   *
   * Use Cases:
   * - Sleep quality analysis (less movement = better sleep)
   * - Correlate with vitals to identify restless periods
   * - Detect sleep/wake transitions
   *
   * @param side - Which side's movement to query
   * @param startDate - Optional: only records on or after this timestamp
   * @param endDate - Optional: only records on or before this timestamp
   * @param limit - Max records (default: 288, max: 1000)
   * @returns Array of movement measurements, most recent first
   */
  getMovement: publicProcedure
    .input(
      z
        .object({
          side: sideSchema,
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          limit: z.number().int().min(1).max(1000).default(288),
        })
        .strict()
        .refine(
          (data) => {
            // Validate date range if both dates are provided
            if (data.startDate && data.endDate) {
              return validateDateRange(data.startDate, data.endDate)
            }
            return true
          },
          {
            message: 'startDate must be before or equal to endDate',
            path: ['endDate'],
          }
        )
    )
    .query(async ({ input }) => {
      try {
        const conditions = [eq(movement.side, input.side)]

        if (input.startDate) {
          conditions.push(gte(movement.timestamp, input.startDate))
        }

        if (input.endDate) {
          conditions.push(lte(movement.timestamp, input.endDate))
        }

        const records = await biometricsDb
          .select()
          .from(movement)
          .where(and(...conditions))
          .orderBy(desc(movement.timestamp))
          .limit(input.limit)

        return records
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch movement data: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get the most recent sleep record for a side.
   *
   * Use Cases:
   * - Quick lookup of last night's sleep without date filtering
   * - Display current/last sleep session in UI
   * - Check if user is currently in bed (null exitedBedAt)
   *
   * Returns:
   * - Most recent sleep record by enteredBedAt timestamp
   * - null if no sleep records exist (fresh user, no data yet)
   *
   * @param side - Which side to query
   * @returns Latest sleep record or null if no records found
   */
  getLatestSleep: publicProcedure
    .input(
      z
        .object({
          side: sideSchema,
        })
        .strict()
    )
    .query(async ({ input }) => {
      try {
        const [record] = await biometricsDb
          .select()
          .from(sleepRecords)
          .where(eq(sleepRecords.side, input.side))
          .orderBy(desc(sleepRecords.enteredBedAt))
          .limit(1)

        return record || null
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch latest sleep record: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get aggregated vitals statistics for a date range.
   *
   * Computation:
   * - Uses SQL aggregations (AVG, MIN, MAX, COUNT) computed at the database level
   * - SQL aggregate functions automatically ignore NULL values
   * - Returns null for metrics if no valid data points exist
   *
   * Performance:
   * - Efficient for any date range size — only aggregate results are returned
   * - Uses index on (side, timestamp) for the WHERE clause scan
   *
   * Use Cases:
   * - Weekly/monthly vitals trends
   * - Compare sleep quality across date ranges
   * - Health dashboard summary cards
   *
   * @param side - Which side to summarize
   * @param startDate - Start of date range (inclusive)
   * @param endDate - End of date range (inclusive)
   * @returns Summary statistics or null if no vitals data in range
   */
  getVitalsSummary: publicProcedure
    .input(
      z
        .object({
          side: sideSchema,
          startDate: z.date(),
          endDate: z.date(),
        })
        .strict()
        .refine(
          data => validateDateRange(data.startDate, data.endDate),
          {
            message: 'startDate must be before or equal to endDate',
            path: ['endDate'],
          }
        )
    )
    .query(async ({ input }) => {
      try {
        const [summary] = await biometricsDb
          .select({
            avgHeartRate: avg(vitals.heartRate),
            minHeartRate: min(vitals.heartRate),
            maxHeartRate: max(vitals.heartRate),
            avgHRV: avg(vitals.hrv),
            avgBreathingRate: avg(vitals.breathingRate),
            recordCount: count(),
          })
          .from(vitals)
          .where(
            and(
              eq(vitals.side, input.side),
              gte(vitals.timestamp, input.startDate),
              lte(vitals.timestamp, input.endDate)
            )
          )

        if (summary.recordCount === 0) {
          return null
        }

        return {
          avgHeartRate: summary.avgHeartRate !== null ? Number(summary.avgHeartRate) : null,
          minHeartRate: summary.minHeartRate ?? null,
          maxHeartRate: summary.maxHeartRate ?? null,
          avgHRV: summary.avgHRV !== null ? Number(summary.avgHRV) : null,
          avgBreathingRate: summary.avgBreathingRate !== null ? Number(summary.avgBreathingRate) : null,
          recordCount: summary.recordCount,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to calculate vitals summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Report a single vitals measurement from the iOS app.
   * Uses ON CONFLICT to avoid duplicates when pod and iOS both write.
   */
  reportVitals: publicProcedure
    .input(
      z.object({
        side: sideSchema,
        timestamp: z.number().int(),
        heartRate: z.number().nullable(),
        hrv: z.number().nullable(),
        breathingRate: z.number().nullable(),
      }).strict()
    )
    .mutation(async ({ input }) => {
      try {
        await biometricsDb
          .insert(vitals)
          .values({
            side: input.side,
            timestamp: new Date(input.timestamp * 1000),
            heartRate: input.heartRate,
            hrv: input.hrv,
            breathingRate: input.breathingRate,
          })
          .onConflictDoNothing()

        return { written: 1 }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to report vitals: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Report a batch of vitals measurements from the iOS app.
   * Efficient bulk insert with ON CONFLICT to avoid duplicates.
   */
  reportVitalsBatch: publicProcedure
    .input(
      z.object({
        vitals: z.array(z.object({
          side: sideSchema,
          timestamp: z.number().int(),
          heartRate: z.number().nullable(),
          hrv: z.number().nullable(),
          breathingRate: z.number().nullable(),
        })).min(1).max(100),
      }).strict()
    )
    .mutation(async ({ input }) => {
      try {
        const rows = input.vitals.map(v => ({
          side: v.side as 'left' | 'right',
          timestamp: new Date(v.timestamp * 1000),
          heartRate: v.heartRate,
          hrv: v.hrv,
          breathingRate: v.breathingRate,
        }))

        await biometricsDb
          .insert(vitals)
          .values(rows)
          .onConflictDoNothing()

        return { written: rows.length }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to report vitals batch: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Check whether an iOS client is actively processing piezo data.
   */
  getProcessingStatus: publicProcedure
    .query(() => {
      return {
        iosProcessingActive: isIosProcessing(),
        connectedSince: getConnectedSince(),
      }
    }),
})
