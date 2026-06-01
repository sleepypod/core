import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb } from '@/src/db'
import { waterLevelReadings, waterLevelAlerts, flowReadings } from '@/src/db/biometrics-schema'
import { eq, and, gte, gt, lte, desc, isNull, count } from 'drizzle-orm'
import { idSchema, validateDateRange } from '@/src/server/validation-schemas'

export const waterLevelRouter = router({
  /**
   * Get historical water level readings with optional date range.
   */
  getHistory: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/water-level/history', protect: false, tags: ['Water Level'] } })
    .input(z.object({
      startDate: z.date().optional(),
      endDate: z.date().optional(),
      limit: z.number().int().min(1).max(10000).default(1440),
    }).strict())
    .output(z.array(z.object({
      id: z.number(),
      timestamp: z.date(),
      level: z.enum(['low', 'ok']),
    })))
    .query(async ({ input }) => {
      try {
        if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
        }

        const conditions = []
        if (input.startDate) conditions.push(gte(waterLevelReadings.timestamp, input.startDate))
        if (input.endDate) conditions.push(lte(waterLevelReadings.timestamp, input.endDate))

        return await biometricsDb
          .select()
          .from(waterLevelReadings)
          .where(conditions.length ? and(...conditions) : undefined)
          .orderBy(desc(waterLevelReadings.timestamp))
          .limit(input.limit)
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch water level history: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get latest water level reading.
   */
  getLatest: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/water-level/latest', protect: false, tags: ['Water Level'] } })
    .input(z.object({}))
    .output(z.object({
      id: z.number(),
      timestamp: z.date(),
      level: z.enum(['low', 'ok']),
    }).nullable())
    .query(async () => {
      try {
        const [row] = await biometricsDb
          .select()
          .from(waterLevelReadings)
          .orderBy(desc(waterLevelReadings.timestamp))
          .limit(1)
        return row || null
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch latest water level: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get water level trend summary for the last N hours.
   * Returns percentage of time at each level and overall trend direction.
   */
  getTrend: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/water-level/trend', protect: false, tags: ['Water Level'] } })
    .input(z.object({
      hours: z.number().int().min(1).max(168).default(24),
    }).strict())
    .output(z.object({
      totalReadings: z.number(),
      okPercent: z.number(),
      lowPercent: z.number(),
      trend: z.enum(['stable', 'declining', 'rising', 'unknown']),
    }))
    .query(async ({ input }) => {
      try {
        const now = Date.now()
        const since = new Date(now - input.hours * 60 * 60 * 1000)
        const midpoint = new Date(now - (input.hours * 60 * 60 * 1000) / 2)

        // Aggregate counts in SQL instead of loading all rows
        const totals = await biometricsDb
          .select({
            level: waterLevelReadings.level,
            cnt: count(),
          })
          .from(waterLevelReadings)
          .where(gte(waterLevelReadings.timestamp, since))
          .groupBy(waterLevelReadings.level)

        const okCount = totals.find(r => r.level === 'ok')?.cnt ?? 0
        const lowCount = totals.find(r => r.level === 'low')?.cnt ?? 0
        const total = okCount + lowCount

        if (total < 2) {
          return {
            totalReadings: total,
            okPercent: total > 0 ? Math.round((okCount / total) * 100) : 0,
            lowPercent: total > 0 ? Math.round((lowCount / total) * 100) : 0,
            trend: 'unknown' as const,
          }
        }

        // Trend: compare recent half vs older half low-count rates
        const [recentLow] = await biometricsDb
          .select({ cnt: count() })
          .from(waterLevelReadings)
          .where(and(
            gte(waterLevelReadings.timestamp, midpoint),
            eq(waterLevelReadings.level, 'low'),
          ))
        const [olderLow] = await biometricsDb
          .select({ cnt: count() })
          .from(waterLevelReadings)
          .where(and(
            gte(waterLevelReadings.timestamp, since),
            lte(waterLevelReadings.timestamp, midpoint),
            eq(waterLevelReadings.level, 'low'),
          ))
        const [recentTotal] = await biometricsDb
          .select({ cnt: count() })
          .from(waterLevelReadings)
          .where(gte(waterLevelReadings.timestamp, midpoint))
        const [olderTotal] = await biometricsDb
          .select({ cnt: count() })
          .from(waterLevelReadings)
          .where(and(
            gte(waterLevelReadings.timestamp, since),
            lte(waterLevelReadings.timestamp, midpoint),
          ))

        let trend: 'stable' | 'declining' | 'rising' | 'unknown' = 'stable'
        if (recentTotal.cnt > 0 && olderTotal.cnt > 0) {
          const recentRate = recentLow.cnt / recentTotal.cnt
          const olderRate = olderLow.cnt / olderTotal.cnt
          if (recentRate > olderRate + 0.2) trend = 'declining'
          else if (recentRate < olderRate - 0.2) trend = 'rising'
        }

        return {
          totalReadings: total,
          okPercent: Math.round((okCount / total) * 100),
          lowPercent: Math.round((lowCount / total) * 100),
          trend,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to calculate water level trend: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get active (undismissed) water level alerts.
   */
  getAlerts: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/water-level/alerts', protect: false, tags: ['Water Level'] } })
    .input(z.object({}))
    .output(z.array(z.object({
      id: z.number(),
      type: z.enum(['low_sustained', 'rapid_change', 'leak_suspected']),
      startedAt: z.date(),
      dismissedAt: z.date().nullable(),
      message: z.string().nullable(),
      createdAt: z.date(),
    })))
    .query(async () => {
      try {
        return await biometricsDb
          .select()
          .from(waterLevelAlerts)
          .where(isNull(waterLevelAlerts.dismissedAt))
          .orderBy(desc(waterLevelAlerts.createdAt))
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch water level alerts: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Dismiss a water level alert.
   */
  dismissAlert: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/water-level/alerts/dismiss', protect: false, tags: ['Water Level'] } })
    .input(z.object({ id: idSchema }).strict())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        const [updated] = await biometricsDb
          .update(waterLevelAlerts)
          .set({ dismissedAt: new Date() })
          .where(and(
            eq(waterLevelAlerts.id, input.id),
            isNull(waterLevelAlerts.dismissedAt),
          ))
          .returning()

        if (!updated) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Alert ${input.id} not found or already dismissed` })
        }

        return { success: true }
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to dismiss alert: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get historical flow rate and pump RPM readings.
   */
  getFlowReadings: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/water-level/flow', protect: false, tags: ['Water Level'] } })
    .input(z.object({
      hours: z.number().int().min(1).max(168).default(24),
    }).strict())
    .output(z.array(z.object({
      id: z.number(),
      timestamp: z.date(),
      leftFlowrateCd: z.number().nullable(),
      rightFlowrateCd: z.number().nullable(),
      leftPumpRpm: z.number().nullable(),
      rightPumpRpm: z.number().nullable(),
    })))
    .query(async ({ input }) => {
      try {
        const since = new Date(Date.now() - input.hours * 60 * 60 * 1000)
        return await biometricsDb
          .select()
          .from(flowReadings)
          .where(gt(flowReadings.timestamp, since))
          .orderBy(flowReadings.timestamp)
          .limit(10080)
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch flow readings: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get the most recent flow reading.
   */
  getLatestFlowReading: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/water-level/flow/latest', protect: false, tags: ['Water Level'] } })
    .input(z.object({}))
    .output(z.object({
      id: z.number(),
      timestamp: z.date(),
      leftFlowrateCd: z.number().nullable(),
      rightFlowrateCd: z.number().nullable(),
      leftPumpRpm: z.number().nullable(),
      rightPumpRpm: z.number().nullable(),
    }).nullable())
    .query(async () => {
      try {
        const [row] = await biometricsDb
          .select()
          .from(flowReadings)
          .orderBy(desc(flowReadings.timestamp))
          .limit(1)
        return row || null
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch latest flow reading: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
