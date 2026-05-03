import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb } from '@/src/db'
import { ambientLight, bedTemp, freezerTemp } from '@/src/db/biometrics-schema'
import { and, gte, lte, desc, avg, min, max, count } from 'drizzle-orm'
import { validateDateRange } from '@/src/server/validation-schemas'
import { centiDegreesToC, centiDegreesToF, centiPercentToPercent, type TempUnit } from '@/src/lib/tempUtils'

function convertTemp(centidegrees: number | null, unit: TempUnit): number | null {
  if (centidegrees === null) return null
  return unit === 'F' ? centiDegreesToF(centidegrees) : centiDegreesToC(centidegrees)
}

function convertHumidity(centipercent: number | null): number | null {
  if (centipercent === null) return null
  return centiPercentToPercent(centipercent)
}

const dateRangeInput = z.object({
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  limit: z.number().int().min(1).max(1440).default(1440), // 24hr at 60s intervals
  unit: z.enum(['F', 'C']).default('F'),
}).strict()

export const environmentRouter = router({
  getBedTemp: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/environment/bed-temp', protect: false, tags: ['Environment'] } })
    .input(dateRangeInput)
    .output(z.array(z.object({
      id: z.number(),
      timestamp: z.date(),
      ambientTemp: z.number().nullable(),
      mcuTemp: z.number().nullable(),
      humidity: z.number().nullable(),
      leftOuterTemp: z.number().nullable(),
      leftCenterTemp: z.number().nullable(),
      leftInnerTemp: z.number().nullable(),
      rightOuterTemp: z.number().nullable(),
      rightCenterTemp: z.number().nullable(),
      rightInnerTemp: z.number().nullable(),
    })))
    .query(async ({ input }) => {
      try {
        if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
        }

        const conditions = []
        if (input.startDate) conditions.push(gte(bedTemp.timestamp, input.startDate))
        if (input.endDate) conditions.push(lte(bedTemp.timestamp, input.endDate))

        const rows = await biometricsDb
          .select()
          .from(bedTemp)
          .where(conditions.length ? and(...conditions) : undefined)
          .orderBy(desc(bedTemp.timestamp))
          .limit(input.limit)

        return rows.map(r => ({
          id: r.id,
          timestamp: r.timestamp,
          ambientTemp: convertTemp(r.ambientTemp, input.unit),
          mcuTemp: convertTemp(r.mcuTemp, input.unit),
          humidity: convertHumidity(r.humidity),
          leftOuterTemp: convertTemp(r.leftOuterTemp, input.unit),
          leftCenterTemp: convertTemp(r.leftCenterTemp, input.unit),
          leftInnerTemp: convertTemp(r.leftInnerTemp, input.unit),
          rightOuterTemp: convertTemp(r.rightOuterTemp, input.unit),
          rightCenterTemp: convertTemp(r.rightCenterTemp, input.unit),
          rightInnerTemp: convertTemp(r.rightInnerTemp, input.unit),
        }))
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch bed temp: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  getFreezerTemp: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/environment/freezer-temp', protect: false, tags: ['Environment'] } })
    .input(dateRangeInput)
    .output(z.array(z.object({
      id: z.number(),
      timestamp: z.date(),
      ambientTemp: z.number().nullable(),
      heatsinkTemp: z.number().nullable(),
      leftWaterTemp: z.number().nullable(),
      rightWaterTemp: z.number().nullable(),
    })))
    .query(async ({ input }) => {
      try {
        if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
        }

        const conditions = []
        if (input.startDate) conditions.push(gte(freezerTemp.timestamp, input.startDate))
        if (input.endDate) conditions.push(lte(freezerTemp.timestamp, input.endDate))

        const rows = await biometricsDb
          .select()
          .from(freezerTemp)
          .where(conditions.length ? and(...conditions) : undefined)
          .orderBy(desc(freezerTemp.timestamp))
          .limit(input.limit)

        return rows.map(r => ({
          id: r.id,
          timestamp: r.timestamp,
          ambientTemp: convertTemp(r.ambientTemp, input.unit),
          heatsinkTemp: convertTemp(r.heatsinkTemp, input.unit),
          leftWaterTemp: convertTemp(r.leftWaterTemp, input.unit),
          rightWaterTemp: convertTemp(r.rightWaterTemp, input.unit),
        }))
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch freezer temp: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  getLatestBedTemp: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/environment/bed-temp/latest', protect: false, tags: ['Environment'] } })
    .input(z.object({ unit: z.enum(['F', 'C']).default('F') }).strict())
    .output(z.object({
      id: z.number(),
      timestamp: z.date(),
      ambientTemp: z.number().nullable(),
      mcuTemp: z.number().nullable(),
      humidity: z.number().nullable(),
      leftOuterTemp: z.number().nullable(),
      leftCenterTemp: z.number().nullable(),
      leftInnerTemp: z.number().nullable(),
      rightOuterTemp: z.number().nullable(),
      rightCenterTemp: z.number().nullable(),
      rightInnerTemp: z.number().nullable(),
    }).nullable())
    .query(async ({ input }) => {
      try {
        const [row] = await biometricsDb
          .select()
          .from(bedTemp)
          .orderBy(desc(bedTemp.timestamp))
          .limit(1)

        if (!row) return null

        return {
          id: row.id,
          timestamp: row.timestamp,
          ambientTemp: convertTemp(row.ambientTemp, input.unit),
          mcuTemp: convertTemp(row.mcuTemp, input.unit),
          humidity: convertHumidity(row.humidity),
          leftOuterTemp: convertTemp(row.leftOuterTemp, input.unit),
          leftCenterTemp: convertTemp(row.leftCenterTemp, input.unit),
          leftInnerTemp: convertTemp(row.leftInnerTemp, input.unit),
          rightOuterTemp: convertTemp(row.rightOuterTemp, input.unit),
          rightCenterTemp: convertTemp(row.rightCenterTemp, input.unit),
          rightInnerTemp: convertTemp(row.rightInnerTemp, input.unit),
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch latest bed temp: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  getLatestFreezerTemp: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/environment/freezer-temp/latest', protect: false, tags: ['Environment'] } })
    .input(z.object({ unit: z.enum(['F', 'C']).default('F') }).strict())
    .output(z.object({
      id: z.number(),
      timestamp: z.date(),
      ambientTemp: z.number().nullable(),
      heatsinkTemp: z.number().nullable(),
      leftWaterTemp: z.number().nullable(),
      rightWaterTemp: z.number().nullable(),
    }).nullable())
    .query(async ({ input }) => {
      try {
        const [row] = await biometricsDb
          .select()
          .from(freezerTemp)
          .orderBy(desc(freezerTemp.timestamp))
          .limit(1)

        if (!row) return null

        return {
          id: row.id,
          timestamp: row.timestamp,
          ambientTemp: convertTemp(row.ambientTemp, input.unit),
          heatsinkTemp: convertTemp(row.heatsinkTemp, input.unit),
          leftWaterTemp: convertTemp(row.leftWaterTemp, input.unit),
          rightWaterTemp: convertTemp(row.rightWaterTemp, input.unit),
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch latest freezer temp: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  getSummary: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/environment/summary', protect: false, tags: ['Environment'] } })
    .output(z.object({
      bedTemp: z.object({
        avgAmbientTemp: z.number().nullable(),
        minAmbientTemp: z.number().nullable(),
        maxAmbientTemp: z.number().nullable(),
        avgHumidity: z.number().nullable(),
        avgLeftCenterTemp: z.number().nullable(),
        avgRightCenterTemp: z.number().nullable(),
        recordCount: z.number(),
      }).nullable(),
      freezerTemp: z.object({
        avgAmbientTemp: z.number().nullable(),
        avgHeatsinkTemp: z.number().nullable(),
        avgLeftWaterTemp: z.number().nullable(),
        avgRightWaterTemp: z.number().nullable(),
        recordCount: z.number(),
      }).nullable(),
    }))
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
        unit: z.enum(['F', 'C']).default('F'),
      }).strict(),
    )
    .query(async ({ input }) => {
      try {
        if (!validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
        }

        const [[bed], [frz]] = await Promise.all([
          biometricsDb
            .select({
              avgAmbient: avg(bedTemp.ambientTemp),
              minAmbient: min(bedTemp.ambientTemp),
              maxAmbient: max(bedTemp.ambientTemp),
              avgHumidity: avg(bedTemp.humidity),
              avgLeftCenter: avg(bedTemp.leftCenterTemp),
              avgRightCenter: avg(bedTemp.rightCenterTemp),
              recordCount: count(),
            })
            .from(bedTemp)
            .where(and(
              gte(bedTemp.timestamp, input.startDate),
              lte(bedTemp.timestamp, input.endDate),
            )),
          biometricsDb
            .select({
              avgAmbient: avg(freezerTemp.ambientTemp),
              avgHeatsink: avg(freezerTemp.heatsinkTemp),
              avgLeftWater: avg(freezerTemp.leftWaterTemp),
              avgRightWater: avg(freezerTemp.rightWaterTemp),
              recordCount: count(),
            })
            .from(freezerTemp)
            .where(and(
              gte(freezerTemp.timestamp, input.startDate),
              lte(freezerTemp.timestamp, input.endDate),
            )),
        ])

        const cv = (v: string | null) =>
          v !== null
            ? convertTemp(Number(v), input.unit)
            : null
        const cvH = (v: string | null) =>
          v !== null
            ? centiPercentToPercent(Number(v))
            : null

        return {
          bedTemp: bed.recordCount === 0
            ? null
            : {
                avgAmbientTemp: cv(bed.avgAmbient),
                minAmbientTemp: convertTemp(bed.minAmbient, input.unit),
                maxAmbientTemp: convertTemp(bed.maxAmbient, input.unit),
                avgHumidity: cvH(bed.avgHumidity),
                avgLeftCenterTemp: cv(bed.avgLeftCenter),
                avgRightCenterTemp: cv(bed.avgRightCenter),
                recordCount: bed.recordCount,
              },
          freezerTemp: frz.recordCount === 0
            ? null
            : {
                avgAmbientTemp: cv(frz.avgAmbient),
                avgHeatsinkTemp: cv(frz.avgHeatsink),
                avgLeftWaterTemp: cv(frz.avgLeftWater),
                avgRightWaterTemp: cv(frz.avgRightWater),
                recordCount: frz.recordCount,
              },
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to calculate environment summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  getAmbientLight: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/environment/ambient-light', protect: false, tags: ['Environment'] } })
    .input(z.object({
      startDate: z.date().optional(),
      endDate: z.date().optional(),
      limit: z.number().int().min(1).max(1440).default(1440),
    }).strict())
    .output(z.array(z.object({
      id: z.number(),
      timestamp: z.date(),
      lux: z.number().nullable(),
    })))
    .query(async ({ input }) => {
      try {
        if (input.startDate && input.endDate && !validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
        }

        const conditions = []
        if (input.startDate) conditions.push(gte(ambientLight.timestamp, input.startDate))
        if (input.endDate) conditions.push(lte(ambientLight.timestamp, input.endDate))

        return await biometricsDb
          .select()
          .from(ambientLight)
          .where(conditions.length ? and(...conditions) : undefined)
          .orderBy(desc(ambientLight.timestamp))
          .limit(input.limit)
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch ambient light: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  getLatestAmbientLight: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/environment/ambient-light/latest', protect: false, tags: ['Environment'] } })
    .input(z.object({}))
    .output(z.object({
      id: z.number(),
      timestamp: z.date(),
      lux: z.number().nullable(),
    }).nullable())
    .query(async () => {
      try {
        const [row] = await biometricsDb
          .select()
          .from(ambientLight)
          .orderBy(desc(ambientLight.timestamp))
          .limit(1)
        return row || null
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to fetch latest ambient light: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  getAmbientLightSummary: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/environment/ambient-light/summary', protect: false, tags: ['Environment'] } })
    .input(z.object({
      startDate: z.date(),
      endDate: z.date(),
    }).strict())
    .output(z.object({
      avgLux: z.number().nullable(),
      minLux: z.number().nullable(),
      maxLux: z.number().nullable(),
      recordCount: z.number(),
    }).nullable())
    .query(async ({ input }) => {
      try {
        if (!validateDateRange(input.startDate, input.endDate)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
        }

        const [summary] = await biometricsDb
          .select({
            avgLux: avg(ambientLight.lux),
            minLux: min(ambientLight.lux),
            maxLux: max(ambientLight.lux),
            recordCount: count(),
          })
          .from(ambientLight)
          .where(and(
            gte(ambientLight.timestamp, input.startDate),
            lte(ambientLight.timestamp, input.endDate),
          ))

        if (summary.recordCount === 0) return null

        return {
          avgLux: summary.avgLux !== null ? Number(summary.avgLux) : null,
          minLux: summary.minLux,
          maxLux: summary.maxLux,
          recordCount: summary.recordCount,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to calculate ambient light summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
