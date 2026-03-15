import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb } from '@/src/db'
import { bedTemp, freezerTemp } from '@/src/db/biometrics-schema'
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
}).strict().refine(
  data => !(data.startDate && data.endDate) || validateDateRange(data.startDate, data.endDate),
  { message: 'startDate must be before or equal to endDate', path: ['endDate'] },
)

export const environmentRouter = router({
  getBedTemp: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/environment/bed-temp', protect: false, tags: ['Environment'] } })
    .input(dateRangeInput)
    .output(z.any())
    .query(async ({ input }) => {
      try {
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
    .output(z.any())
    .query(async ({ input }) => {
      try {
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
    .output(z.any())
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
    .output(z.any())
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
    .output(z.any())
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
        unit: z.enum(['F', 'C']).default('F'),
      }).strict().refine(
        data => validateDateRange(data.startDate, data.endDate),
        { message: 'startDate must be before or equal to endDate', path: ['endDate'] },
      ),
    )
    .query(async ({ input }) => {
      try {
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
})
