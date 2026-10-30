import { z } from 'zod'

export const NOTIFICATION_LIFETIME_MS = 15 * 60_000
export const NOTIFICATION_DEDUPLICATION_MS = 60_000
export const NOTIFICATION_RETENTION_MS = 30 * 86_400_000
export const MAX_NOTIFICATIONS = 1000
export const NOTIFICATION_PAGE_SIZE = 50
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const notificationIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const notificationSchema = z.object({
  id: notificationIdSchema,
  source: z.literal('automation'),
  sourceId: notificationIdSchema,
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  createdAt: timestamp,
  expiresAt: timestamp,
  acknowledgedAt: timestamp.nullable(),
})
export const notificationPageSchema = z.object({
  apiVersion: z.literal(1),
  generatedAt: timestamp,
  newestId: notificationIdSchema.nullable(),
  nextBeforeId: notificationIdSchema.nullable(),
  unreadCount: z.number().int().min(0),
  items: z.array(notificationSchema).max(NOTIFICATION_PAGE_SIZE),
  delivery: z.object({ foregroundInbox: z.boolean(), backgroundPush: z.literal(false) }),
})
export const notificationAcknowledgmentSchema = z.object({
  generatedAt: timestamp,
  acknowledgedIds: z.array(notificationIdSchema),
  missingIds: z.array(notificationIdSchema),
})
export type NotificationItem = z.infer<typeof notificationSchema>
export type NotificationPage = z.infer<typeof notificationPageSchema>

export const publishNotificationSchema = notificationSchema.pick({ sourceId: true, title: true, message: true }).strict()
