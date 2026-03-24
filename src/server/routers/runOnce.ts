import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { runOnceSessions, deviceSettings } from '@/src/db/schema'
import { eq, and } from 'drizzle-orm'
import { getJobManager } from '@/src/scheduler'
import { withHardwareClient } from '@/src/server/helpers'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { fahrenheitToLevel } from '@/src/hardware/types'
import { sideSchema, temperatureSchema } from '@/src/server/validation-schemas'

const timeStringSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:mm format (00:00-23:59)')

const setPointSchema = z.object({
  time: timeStringSchema,
  temperature: temperatureSchema,
})

export const runOnceRouter = router({
  /**
   * Start a run-once session — applies a curve from now until wake time.
   * Fires the first set point immediately, schedules the rest as one-time jobs.
   */
  start: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/run-once/start', protect: false, tags: ['RunOnce'] } })
    .input(
      z.object({
        side: sideSchema,
        setPoints: z.array(setPointSchema).min(1),
        wakeTime: timeStringSchema,
      }).strict(),
    )
    .output(z.object({
      sessionId: z.number(),
      expiresAt: z.number(),
    }))
    .mutation(async ({ input }) => {
      const jobManager = await getJobManager()

      // Cancel any existing active session for this side (atomic)
      db.transaction((tx) => {
        const existing = tx
          .select({ id: runOnceSessions.id })
          .from(runOnceSessions)
          .where(and(
            eq(runOnceSessions.side, input.side),
            eq(runOnceSessions.status, 'active'),
          ))
          .all()

        for (const row of existing) {
          tx.update(runOnceSessions)
            .set({ status: 'cancelled' })
            .where(eq(runOnceSessions.id, row.id))
            .run()
        }
      })
      jobManager.cancelRunOnceSession(input.side)

      // Compute expiry from wake time
      const [settings] = await db.select().from(deviceSettings).limit(1)
      const timezone = settings?.timezone ?? 'America/Los_Angeles'
      const now = new Date()
      const expiresAt = timeToDate(input.wakeTime, timezone, now)

      // Create session in DB
      const [session] = await db
        .insert(runOnceSessions)
        .values({
          side: input.side,
          setPoints: JSON.stringify(input.setPoints),
          wakeTime: input.wakeTime,
          expiresAt,
          status: 'active',
        })
        .returning({ id: runOnceSessions.id })

      // Power on + fire first set point immediately
      const firstTemp = input.setPoints[0].temperature
      await withHardwareClient(async (client) => {
        await client.setPower(input.side, true, firstTemp)
        return { success: true }
      }, 'Failed to start run-once session')

      broadcastMutationStatus(input.side, {
        targetTemperature: firstTemp,
        targetLevel: fahrenheitToLevel(firstTemp),
      })

      // Schedule remaining set points + cleanup
      jobManager.scheduleRunOnceSession(
        session.id,
        input.side,
        input.setPoints,
        input.wakeTime,
        timezone,
      )

      console.log(`Run-once session ${session.id} started for ${input.side} until ${input.wakeTime}`)

      return {
        sessionId: session.id,
        expiresAt: Math.floor(expiresAt.getTime() / 1000),
      }
    }),

  /**
   * Get the active run-once session for a side, or null.
   */
  getActive: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/run-once/active', protect: false, tags: ['RunOnce'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(z.any())
    .query(async ({ input }) => {
      const [session] = await db
        .select()
        .from(runOnceSessions)
        .where(and(
          eq(runOnceSessions.side, input.side),
          eq(runOnceSessions.status, 'active'),
        ))
        .limit(1)

      if (!session) return null

      let setPoints: unknown = []
      try {
        setPoints = JSON.parse(session.setPoints)
      }
      catch { /* malformed — return empty */ }

      return {
        id: session.id,
        side: session.side,
        setPoints,
        wakeTime: session.wakeTime,
        startedAt: Math.floor(session.startedAt.getTime() / 1000),
        expiresAt: Math.floor(session.expiresAt.getTime() / 1000),
        status: session.status,
      }
    }),

  /**
   * Cancel an active run-once session. Recurring schedule resumes immediately.
   */
  cancel: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/run-once/cancel', protect: false, tags: ['RunOnce'] } })
    .input(z.object({ side: sideSchema }).strict())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      const jobManager = await getJobManager()

      await db
        .update(runOnceSessions)
        .set({ status: 'cancelled' })
        .where(and(
          eq(runOnceSessions.side, input.side),
          eq(runOnceSessions.status, 'active'),
        ))

      jobManager.cancelRunOnceSession(input.side)
      console.log(`Run-once session cancelled for ${input.side}`)
      return { success: true }
    }),
})

/**
 * Convert HH:mm to a Date. If the time is in the past, returns tomorrow.
 */
function timeToDate(time: string, timezone: string, now: Date): Date {
  const [hour, minute] = time.split(':').map(Number)
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: timezone })
  const candidate = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`)

  const utcStr = candidate.toLocaleString('en-US', { timeZone: 'UTC' })
  const tzStr = candidate.toLocaleString('en-US', { timeZone: timezone })
  const offset = new Date(utcStr).getTime() - new Date(tzStr).getTime()
  const adjusted = new Date(candidate.getTime() + offset)

  if (adjusted <= now) {
    return new Date(adjusted.getTime() + 24 * 60 * 60 * 1000)
  }
  return adjusted
}
