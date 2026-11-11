import { z } from 'zod'

export const RESPONSE_POLICY = 'acknowledged-small-step-v1'
const count = z.number().int().nonnegative()
export const responseAuditSchema = z.object({
  apiVersion: z.literal(1), policy: z.literal(RESPONSE_POLICY), generatedAt: z.number().int().positive(),
  side: z.enum(['left', 'right']), attribution: z.literal('physical_zone_only'),
  status: z.enum(['read', 'partial', 'unavailable']), reviewedNights: count, responseNights: count,
  coolingWindows: count, warmingWindows: count, requiredNights: z.literal(20), datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  modelAvailable: z.literal(false), activationAvailable: z.literal(false),
  exclusions: z.array(z.object({ date: z.string(), count, reason: z.string() }).strict()).max(300),
  exclusionsTruncated: z.boolean(), reason: z.string(),
}).strict()
export type ResponseAudit = z.infer<typeof responseAuditSchema>
