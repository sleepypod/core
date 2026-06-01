import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { db } from '@/src/db'
import { runOnceSessions, deviceSettings } from '@/src/db/schema'
import { eq, and, gt } from 'drizzle-orm'
import { getJobManager } from '@/src/scheduler'
import { withHardwareClient } from '@/src/server/helpers'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { fahrenheitToLevel } from '@/src/hardware/types'
import { sideSchema, temperatureSchema, timeStringSchema } from '@/src/server/validation-schemas'
import { timeToDate } from '@/src/scheduler/timeUtils'

const setPointSchema = z.object({
  time: timeStringSchema,
  temperature: temperatureSchema,
})

export const runOnceRouter = router({
  /**
   * Start a run-once session — applies a curve from now until wake time.
   * Powers on the side, fires the first set point immediately, schedules the rest.
   */
  start: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/run-once/start', protect: false, tags: ['RunOnce'] } })
    .input(
      z.object({
        side: sideSchema,
        setPoints: z.array(setPointSchema).min(1).max(96),
        wakeTime: timeStringSchema,
      }).strict(),
    )
    .output(z.object({
      sessionId: z.number(),
      expiresAt: z.number(),
    }))
    .mutation(async ({ input }) => {
      const jobManager = await getJobManager()

      // Cancel any existing active session for this side
      // (synchronous transaction — better-sqlite3 is sync)
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

      // Reject sessions longer than 14 hours (guards against wake time = now wrapping to 24h)
      const MAX_SESSION_MS = 14 * 60 * 60 * 1000
      if (expiresAt.getTime() - now.getTime() > MAX_SESSION_MS) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Session too long (${Math.round((expiresAt.getTime() - now.getTime()) / 3600000)}h). Wake time may have already passed.`,
        })
      }

      // Power on + fire first set point immediately (before inserting session,
      // so a hardware failure doesn't leave an orphaned active session)
      const firstTemp = input.setPoints[0].temperature
      await withHardwareClient(async (client) => {
        await client.setPower(input.side, true, firstTemp)
        return { success: true }
      }, 'Failed to start run-once session')

      broadcastMutationStatus(input.side, {
        targetTemperature: firstTemp,
        targetLevel: fahrenheitToLevel(firstTemp),
      })

      // Create session in DB (after hardware success)
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

      if (!session) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create run-once session' })
      }

      // Schedule remaining set points (skip the first — already applied) + cleanup
      jobManager.scheduleRunOnceSession(
        session.id,
        input.side,
        input.setPoints.slice(1),
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
    .output(z.object({
      id: z.number(),
      side: z.enum(['left', 'right']),
      setPoints: z.array(setPointSchema),
      wakeTime: z.string(),
      startedAt: z.number(),
      expiresAt: z.number(),
      status: z.enum(['active', 'completed', 'cancelled']),
    }).nullable())
    .query(async ({ input }) => {
      const [session] = await db
        .select()
        .from(runOnceSessions)
        .where(and(
          eq(runOnceSessions.side, input.side),
          eq(runOnceSessions.status, 'active'),
          gt(runOnceSessions.expiresAt, new Date()),
        ))
        .limit(1)

      if (!session) return null

      // Validate the persisted JSON against the same schema the input uses;
      // a malformed row mustn't break clients consuming the typed output.
      let setPoints: z.infer<typeof setPointSchema>[] = []
      try {
        const parsed = z.array(setPointSchema).safeParse(JSON.parse(session.setPoints))
        if (parsed.success) setPoints = parsed.data
      }
      catch {
        // malformed — return empty
      }

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
      broadcastMutationStatus(input.side)
      console.log(`Run-once session cancelled for ${input.side}`)
      return { success: true }
    }),
})

