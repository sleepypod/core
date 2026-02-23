import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { sleepRecords, vitals, movement } from '@/src/db/schema'
import { eq, and, gte, lte, desc } from 'drizzle-orm'

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
      z.object({
        side: z.enum(['left', 'right']),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        limit: z.number().min(1).max(100).default(30),
      })
    )
    .query(async ({ input }) => {
      const conditions = [eq(sleepRecords.side, input.side)]

      if (input.startDate) {
        conditions.push(gte(sleepRecords.enteredBedAt, input.startDate))
      }

      if (input.endDate) {
        conditions.push(lte(sleepRecords.enteredBedAt, input.endDate))
      }

      const records = await db
        .select()
        .from(sleepRecords)
        .where(and(...conditions))
        .orderBy(desc(sleepRecords.enteredBedAt))
        .limit(input.limit)

      return records
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
      z.object({
        side: z.enum(['left', 'right']),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        limit: z.number().min(1).max(1000).default(288), // Default: 24 hours of 5-min intervals
      })
    )
    .query(async ({ input }) => {
      const conditions = [eq(vitals.side, input.side)]

      if (input.startDate) {
        conditions.push(gte(vitals.timestamp, input.startDate))
      }

      if (input.endDate) {
        conditions.push(lte(vitals.timestamp, input.endDate))
      }

      const records = await db
        .select()
        .from(vitals)
        .where(and(...conditions))
        .orderBy(desc(vitals.timestamp))
        .limit(input.limit)

      return records
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
      z.object({
        side: z.enum(['left', 'right']),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        limit: z.number().min(1).max(1000).default(288),
      })
    )
    .query(async ({ input }) => {
      const conditions = [eq(movement.side, input.side)]

      if (input.startDate) {
        conditions.push(gte(movement.timestamp, input.startDate))
      }

      if (input.endDate) {
        conditions.push(lte(movement.timestamp, input.endDate))
      }

      const records = await db
        .select()
        .from(movement)
        .where(and(...conditions))
        .orderBy(desc(movement.timestamp))
        .limit(input.limit)

      return records
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
      z.object({
        side: z.enum(['left', 'right']),
      })
    )
    .query(async ({ input }) => {
      const [record] = await db
        .select()
        .from(sleepRecords)
        .where(eq(sleepRecords.side, input.side))
        .orderBy(desc(sleepRecords.enteredBedAt))
        .limit(1)

      return record || null
    }),

  /**
   * Get aggregated vitals statistics for a date range.
   *
   * Computation:
   * - Calculates on-demand from raw vitals records (not pre-aggregated)
   * - Filters out null values before computing averages
   * - Returns null for metrics if no valid data points exist
   *
   * Performance:
   * - Can be expensive for large date ranges (scans all matching records)
   * - Consider adding database indexes on (side, timestamp) if slow
   * - For frequently accessed summaries, consider caching results
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
      z.object({
        side: z.enum(['left', 'right']),
        startDate: z.date(),
        endDate: z.date(),
      })
    )
    .query(async ({ input }) => {
      const records = await db
        .select()
        .from(vitals)
        .where(
          and(
            eq(vitals.side, input.side),
            gte(vitals.timestamp, input.startDate),
            lte(vitals.timestamp, input.endDate)
          )
        )

      if (records.length === 0) {
        return null
      }

      // Calculate summary statistics
      const heartRates = records
        .map(r => r.heartRate)
        .filter((hr): hr is number => hr !== null)
      const hrvValues = records
        .map(r => r.hrv)
        .filter((hrv): hrv is number => hrv !== null)
      const breathingRates = records
        .map(r => r.breathingRate)
        .filter((br): br is number => br !== null)

      return {
        avgHeartRate:
          heartRates.length > 0
            ? heartRates.reduce((a, b) => a + b, 0) / heartRates.length
            : null,
        minHeartRate: heartRates.length > 0 ? Math.min(...heartRates) : null,
        maxHeartRate: heartRates.length > 0 ? Math.max(...heartRates) : null,
        avgHRV:
          hrvValues.length > 0
            ? hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length
            : null,
        avgBreathingRate:
          breathingRates.length > 0
            ? breathingRates.reduce((a, b) => a + b, 0) / breathingRates.length
            : null,
        recordCount: records.length,
      }
    }),
})
