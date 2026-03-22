import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, db } from '@/src/db'
import { sleepRecords, vitals, movement } from '@/src/db/biometrics-schema'
import { deviceSettings } from '@/src/db/schema'
import { eq, and, gte, lte, desc, asc, avg, min, max, count } from 'drizzle-orm'
import { sideSchema, idSchema, validateDateRange } from '@/src/server/validation-schemas'
import { listRawFiles } from './raw'
import {
  classifySleepStages,
  mergeIntoBlocks,
  calculateDistribution,
  calculateQualityScore,
  type SleepStagesResult,
} from '@/src/lib/sleep-stages'

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
    .meta({ openapi: { method: 'GET', path: '/biometrics/sleep-records', protect: false, tags: ['Biometrics'] } })
    .output(z.any())
    .input(
      z
        .object({
          side: sideSchema.optional(),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict()
    )
    .query(async ({ input }) => {
      try {
        if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'startDate must be before or equal to endDate',
          })
        }

        const conditions = []
        if (input.side) {
          conditions.push(eq(sleepRecords.side, input.side))
        }

        if (input.startDate) {
          conditions.push(gte(sleepRecords.enteredBedAt, input.startDate))
        }

        if (input.endDate) {
          conditions.push(lte(sleepRecords.enteredBedAt, input.endDate))
        }

        const records = await biometricsDb
          .select()
          .from(sleepRecords)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
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
    .meta({ openapi: { method: 'GET', path: '/biometrics/vitals', protect: false, tags: ['Biometrics'] } })
    .output(z.any())
    .input(
      z
        .object({
          side: sideSchema.optional(),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          limit: z.number().int().min(1).max(1000).default(288), // Default: 24 hours of 5-min intervals
        })
        .strict()
    )
    .query(async ({ input }) => {
      try {
        if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'startDate must be before or equal to endDate',
          })
        }

        const conditions = []
        if (input.side) {
          conditions.push(eq(vitals.side, input.side))
        }

        if (input.startDate) {
          conditions.push(gte(vitals.timestamp, input.startDate))
        }

        if (input.endDate) {
          conditions.push(lte(vitals.timestamp, input.endDate))
        }

        const records = await biometricsDb
          .select()
          .from(vitals)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
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
    .meta({ openapi: { method: 'GET', path: '/biometrics/movement', protect: false, tags: ['Biometrics'] } })
    .output(z.any())
    .input(
      z
        .object({
          side: sideSchema.optional(),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          limit: z.number().int().min(1).max(1000).default(288),
        })
        .strict()
    )
    .query(async ({ input }) => {
      try {
        if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'startDate must be before or equal to endDate',
          })
        }

        const conditions = []
        if (input.side) {
          conditions.push(eq(movement.side, input.side))
        }

        if (input.startDate) {
          conditions.push(gte(movement.timestamp, input.startDate))
        }

        if (input.endDate) {
          conditions.push(lte(movement.timestamp, input.endDate))
        }

        const records = await biometricsDb
          .select()
          .from(movement)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
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
    .meta({ openapi: { method: 'GET', path: '/biometrics/sleep-records/latest', protect: false, tags: ['Biometrics'] } })
    .input(
      z
        .object({
          side: sideSchema,
        })
        .strict()
    )
    .output(z.any())
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
    .meta({ openapi: { method: 'GET', path: '/biometrics/vitals/summary', protect: false, tags: ['Biometrics'] } })
    .output(z.any())
    .input(
      z
        .object({
          side: sideSchema,
          startDate: z.date().optional(),
          endDate: z.date().optional(),
        })
        .strict()
    )
    .query(async ({ input }) => {
      try {
        if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'startDate must be before or equal to endDate',
          })
        }

        const now = new Date()
        const effectiveStart = input.startDate ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        const effectiveEnd = input.endDate ?? now

        // Guard against inverted range (e.g., endDate older than default startDate)
        if (effectiveStart > effectiveEnd) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Computed date range is inverted — startDate is after endDate',
          })
        }

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
              gte(vitals.timestamp, effectiveStart),
              lte(vitals.timestamp, effectiveEnd)
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
    .meta({ openapi: { method: 'POST', path: '/biometrics/vitals', protect: false, tags: ['Biometrics'] } })
    .input(
      z.object({
        side: sideSchema,
        timestamp: z.number().int(),
        heartRate: z.number().nullable(),
        hrv: z.number().nullable(),
        breathingRate: z.number().nullable(),
      }).strict()
    )
    .output(z.object({ written: z.number() }))
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
    .meta({ openapi: { method: 'POST', path: '/biometrics/vitals/batch', protect: false, tags: ['Biometrics'] } })
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
    .output(z.object({ written: z.number() }))
    .mutation(async ({ input }) => {
      try {
        const rows = input.vitals.map(v => ({
          side: v.side as 'left' | 'right',
          timestamp: new Date(v.timestamp * 1000),
          heartRate: v.heartRate,
          hrv: v.hrv,
          breathingRate: v.breathingRate,
        }))

        const inserted = await biometricsDb
          .insert(vitals)
          .values(rows)
          .onConflictDoNothing()
          .returning()

        return { written: inserted.length }
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
   * Returns the count of RAW biometrics files and total size.
   * RAW files are dual-channel (left + right interleaved), so left = right = total count.
   * Designed for the iOS Status screen.
   */
  getFileCount: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/file-count', protect: false, tags: ['Biometrics'] } })
    .input(z.object({}))
    .output(z.object({
      rawFiles: z.object({
        left: z.number(),
        right: z.number(),
      }),
      totalSizeMB: z.number(),
    }))
    .query(async () => {
      try {
        const files = await listRawFiles()
        const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
        const totalSizeMB = Math.round((totalBytes / (1024 * 1024)) * 100) / 100
        return {
          rawFiles: { left: files.length, right: files.length },
          totalSizeMB,
        }
      }
      catch {
        return { rawFiles: { left: 0, right: 0 }, totalSizeMB: 0 }
      }
    }),

  /**
   * Update a sleep record (e.g., correct erroneous bed times).
   * Recalculates sleepDurationSeconds from the updated timestamps.
   */
  updateSleepRecord: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/biometrics/sleep-records', protect: false, tags: ['Biometrics'] } })
    .input(
      z.object({
        id: idSchema,
        enteredBedAt: z.date().optional(),
        leftBedAt: z.date().optional(),
        timesExitedBed: z.number().int().min(0).optional(),
      }).strict()
    )
    .output(z.any())
    .mutation(async ({ input }) => {
      const { id, ...updates } = input

      // If both timestamps provided, recalculate duration
      const setValues: Record<string, unknown> = {}
      if (updates.enteredBedAt) setValues.enteredBedAt = updates.enteredBedAt
      if (updates.leftBedAt) setValues.leftBedAt = updates.leftBedAt
      if (updates.timesExitedBed !== undefined) setValues.timesExitedBed = updates.timesExitedBed

      if (Object.keys(setValues).length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No fields to update' })
      }

      // Wrap in transaction to avoid TOCTOU race on select+update
      return biometricsDb.transaction((tx) => {
        // If either timestamp changed, recalculate duration from current + new values
        if (updates.enteredBedAt || updates.leftBedAt) {
          const [existing] = tx
            .select()
            .from(sleepRecords)
            .where(eq(sleepRecords.id, id))
            .limit(1)
            .all()

          if (!existing) {
            throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${id} not found` })
          }

          const entered = updates.enteredBedAt ?? existing.enteredBedAt
          const left = updates.leftBedAt ?? existing.leftBedAt
          if (left <= entered) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'leftBedAt must be after enteredBedAt' })
          }
          setValues.sleepDurationSeconds = Math.round((left.getTime() - entered.getTime()) / 1000)
        }

        const [updated] = tx
          .update(sleepRecords)
          .set(setValues)
          .where(eq(sleepRecords.id, id))
          .returning()
          .all()

        if (!updated) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${id} not found` })
        }

        return updated
      })
    }),

  /**
   * Delete a sleep record.
   */
  deleteSleepRecord: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/biometrics/sleep-records', protect: false, tags: ['Biometrics'] } })
    .input(z.object({ id: idSchema }).strict())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      const [deleted] = await biometricsDb
        .delete(sleepRecords)
        .where(eq(sleepRecords.id, input.id))
        .returning()

      if (!deleted) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${input.id} not found` })
      }

      return { success: true }
    }),

  /**
   * Get classified sleep stages for a specific sleep record or date range.
   *
   * Performs server-side sleep stage classification by:
   * 1. Fetching the sleep record (if sleepRecordId provided) or using date range
   * 2. Querying vitals + movement data within that window
   * 3. Running the rule-based classifier (ported from iOS SleepAnalyzer)
   * 4. Returning epochs, merged blocks, distribution, and quality score
   *
   * @param side - Which side to classify
   * @param sleepRecordId - Optional: classify stages for a specific sleep record
   * @param startDate - Optional: start of custom date range
   * @param endDate - Optional: end of custom date range
   * @returns Classified sleep stages with blocks, distribution, and quality score
   */
  getSleepStages: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/sleep-stages', protect: false, tags: ['Biometrics'] } })
    .input(
      z
        .object({
          side: sideSchema,
          sleepRecordId: z.number().int().optional(),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
        })
        .strict()
    )
    .output(z.object({
      epochs: z.array(z.object({
        start: z.number(),
        duration: z.number(),
        stage: z.enum(['wake', 'light', 'deep', 'rem']),
        heartRate: z.number().nullable(),
        hrv: z.number().nullable(),
        breathingRate: z.number().nullable(),
        movement: z.number().nullable(),
      })),
      blocks: z.array(z.object({
        start: z.number(),
        end: z.number(),
        stage: z.enum(['wake', 'light', 'deep', 'rem']),
      })),
      distribution: z.object({
        wake: z.number(),
        light: z.number(),
        deep: z.number(),
        rem: z.number(),
      }),
      qualityScore: z.number(),
      totalSleepMs: z.number(),
      sleepRecordId: z.number().nullable(),
      enteredBedAt: z.number().nullable(),
      leftBedAt: z.number().nullable(),
    }))
    .query(async ({ input }): Promise<SleepStagesResult> => {
      try {
        // Reject ambiguous requests: if sleepRecordId is provided alongside date range, error out
        if (input.sleepRecordId && (input.startDate || input.endDate)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Provide either sleepRecordId or startDate/endDate, not both',
          })
        }

        let windowStart: Date
        let windowEnd: Date
        let sleepRecordId: number | null = null
        let enteredBedAt: number | null = null
        let leftBedAt: number | null = null

        if (input.sleepRecordId) {
          // Look up the sleep record, scoped to the requested side
          const [record] = await biometricsDb
            .select()
            .from(sleepRecords)
            .where(
              and(
                eq(sleepRecords.id, input.sleepRecordId),
                eq(sleepRecords.side, input.side),
              )
            )
            .limit(1)

          if (!record) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Sleep record ${input.sleepRecordId} not found for side '${input.side}'`,
            })
          }

          // Handle active sleep records where leftBedAt may not be set yet
          if (!record.leftBedAt) {
            windowStart = record.enteredBedAt
            windowEnd = new Date() // use current time for active sessions
          } else {
            windowStart = record.enteredBedAt
            windowEnd = record.leftBedAt
          }
          sleepRecordId = record.id
          enteredBedAt = record.enteredBedAt.getTime()
          leftBedAt = record.leftBedAt ? record.leftBedAt.getTime() : null
        } else if (input.startDate && input.endDate) {
          if (!validateDateRange(input.startDate, input.endDate)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'startDate must be before or equal to endDate',
            })
          }
          windowStart = input.startDate
          windowEnd = input.endDate
        } else {
          // Default: last night — prefer overnight sleep over daytime naps

          // Fetch device timezone (falls back to 'America/Los_Angeles' if not set)
          const [settings] = await db.select({ timezone: deviceSettings.timezone }).from(deviceSettings).limit(1)
          const tz = settings?.timezone ?? 'America/Los_Angeles'

          // Fetch recent records (last 7 days) to search for an overnight session
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          const recentRecords = await biometricsDb
            .select()
            .from(sleepRecords)
            .where(
              and(
                eq(sleepRecords.side, input.side),
                gte(sleepRecords.enteredBedAt, sevenDaysAgo)
              )
            )
            .orderBy(desc(sleepRecords.enteredBedAt))

          // Helper: get local hour (0–23) of a Date in the device timezone
          const localHour = (d: Date): number => {
            const parts = new Intl.DateTimeFormat('en-US', {
              timeZone: tz,
              hour: 'numeric',
              hour12: false,
            }).formatToParts(d)
            return parseInt(parts.find(p => p.type === 'hour')!.value, 10)
          }

          // 1st try: 3+ hours AND entered bed between 8 PM (20) and 4 AM (4) local time
          const overnightRecord = recentRecords.find(r => {
            if (r.sleepDurationSeconds < 10800) return false
            const hour = localHour(r.enteredBedAt)
            return hour >= 20 || hour < 4
          })

          let record = overnightRecord

          if (!record) {
            // 2nd try: longest record in the last 24 hours
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
            const last24h = recentRecords.filter(r => r.enteredBedAt >= oneDayAgo)
            if (last24h.length > 0) {
              record = last24h.reduce((best, r) =>
                r.sleepDurationSeconds > best.sleepDurationSeconds ? r : best
              )
            }
          }

          if (!record) {
            // Final fallback: most recent record regardless of time or duration
            record = recentRecords[0]
          }

          if (!record) {
            return {
              epochs: [],
              blocks: [],
              distribution: { wake: 0, light: 0, deep: 0, rem: 0 },
              qualityScore: 0,
              totalSleepMs: 0,
              sleepRecordId: null,
              enteredBedAt: null,
              leftBedAt: null,
            }
          }

          windowStart = record.enteredBedAt
          windowEnd = record.leftBedAt
          sleepRecordId = record.id
          enteredBedAt = record.enteredBedAt.getTime()
          leftBedAt = record.leftBedAt.getTime()
        }

        // Fetch vitals within the window
        const vitalsData = await biometricsDb
          .select()
          .from(vitals)
          .where(
            and(
              eq(vitals.side, input.side),
              gte(vitals.timestamp, windowStart),
              lte(vitals.timestamp, windowEnd)
            )
          )
          .orderBy(asc(vitals.timestamp))

        // Fetch movement within the window
        const movementData = await biometricsDb
          .select()
          .from(movement)
          .where(
            and(
              eq(movement.side, input.side),
              gte(movement.timestamp, windowStart),
              lte(movement.timestamp, windowEnd)
            )
          )
          .orderBy(asc(movement.timestamp))

        // Classify stages
        const epochs = classifySleepStages(vitalsData, movementData)

        if (epochs.length === 0) {
          return {
            epochs: [],
            blocks: [],
            distribution: { wake: 0, light: 0, deep: 0, rem: 0 },
            qualityScore: 0,
            totalSleepMs: 0,
            sleepRecordId,
            enteredBedAt,
            leftBedAt,
          }
        }

        const blocks = mergeIntoBlocks(epochs)
        const distribution = calculateDistribution(epochs)
        const qualityScore = calculateQualityScore(distribution)
        const totalSleepMs = epochs.reduce((sum, e) => sum + e.duration, 0)

        return {
          epochs,
          blocks,
          distribution,
          qualityScore,
          totalSleepMs,
          sleepRecordId,
          enteredBedAt,
          leftBedAt,
        }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to classify sleep stages: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
