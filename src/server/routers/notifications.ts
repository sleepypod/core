import { z } from 'zod'
import { notificationAcknowledgmentSchema, notificationIdSchema, notificationPageSchema } from '@/src/notifications/contract'
import { getNotificationStore } from '@/src/notifications/instance'
import { publicProcedure, router } from '../trpc'

export const notificationsRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/notifications', tags: ['Notifications'] } })
    .input(z.object({ beforeId: notificationIdSchema.optional() }).strict())
    .output(notificationPageSchema)
    .query(({ input }) => getNotificationStore().list(input.beforeId)),
  acknowledge: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/notifications/acknowledge', tags: ['Notifications'] } })
    .input(z.object({ ids: z.array(notificationIdSchema).min(1).max(50) }).strict())
    .output(notificationAcknowledgmentSchema)
    .mutation(({ input }) => getNotificationStore().acknowledge(input.ids)),
})
