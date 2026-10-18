import { summaryProvenanceFields, summaryProvenanceSchema, summarizeVitalProvenance } from '@/src/biometrics/profiles/vital-summary-provenance'
import { vitalProvenance, vitalProvenanceSchema } from '@/src/biometrics/profiles/vital-provenance'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, db } from '@/src/db'
import { sleepRecords, vitals, movement, referenceStages, referenceVitals, referenceSamples, biometricProcessingRuns } from '@/src/db/biometrics-schema'
import { deviceSettings } from '@/src/db/schema'
import { eq, and, gt, gte, lt, lte, desc, asc, avg, min, max, count, sql, getTableColumns } from 'drizzle-orm'
import { sideSchema, idSchema, validateDateRange } from '@/src/server/validation-schemas'
import { listRawFiles } from './raw'
import { loadStageView, loadStageInputs } from './sleepStages'
import { stageViewSchema, type StageView } from '@/src/biometrics/profiles/stage-view'
import {
  classifySleepStages,
  mergeIntoBlocks,
  calculateDistribution,
  calculateQualityScore,
  type SleepStagesResult,
} from '@/src/lib/sleep-stages'
import {
  POSITION_CHANGE_SCORE_MIN,
  RESTLESS_SCORE_MIN,
  pickMinBucketNonStillEpochs,
} from '@/src/lib/movement'
import { recordLegacyReferenceImport } from '@/src/biometrics/references/legacy'
import { getOccupancy } from '@/src/lib/occupancy'

/**
 * SQL fragment: movement.timestamp falls inside an existing sleep_records
 * window for the same side. Used to drop empty-bed sensor noise from
 * movement aggregates and stats.
 *
 * Treats sleep_records.left_bed_at IS NULL as "session still active" by
 * substituting a sentinel far-future timestamp, since the Drizzle output
 * schema permits null even though the writer always sets a value.
 */
function inBedExists(side: 'left' | 'right') {
  return sql`EXISTS (
    SELECT 1 FROM ${sleepRecords}
    WHERE ${sleepRecords.side} = ${side}
      AND ${movement.timestamp} >= ${sleepRecords.enteredBedAt}
      AND ${movement.timestamp} <= COALESCE(${sleepRecords.leftBedAt}, 99999999999)
  )`
}

interface StageSegment { start: number, end: number, stage: string }

const describeSegment = (s: StageSegment) => `${s.stage} ${s.start}-${s.end}`

const sameSegment = (a: StageSegment, b: StageSegment) =>
  a.start === b.start && a.end === b.end && a.stage === b.stage

/** Segment ranges are half-open [start, end), so back-to-back segments do not overlap. */
const segmentsOverlap = (a: StageSegment, b: StageSegment) => a.start < b.end && b.start < a.end

/** Lists up to five conflicts, so a whole bad night does not flood the error. */
function describeConflicts(conflicts: string[]): string {
  const more = conflicts.length > 5 ? `; and ${conflicts.length - 5} more` : ''
  return conflicts.slice(0, 5).join('; ') + more
}

/**
 * Overlapping segments within one post. Identical repeats are not a conflict;
 * the unique index stores them once.
 */
function batchOverlaps(segments: StageSegment[]): string[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const conflicts: string[] = []
  let reach: StageSegment | undefined
  for (const s of sorted) {
    if (reach && s.start < reach.end && !sameSegment(s, reach)) {
      conflicts.push(`${describeSegment(reach)} overlaps ${describeSegment(s)}`)
    }
    if (!reach || s.end > reach.end) reach = s
  }
  return conflicts
}

