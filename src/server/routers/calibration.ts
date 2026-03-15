import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb } from '@/src/db'
import {
  calibrationProfiles,
  calibrationRuns,
  vitalsQuality,
} from '@/src/db/biometrics-schema'
import { and, eq, desc, gte, lte } from 'drizzle-orm'
import { sideSchema } from '@/src/server/validation-schemas'
import { writeFile } from 'node:fs/promises'

const TRIGGER_PATH = process.env.CALIBRATION_TRIGGER_PATH
  ?? '/persistent/sleepypod-data/.calibrate-trigger'

const sensorTypeSchema = z.enum(['piezo', 'capacitance', 'temperature'])

const calibrationStatusSchema = z.object({
  id: z.number(),
  side: z.string(),
  sensorType: z.string(),
  status: z.string(),
  qualityScore: z.number().nullable(),
  samplesUsed: z.number().nullable(),
  createdAt: z.date(),
  expiresAt: z.date().nullable(),
  errorMessage: z.string().nullable(),
})

export const calibrationRouter = router({
  /**
   * Get current calibration status for all sensor types on a side.
   */
  getStatus: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/calibration/status', protect: false, tags: ['Calibration'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(z.object({
      capacitance: calibrationStatusSchema.nullable(),
      piezo: calibrationStatusSchema.nullable(),
      temperature: calibrationStatusSchema.nullable(),
    }))
    .query(async ({ input }) => {
      const profiles = await biometricsDb
        .select()
        .from(calibrationProfiles)
        .where(eq(calibrationProfiles.side, input.side))

      const byType = (type: string) => {
        const p = profiles.find(r => r.sensorType === type)
        if (!p) return null
        return {
          id: p.id,
          side: p.side,
          sensorType: p.sensorType,
          status: p.status,
          qualityScore: p.qualityScore,
          samplesUsed: p.samplesUsed,
          createdAt: p.createdAt,
          expiresAt: p.expiresAt,
          errorMessage: p.errorMessage,
        }
      }

      return {
        capacitance: byType('capacitance'),
        piezo: byType('piezo'),
        temperature: byType('temperature'),
      }
    }),

  /**
   * Get calibration history (audit log).
   */
  getHistory: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/calibration/history', protect: false, tags: ['Calibration'] } })
    .input(z.object({
      side: sideSchema,
      sensorType: sensorTypeSchema.optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }).strict())
    .output(z.any())
    .query(async ({ input }) => {
      const conditions = [eq(calibrationRuns.side, input.side)]
      if (input.sensorType) {
        conditions.push(eq(calibrationRuns.sensorType, input.sensorType))
      }

      return biometricsDb
        .select()
        .from(calibrationRuns)
        .where(and(...conditions))
        .orderBy(desc(calibrationRuns.createdAt))
        .limit(input.limit)
    }),

  /**
   * Trigger calibration from the iOS app.
   * Writes a trigger file that the calibrator module picks up within 10s.
   */
  triggerCalibration: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/calibration/trigger', protect: false, tags: ['Calibration'] } })
    .input(z.object({
      side: sideSchema,
      sensorType: sensorTypeSchema,
    }).strict())
    .output(z.object({ triggered: z.boolean(), message: z.string() }))
    .mutation(async ({ input }) => {
      try {
        const payload = JSON.stringify({
          side: input.side,
          sensor_type: input.sensorType,
          ts: Math.floor(Date.now() / 1000),
        })
        await writeFile(TRIGGER_PATH, payload)

        // Mark as pending in DB for immediate status feedback
        await biometricsDb
          .insert(calibrationProfiles)
          .values({
            side: input.side,
            sensorType: input.sensorType,
            status: 'pending',
            parameters: {},
            createdAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [calibrationProfiles.side, calibrationProfiles.sensorType],
            set: { status: 'pending', createdAt: new Date(), errorMessage: null },
          })

        return {
          triggered: true,
          message: `Calibration queued for ${input.side}/${input.sensorType}. The calibrator module will process it within 10 seconds.`,
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to trigger calibration: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Trigger full calibration for all sensor types on both sides.
   */
  triggerFullCalibration: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/calibration/trigger-all', protect: false, tags: ['Calibration'] } })
    .input(z.object({}).strict())
    .output(z.object({ triggered: z.boolean(), message: z.string() }))
    .mutation(async () => {
      try {
        const payload = JSON.stringify({
          side: 'all',
          sensor_type: 'all',
          ts: Math.floor(Date.now() / 1000),
        })
        await writeFile(TRIGGER_PATH, payload)
        return {
          triggered: true,
          message: 'Full calibration queued for all sensors on both sides.',
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to trigger calibration: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),

  /**
   * Get quality scores for recent vitals readings.
   */
  getVitalsQuality: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/calibration/vitals-quality', protect: false, tags: ['Calibration'] } })
    .input(z.object({
      side: sideSchema,
      startDate: z.date().optional(),
      endDate: z.date().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }).strict())
    .output(z.any())
    .query(async ({ input }) => {
      const conditions = [eq(vitalsQuality.side, input.side)]
      if (input.startDate) {
        conditions.push(gte(vitalsQuality.timestamp, input.startDate))
      }
      if (input.endDate) {
        conditions.push(lte(vitalsQuality.timestamp, input.endDate))
      }

      return biometricsDb
        .select()
        .from(vitalsQuality)
        .where(and(...conditions))
        .orderBy(desc(vitalsQuality.timestamp))
        .limit(input.limit)
    }),
})
