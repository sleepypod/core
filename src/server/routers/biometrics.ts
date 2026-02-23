import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { sleepRecords, vitals, movement } from '@/src/db/schema'
import { eq, and, gte, lte, desc } from 'drizzle-orm'

/**
 * Biometrics router - manages sleep and health data
 */
export const biometricsRouter = router({
  /**
   * Get sleep records for a side
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
      let query = db
        .select()
        .from(sleepRecords)
        .where(eq(sleepRecords.side, input.side))
        .orderBy(desc(sleepRecords.enteredBedAt))
        .limit(input.limit)

      if (input.startDate) {
        query = query.where(gte(sleepRecords.enteredBedAt, input.startDate))
      }

      if (input.endDate) {
        query = query.where(lte(sleepRecords.enteredBedAt, input.endDate))
      }

      const records = await query

      return records
    }),

  /**
   * Get vitals data for a side
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
      let query = db
        .select()
        .from(vitals)
        .where(eq(vitals.side, input.side))
        .orderBy(desc(vitals.timestamp))
        .limit(input.limit)

      if (input.startDate) {
        query = query.where(gte(vitals.timestamp, input.startDate))
      }

      if (input.endDate) {
        query = query.where(lte(vitals.timestamp, input.endDate))
      }

      const records = await query

      return records
    }),

  /**
   * Get movement data for a side
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
      let query = db
        .select()
        .from(movement)
        .where(eq(movement.side, input.side))
        .orderBy(desc(movement.timestamp))
        .limit(input.limit)

      if (input.startDate) {
        query = query.where(gte(movement.timestamp, input.startDate))
      }

      if (input.endDate) {
        query = query.where(lte(movement.timestamp, input.endDate))
      }

      const records = await query

      return records
    }),

  /**
   * Get latest sleep record
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
   * Get vitals summary for date range
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
        .filter((r) => r.heartRate !== null)
        .map((r) => r.heartRate!)
      const hrvValues = records.filter((r) => r.hrv !== null).map((r) => r.hrv!)
      const breathingRates = records
        .filter((r) => r.breathingRate !== null)
        .map((r) => r.breathingRate!)

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