/** Plausible Apple Watch values per reference_samples metric, in breaths/min and ms. */
export const REFERENCE_SAMPLE_RANGE = { breathing_rate: [4, 60], hrv_sdnn: [1, 500] } as const

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
    .output(z.array(z.object({
      id: z.number(),
      side: sideSchema,
      enteredBedAt: z.date(),
      // null while a session is active (occupant in bed) — gets populated on close.
      leftBedAt: z.date().nullable(),
      sleepDurationSeconds: z.number(),
      timesExitedBed: z.number(),
      presentIntervals: z.unknown(),
      notPresentIntervals: z.unknown(),
      createdAt: z.date(),
    })))
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
      if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'startDate must be before or equal to endDate',
        })
      }

      try {
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
   * - hrv: Stored HRV value in milliseconds; the pod currently emits a window IBI variability index, not clinical RMSSD. Legacy definitions may be unknown.
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
    .output(z.array(z.object({
      id: z.number(),
      side: sideSchema,
      timestamp: z.date(),
      heartRate: z.number().nullable(),
      hrv: z.number().nullable(),
      breathingRate: z.number().nullable(),
      processingRunId: z.string().nullable().optional(),
      provenance: vitalProvenanceSchema.optional(),
    })))
    .input(
      z
        .object({
          side: sideSchema.optional(),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          // A full 30-day range at 30-second cadence needs 86,400 readings.
          limit: z.number().int().min(1).max(100000).default(288),
        })
        .strict()
    )
    .query(async ({ input }) => {
      if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'startDate must be before or equal to endDate',
        })
      }

      try {
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
          .select({
            ...getTableColumns(vitals),
            recordedRunId: biometricProcessingRuns.id,
            recordedSide: biometricProcessingRuns.side,
            recordedKind: biometricProcessingRuns.kind,
            recordedConfigHash: biometricProcessingRuns.configHash,
            recordedHrvMetricId: sql<unknown>`CASE WHEN json_valid(${biometricProcessingRuns.bundle}) THEN json_extract(${biometricProcessingRuns.bundle}, '$.components.hrv_index.metricId') ELSE NULL END`,
          })
          .from(vitals)
          .leftJoin(biometricProcessingRuns, and(eq(vitals.processingRunId, biometricProcessingRuns.id), eq(vitals.side, biometricProcessingRuns.side)))
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(vitals.timestamp))
          .limit(input.limit)

        return records.map(row => ({ id: row.id, side: row.side, timestamp: row.timestamp, heartRate: row.heartRate,
          hrv: row.hrv, breathingRate: row.breathingRate, processingRunId: row.processingRunId ?? null, provenance: vitalProvenance(row) }))
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
    .output(z.array(z.object({
      id: z.number(),
      side: sideSchema,
      timestamp: z.date(),
      totalMovement: z.number(),
    })))
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
   * Get movement aggregated into fixed-width time buckets via SQL, restricted
   * to in-bed windows recorded in sleep_records so empty-bed sensor noise
   * doesn't show up as bars.
   *
   * Why this exists: getMovement returns one row per 60-s epoch and the
   * 1000-row cap chops a week-long view at ~16 hours. This endpoint groups
   * by `floor(timestamp / bucketSeconds) * bucketSeconds` so a 7-day view
   * fits comfortably regardless of bucket size.
   *
   * eventCount per bucket — count of epochs with score >= 200 ("major
   * postural shift", docs/sleep-detector.md). The chart renders this as
   * events-per-hour following Whoop / Garmin convention; raw PIM sums are
   * available via totalMovement for debug / power-user views.
   *
   * Density gate: buckets with fewer than pickMinBucketNonStillEpochs(...)
   * epochs above RESTLESS_SCORE_MIN are dropped. Filters phantom-session
   * flicker that leaks past inBedExists (a noisy session of record can still
   * contain many empty-bed sub-windows). See docs/sleep-detector.md "Chart
   * aggregation" for the rationale.
   *
   * @param bucketSeconds - 60..86400; chart bucket width (e.g. 300 for 5-min)
   */
  getMovementBuckets: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/movement/buckets', protect: false, tags: ['Biometrics'] } })
    .output(z.array(z.object({
      side: sideSchema,
      bucketStart: z.date(),
      totalMovement: z.number(),
      eventCount: z.number(),
      sampleCount: z.number(),
    })))
    .input(
      z
        .object({
          side: sideSchema,
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          bucketSeconds: z.number().int().min(60).max(86400),
          limit: z.number().int().min(1).max(10000).default(2000),
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

        const conditions = [eq(movement.side, input.side), inBedExists(input.side)]
        if (input.startDate) conditions.push(gte(movement.timestamp, input.startDate))
        if (input.endDate) conditions.push(lte(movement.timestamp, input.endDate))

        // Inline bucketSeconds as a literal so SQLite gets `... / 1800) * 1800`
        // rather than parameterized `?`s — the parameterized form did not
        // GROUP BY correctly when this template was reused in select+groupBy.
        // Zod has already validated 60..86400, so no injection surface.
        const bSec = Math.floor(input.bucketSeconds)
        const bucket = sql<number>`(${movement.timestamp} / ${sql.raw(String(bSec))}) * ${sql.raw(String(bSec))}`
        const minNonStill = pickMinBucketNonStillEpochs(bSec)
        const nonStillEpochs = sql<number>`SUM(CASE WHEN ${movement.totalMovement} >= ${sql.raw(String(RESTLESS_SCORE_MIN))} THEN 1 ELSE 0 END)`

        const rows = await biometricsDb
          .select({
            bucketStart: bucket,
            totalMovement: sql<number>`SUM(${movement.totalMovement})`,
            eventCount: sql<number>`COUNT(CASE WHEN ${movement.totalMovement} >= ${sql.raw(String(POSITION_CHANGE_SCORE_MIN))} THEN 1 END)`,
            sampleCount: count(),
          })
          .from(movement)
          .where(and(...conditions))
          .groupBy(bucket)
          .having(sql`${nonStillEpochs} >= ${sql.raw(String(minNonStill))}`)
          .orderBy(desc(bucket))
          .limit(input.limit)

        return rows.map(r => ({
          side: input.side,
          bucketStart: new Date(Number(r.bucketStart) * 1000),
          totalMovement: Number(r.totalMovement ?? 0),
          eventCount: Number(r.eventCount ?? 0),
          sampleCount: Number(r.sampleCount ?? 0),
        }))
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch movement buckets: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Aggregated movement stats for a side and date range, computed in SQL and
   * restricted to in-bed windows from sleep_records.
   *
   * - positionChanges: in-bed epochs with score >= POSITION_CHANGE_SCORE_MIN
   *   (200); each ≈ one postural shift (docs/sleep-detector.md score table).
   * - restlessMinutes: in-bed epochs with score >= RESTLESS_SCORE_MIN (50);
   *   each epoch is 60 s, so the count is already in minutes.
   * - sampleCount: total in-bed epochs in range (sanity / coverage check).
   */
  getMovementSummary: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/movement/summary', protect: false, tags: ['Biometrics'] } })
    .output(z.object({
      positionChanges: z.number(),
      restlessMinutes: z.number(),
      sampleCount: z.number(),
    }))
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

        const conditions = [eq(movement.side, input.side), inBedExists(input.side)]
        if (input.startDate) conditions.push(gte(movement.timestamp, input.startDate))
        if (input.endDate) conditions.push(lte(movement.timestamp, input.endDate))

        const [row] = await biometricsDb
          .select({
            positionChanges: sql<number>`COUNT(CASE WHEN ${movement.totalMovement} >= ${sql.raw(String(POSITION_CHANGE_SCORE_MIN))} THEN 1 END)`,
            restlessMinutes: sql<number>`COUNT(CASE WHEN ${movement.totalMovement} >= ${sql.raw(String(RESTLESS_SCORE_MIN))} THEN 1 END)`,
            sampleCount: count(),
          })
          .from(movement)
          .where(and(...conditions))

        return {
          positionChanges: Number(row?.positionChanges ?? 0),
          restlessMinutes: Number(row?.restlessMinutes ?? 0),
          sampleCount: Number(row?.sampleCount ?? 0),
        }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch movement summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
  /**
   * Fetch one sleep record by id, regardless of how many newer records exist.
   */
  getSleepRecord: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/sleep-records/get', protect: false, tags: ['Biometrics'] } })
    .input(z.object({ id: idSchema }).strict())
    .output(z.object({
      id: z.number(),
      side: sideSchema,
      enteredBedAt: z.date(),
      leftBedAt: z.date().nullable(),
      sleepDurationSeconds: z.number(),
      timesExitedBed: z.number(),
      presentIntervals: z.unknown(),
      notPresentIntervals: z.unknown(),
      createdAt: z.date(),
    }).nullable())
    .query(async ({ input }) => {
      try {
        const [record] = await biometricsDb
          .select()
          .from(sleepRecords)
          .where(eq(sleepRecords.id, input.id))
          .limit(1)
        return record || null
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch sleep record: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  getLatestSleep: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/sleep-records/latest', protect: false, tags: ['Biometrics'] } })
    .input(
      z
        .object({
          side: sideSchema,
        })
        .strict()
    )
    .output(z.object({
      id: z.number(),
      side: sideSchema,
      enteredBedAt: z.date(),
      leftBedAt: z.date().nullable(),
      sleepDurationSeconds: z.number(),
      timesExitedBed: z.number(),
      presentIntervals: z.unknown(),
      notPresentIntervals: z.unknown(),
      createdAt: z.date(),
    }).nullable())
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
   * Current bed occupancy for both sides. Single source of truth used by
   * the HomeKit OccupancySensor accessory and the web-app PresenceCard.
   * Combines the movement-table 15-min window with the live capSense2
   * level signal vs the calibration baseline. See `src/lib/occupancy.ts`.
   */
  getOccupancy: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/occupancy', protect: false, tags: ['Biometrics'] } })
    .input(z.void().optional())
    .output(z.object({
      left: z.object({
        occupied: z.boolean(),
        // True when presence can be sensed reliably enough to act on absence
        // (fresh capSense2 frame + completed calibration). The Settings UI
        // gates the auto-off toggle on this.
        available: z.boolean(),
        // person / light (pet, object) / none — see lib/occupancy.
        classification: z.enum(['person', 'light', 'none']),
        movement: z.object({ active: z.boolean(), peakScore: z.number() }),
        level: z.object({
          active: z.boolean(),
          deviation: z.number().nullable(),
          threshold: z.number().nullable(),
          ageMs: z.number().nullable(),
          zoneDeviations: z.array(z.number()).nullable(),
          zones: z.number().nullable(),
        }),
        vitals: z.object({
          heartRate: z.number().nullable(),
          breathingRate: z.number().nullable(),
          humanRange: z.boolean().nullable(),
        }),
      }),
      right: z.object({
        occupied: z.boolean(),
        // True when presence can be sensed reliably enough to act on absence
        // (fresh capSense2 frame + completed calibration). The Settings UI
        // gates the auto-off toggle on this.
        available: z.boolean(),
        // person / light (pet, object) / none — see lib/occupancy.
        classification: z.enum(['person', 'light', 'none']),
        movement: z.object({ active: z.boolean(), peakScore: z.number() }),
        level: z.object({
          active: z.boolean(),
          deviation: z.number().nullable(),
          threshold: z.number().nullable(),
          ageMs: z.number().nullable(),
          zoneDeviations: z.array(z.number()).nullable(),
          zones: z.number().nullable(),
        }),
        vitals: z.object({
          heartRate: z.number().nullable(),
          breathingRate: z.number().nullable(),
          humanRange: z.boolean().nullable(),
        }),
      }),
    }))
    .query(async () => {
      return {
        left: getOccupancy('left'),
        right: getOccupancy('right'),
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
    .output(z.object({
      provenance: summaryProvenanceSchema.optional(),
      avgHeartRate: z.number().nullable(),
      minHeartRate: z.number().nullable(),
      maxHeartRate: z.number().nullable(),
      avgHRV: z.number().nullable(),
      avgBreathingRate: z.number().nullable(),
      recordCount: z.number(),
    }).nullable())
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
            ...summaryProvenanceFields,
            avgHeartRate: avg(vitals.heartRate),
            minHeartRate: min(vitals.heartRate),
            maxHeartRate: max(vitals.heartRate),
            avgHRV: avg(vitals.hrv),
            avgBreathingRate: avg(vitals.breathingRate),
            recordCount: count(),
          })
          .from(vitals)
          .leftJoin(biometricProcessingRuns, and(eq(vitals.processingRunId, biometricProcessingRuns.id), eq(vitals.side, biometricProcessingRuns.side)))
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

        const provenance = summarizeVitalProvenance(summary)
        const incompatibleHrv = provenance?.hrvAggregation === 'incompatible_definitions'
        return {
          provenance,
          avgHeartRate: summary.avgHeartRate !== null ? Number(summary.avgHeartRate) : null,
          minHeartRate: summary.minHeartRate ?? null,
          maxHeartRate: summary.maxHeartRate ?? null,
          avgHRV: !incompatibleHrv && summary.avgHRV !== null ? Number(summary.avgHRV) : null,
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
   * Rolling personal baseline (mean + standard deviation) for each metric.
   * Drawn as a faint band behind night/week vitals charts so a raw value
   * reads as "normal for me" or "outside normal." Population SD via
   * E[X²] − E[X]² — SQLite has no STDDEV, but AVG ignores nulls so the
   * single-pass form is well-defined per metric independently.
   */
  getVitalsBaseline: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/vitals/baseline', protect: false, tags: ['Biometrics'] } })
    .output(z.object({
      provenance: summaryProvenanceSchema.optional(),
      hrMean: z.number().nullable(),
      hrSD: z.number().nullable(),
      hrvMean: z.number().nullable(),
      hrvSD: z.number().nullable(),
      brMean: z.number().nullable(),
      brSD: z.number().nullable(),
      sampleCount: z.number(),
      windowDays: z.number(),
    }).nullable())
    .input(
      z.object({
        side: sideSchema,
        days: z.number().int().min(1).max(90).default(30),
      }).strict(),
    )
    .query(async ({ input }) => {
      try {
        const now = new Date()
        const start = new Date(now.getTime() - input.days * 24 * 60 * 60 * 1000)

        const [row] = await biometricsDb
          .select({
            ...summaryProvenanceFields,
            hrMean: avg(vitals.heartRate),
            hrSqMean: sql<number | null>`AVG(${vitals.heartRate} * ${vitals.heartRate})`,
            hrvMean: avg(vitals.hrv),
            hrvSqMean: sql<number | null>`AVG(${vitals.hrv} * ${vitals.hrv})`,
            brMean: avg(vitals.breathingRate),
            brSqMean: sql<number | null>`AVG(${vitals.breathingRate} * ${vitals.breathingRate})`,
            sampleCount: count(),
          })
          .from(vitals)
          .leftJoin(biometricProcessingRuns, and(eq(vitals.processingRunId, biometricProcessingRuns.id), eq(vitals.side, biometricProcessingRuns.side)))
          .where(
            and(
              eq(vitals.side, input.side),
              gte(vitals.timestamp, start),
              lte(vitals.timestamp, now),
            ),
          )

        if (row.sampleCount === 0) return null

        const sd = (mean: number | null, sqMean: number | null): number | null => {
          if (mean == null || sqMean == null) return null
          const variance = Number(sqMean) - Number(mean) * Number(mean)
          return variance > 0 ? Math.sqrt(variance) : 0
        }

        const provenance = summarizeVitalProvenance(row)
        const mixedConfigurations = provenance !== undefined && (provenance.configurationCount > 1 || (provenance.configurationCount > 0 && provenance.unknownConfigurationRows > 0))
        const incompatibleHrv = mixedConfigurations || provenance?.hrvAggregation === 'incompatible_definitions'
        return {
          provenance,
          hrMean: !mixedConfigurations && row.hrMean !== null ? Number(row.hrMean) : null,
          hrSD: mixedConfigurations ? null : sd(row.hrMean as number | null, row.hrSqMean),
          hrvMean: !incompatibleHrv && row.hrvMean !== null ? Number(row.hrvMean) : null,
          hrvSD: incompatibleHrv ? null : sd(row.hrvMean as number | null, row.hrvSqMean),
          brMean: !mixedConfigurations && row.brMean !== null ? Number(row.brMean) : null,
          brSD: mixedConfigurations ? null : sd(row.brMean as number | null, row.brSqMean),
          sampleCount: row.sampleCount,
          windowDays: input.days,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to calculate vitals baseline: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
   * Import reference sleep stages scored by another device (Apple Watch
   * SleepAnalysis, posted by the iOS app each morning). These are reference
   * labels for comparing the pod's classifier; they never feed getSleepStages.
   *
   * Idempotent: a segment identical to a stored one (same side, source, start,
   * end and stage) is skipped, so re-posting a night is a no-op. A post whose
   * segments overlap each other, or overlap a different stored segment for the
   * same side and source, is rejected whole with BAD_REQUEST listing the
   * conflicts, so the table never holds two labels for the same minute. Stored
   * labels are never replaced. Segment ranges are half-open [start, end) unix
   * seconds. Unknown fields are rejected, so the iOS app must not send new
   * fields before the server accepts them.
   */
  importReferenceStages: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometrics/reference-stages', protect: false, tags: ['Biometrics'] } })
    .input(
      z.object({
        side: sideSchema,
        source: z.enum(['apple_watch']),
        segments: z.array(
          z.object({
            // Unix seconds in 2001..2100: rejects millisecond timestamps, which
            // would otherwise persist forever under first-write-wins.
            start: z.number().int().min(1_000_000_000).max(4_102_444_800),
            end: z.number().int().min(1_000_000_000).max(4_102_444_800),
            stage: z.enum(['wake', 'light', 'deep', 'rem']),
          }).strict().refine(s => s.end > s.start, { message: 'end must be after start' })
        ).min(1).max(2000).superRefine((segments, ctx) => {
          const conflicts = batchOverlaps(segments)
          if (conflicts.length > 0) {
            ctx.addIssue({ code: 'custom', message: `Segments overlap: ${describeConflicts(conflicts)}` })
          }
        }),
      }).strict()
    )
    .output(z.object({ written: z.number() }))
    .mutation(async ({ input }) => {
      try {
        const rows = input.segments.map(s => ({
          side: input.side,
          source: input.source,
          start: new Date(s.start * 1000),
          end: new Date(s.end * 1000),
          stage: s.stage,
        }))

        const minStart = Math.min(...input.segments.map(s => s.start))
        const maxEnd = Math.max(...input.segments.map(s => s.end))

        // Check and insert in one transaction so a concurrent post cannot slip
        // an overlapping row in between.
        const inserted = biometricsDb.transaction((tx) => {
          const stored = tx
            .select()
            .from(referenceStages)
            .where(
              and(
                eq(referenceStages.side, input.side),
                eq(referenceStages.source, input.source),
                lt(referenceStages.start, new Date(maxEnd * 1000)),
                gt(referenceStages.end, new Date(minStart * 1000))
              )
            )
            .all()
            .map(r => ({ start: r.start.getTime() / 1000, end: r.end.getTime() / 1000, stage: r.stage }))

          const conflicts: string[] = []
          for (const s of input.segments) {
            for (const r of stored) {
              if (segmentsOverlap(s, r) && !sameSegment(s, r)) {
                conflicts.push(`${describeSegment(s)} overlaps stored ${describeSegment(r)}`)
              }
            }
          }
          if (conflicts.length > 0) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Segments overlap stored reference stages: ${describeConflicts(conflicts)}`,
            })
          }

          const accepted = tx
            .insert(referenceStages)
            .values(rows)
            .onConflictDoNothing()
            .returning()
            .all()
          recordLegacyReferenceImport(biometricsDb, 'stages', accepted)
          return accepted
        })

        return { written: inserted.length }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to import reference stages: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Reference sleep stages for a side that overlap [startDate, endDate]
   * (inclusive), oldest first. A segment ending exactly at startDate covers
   * none of the window, so it is not returned.
   */
  getReferenceStages: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/reference-stages', protect: false, tags: ['Biometrics'] } })
    .output(z.array(z.object({
      id: z.number(),
      side: sideSchema,
      source: z.enum(['apple_watch']),
      start: z.date(),
      end: z.date(),
      stage: z.enum(['wake', 'light', 'deep', 'rem']),
      createdAt: z.date(),
    })))
    .input(
      z
        .object({
          side: sideSchema,
          startDate: z.date(),
          endDate: z.date(),
          limit: z.number().int().min(1).max(20000).default(2000),
        })
        .strict()
    )
    .query(async ({ input }) => {
      if (!validateDateRange(input.startDate, input.endDate)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'startDate must be before or equal to endDate',
        })
      }

      try {
        return await biometricsDb
          .select()
          .from(referenceStages)
          .where(
            and(
              eq(referenceStages.side, input.side),
              lte(referenceStages.start, input.endDate),
              gt(referenceStages.end, input.startDate)
            )
          )
          .orderBy(asc(referenceStages.start))
          .limit(input.limit)
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch reference stages: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Import externally measured heart-rate samples (Apple Watch via a Health
   * export or the iOS app). Stored in `reference_vitals`, never in `vitals`:
   * the pod's own series drives occupancy, staging and chart baselines, and a
   * Watch sample at a slightly different second would otherwise interleave
   * with it. A repeated post is a no-op (unique on side, timestamp, source).
   */
  importReferenceVitals: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometrics/reference-vitals', protect: false, tags: ['Biometrics'] } })
    .input(
      z.object({
        side: sideSchema,
        source: z.enum(['apple_watch']),
        samples: z.array(
          z.object({
            // Unix seconds in 2001..2100: rejects millisecond timestamps, which
            // would otherwise persist forever under first-write-wins.
            timestamp: z.number().int().min(1_000_000_000).max(4_102_444_800),
            heartRate: z.number().min(20).max(250),
          }).strict()
        ).min(1).max(2000),
      }).strict()
    )
    .output(z.object({ written: z.number() }))
    .mutation(async ({ input }) => {
      try {
        const rows = input.samples.map(s => ({
          side: input.side,
          source: input.source,
          timestamp: new Date(s.timestamp * 1000),
          heartRate: s.heartRate,
        }))
        const inserted = biometricsDb.transaction((tx) => {
          const accepted = tx.insert(referenceVitals).values(rows).onConflictDoNothing().returning().all()
          recordLegacyReferenceImport(biometricsDb, 'vitals', accepted)
          return accepted
        })
        return { written: inserted.length }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to import reference vitals: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Import externally measured breathing rate (breaths/min) or HRV SDNN (ms)
   * samples, one metric per call (Apple Watch via a Health export). Stored in
   * `reference_samples`, never in `vitals`, under the same first-write-wins
   * rule as importReferenceVitals (unique on side, metric, timestamp, source).
   */
  importReferenceSamples: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/biometrics/reference-samples', protect: false, tags: ['Biometrics'] } })
    .input(
      z.object({
        side: sideSchema,
        source: z.enum(['apple_watch']),
        metric: z.enum(['breathing_rate', 'hrv_sdnn']),
        samples: z.array(
          z.object({
            // Unix seconds in 2001..2100, as importReferenceVitals.
            timestamp: z.number().int().min(1_000_000_000).max(4_102_444_800),
            value: z.number().finite(),
          }).strict()
        ).min(1).max(2000),
      }).strict().superRefine((input, ctx) => {
        const [lo, hi] = REFERENCE_SAMPLE_RANGE[input.metric]
        const index = input.samples.findIndex(s => s.value < lo || s.value > hi)
        if (index >= 0) ctx.addIssue({ code: 'custom', path: ['samples', index, 'value'], message: `${input.metric} must be within ${lo}..${hi}` })
      })
    )
    .output(z.object({ written: z.number() }))
    .mutation(async ({ input }) => {
      try {
        const rows = input.samples.map(s => ({
          side: input.side,
          source: input.source,
          metric: input.metric,
          timestamp: new Date(s.timestamp * 1000),
          value: s.value,
        }))
        const inserted = biometricsDb.transaction((tx) => {
          const accepted = tx.insert(referenceSamples).values(rows).onConflictDoNothing().returning().all()
          recordLegacyReferenceImport(biometricsDb, 'samples', accepted)
          return accepted
        })
        return { written: inserted.length }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to import reference samples: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Reference heart-rate samples for a side in [startDate, endDate]
   * (inclusive), oldest first. When the window holds more than `limit`
   * samples the newest survive (like getVitals), so the latest night is
   * never the one that goes missing.
   */
  getReferenceVitals: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/biometrics/reference-vitals', protect: false, tags: ['Biometrics'] } })
    .output(z.array(z.object({
      id: z.number(),
      side: sideSchema,
      source: z.enum(['apple_watch']),
      timestamp: z.date(),
      heartRate: z.number(),
      createdAt: z.date(),
    })))
    .input(
      z
        .object({
          side: sideSchema,
          startDate: z.date(),
          endDate: z.date(),
          limit: z.number().int().min(1).max(20000).default(5000),
        })
        .strict()
    )
    .query(async ({ input }) => {
      if (!validateDateRange(input.startDate, input.endDate)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'startDate must be before or equal to endDate',
        })
      }

      try {
        const rows = await biometricsDb
          .select()
          .from(referenceVitals)
          .where(
            and(
              eq(referenceVitals.side, input.side),
              gte(referenceVitals.timestamp, input.startDate),
              lte(referenceVitals.timestamp, input.endDate)
            )
          )
          .orderBy(desc(referenceVitals.timestamp))
          .limit(input.limit)
        return rows.reverse()
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch reference vitals: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
    .output(z.object({
      id: z.number(),
      side: sideSchema,
      enteredBedAt: z.date(),
      leftBedAt: z.date().nullable(),
      sleepDurationSeconds: z.number(),
      timesExitedBed: z.number(),
      presentIntervals: z.unknown(),
      notPresentIntervals: z.unknown(),
      createdAt: z.date(),
    }))
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
      stageView: stageViewSchema.optional(),
      sleepRecordId: z.number().nullable(),
      enteredBedAt: z.number().nullable(),
      leftBedAt: z.number().nullable(),
    }))
    .query(async ({ input }): Promise<SleepStagesResult & { stageView?: StageView }> => {
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
          }
          else {
            windowStart = record.enteredBedAt
            windowEnd = record.leftBedAt
          }
          sleepRecordId = record.id
          enteredBedAt = record.enteredBedAt.getTime()
          leftBedAt = record.leftBedAt ? record.leftBedAt.getTime() : null
        }
        else if (input.startDate && input.endDate) {
          if (!validateDateRange(input.startDate, input.endDate)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'startDate must be before or equal to endDate',
            })
          }
          windowStart = input.startDate
          windowEnd = input.endDate
        }
        else {
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
            const hourPart = parts.find(p => p.type === 'hour')
            return parseInt(hourPart?.value ?? '0', 10)
          }

          // 1st try: 3+ hours AND entered bed between 8 PM (20) and 4 AM (4) local time
          const overnightRecord = recentRecords.find((r) => {
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

        const { vitalsData, movementData, calibrationQuality } = await loadStageInputs(input.side, windowStart, windowEnd)
        const stageView = loadStageView(input.side)
        const classifier = stageView.classifier

        // Classify stages
        const epochs = classifySleepStages(vitalsData, movementData, calibrationQuality, classifier.ruleset)

        if (epochs.length === 0) {
          return {
            stageView,
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
        const qualityScore = calculateQualityScore(distribution, calibrationQuality)
        const totalSleepMs = epochs.reduce((sum, e) => sum + e.duration, 0)

        return {
          stageView,
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
