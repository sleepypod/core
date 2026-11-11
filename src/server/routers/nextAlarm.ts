import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { NextAlarmError, nextAlarmReadSchema, nextAlarmSchema, nextAlarmWriteSchema, laterAlarmApplySchema, laterAlarmPreviewInputSchema, laterAlarmPreviewSchema } from '@/src/alarms/contract'
import { alarmStore } from '@/src/alarms/instance'
import { applyLaterAlarm, changeNextAlarm } from '@/src/alarms/service'
import { withSideLock } from '@/src/hardware/sideLock'
import { applyScheduler } from '../scheduleLibrary'
import { publicProcedure, router } from '../trpc'

async function alarmResult<Result>(work: () => Result | Promise<Result>): Promise<Result> {
  try {
    return await work()
  }
  catch (error) {
    if (error instanceof NextAlarmError) throw new TRPCError({ code: error.code, message: error.message })
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The next alarm could not be confirmed. Refresh before trying again.' })
  }
}
export const nextAlarmRouter = router({
  previewLater: publicProcedure.meta({ openapi: { method: 'POST', path: '/v1/alarm/later-preview', tags: ['Alarms'] } })
    .input(laterAlarmPreviewInputSchema).output(laterAlarmPreviewSchema)
    .mutation(({ input }) => alarmResult(() => alarmStore().previewLater(input, Date.now()))),
  applyLater: publicProcedure.meta({ openapi: { method: 'POST', path: '/v1/alarm/later-apply', tags: ['Alarms'] } })
    .input(laterAlarmApplySchema).output(nextAlarmSchema.extend({ schedulerUpdated: z.boolean() }))
    .mutation(({ input }) => alarmResult(() => applyLaterAlarm(input.preview, { store: alarmStore(), now: Date.now, withSideLock,
      synchronize: side => applyScheduler(manager => manager.refreshAlarmOverrides(side)) }))),
  get: publicProcedure.meta({ openapi: { method: 'GET', path: '/v1/alarm/next', tags: ['Alarms'] } })
    .input(nextAlarmReadSchema).output(nextAlarmSchema)
    .query(({ input }) => alarmResult(() => alarmStore().page(input.side, Date.now()))),
  change: publicProcedure.meta({ openapi: { method: 'POST', path: '/v1/alarm/override', tags: ['Alarms'] } })
    .input(nextAlarmWriteSchema).output(nextAlarmSchema.extend({ schedulerUpdated: z.boolean() }))
    .mutation(({ input }) => alarmResult(() => changeNextAlarm(input, { store: alarmStore(), now: Date.now, withSideLock,
      synchronize: side => applyScheduler(manager => manager.refreshAlarmOverrides(side)) }))),
})
