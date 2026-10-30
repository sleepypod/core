import { z } from 'zod'

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000)

/** A durable reservation survives interruption; it is never interpreted as successful delivery. */
export const comfortApplicationSchema = z.object({
  requestId: z.string().uuid(), segment: z.string().min(1).max(1000),
  targetF: z.number().min(55).max(110), previousF: z.number().min(55).max(110),
  createdAt: timestamp, reservedAt: timestamp, finishedAt: timestamp.nullable(),
  outcome: z.enum(['attempting', 'acknowledged', 'unknown']),
  receiptId: z.string().uuid().nullable(),
}).strict().refine(value => value.createdAt <= value.reservedAt && (value.finishedAt === null || value.finishedAt >= value.reservedAt), 'Invalid comfort application clock')
  .refine(value => value.outcome !== 'acknowledged' || (value.finishedAt !== null && value.receiptId !== null), 'Missing temperature receipt')

export type ComfortApplication = z.infer<typeof comfortApplicationSchema>
