import { z } from 'zod'
import { householdIdSchema, revisionSchema } from './contract'
import { historyTimeSchema, personalHistoryRangeSchema, personalHistoryQuerySchema, personalHistoryRecordSchema } from './historyContract'

export const personalHistoryScopeSchema = z.object({
  podId: householdIdSchema, householdId: householdIdSchema, accountId: householdIdSchema,
  sleeperId: householdIdSchema, sessionRevision: revisionSchema,
  householdRevision: revisionSchema, assignmentRevision: revisionSchema,
}).strict()
const envelope = {
  version: z.literal(1), scope: personalHistoryScopeSchema,
  attributionRevision: revisionSchema, generatedAt: historyTimeSchema,
  source: z.literal('pod'), interpretation: z.literal('recordings_not_confirmed_sleep'),
}
export const personalHistoryPageSchema = z.object({
  ...envelope,
  query: personalHistoryRangeSchema.refine(value => value.endsAt > value.startsAt && value.endsAt - value.startsAt <= 90 * 86400_000),
  intervalSelection: z.literal('overlap_full_records'),
  records: z.array(personalHistoryRecordSchema).max(100),
  nextCursor: z.string().min(1).max(4096).nullable(),
}).strict().superRefine((value, context) => {
  if (value.records.length > value.query.limit
    || new Set(value.records.map(record => record.id)).size !== value.records.length
    || value.records.some(record => record.sleeperId !== value.scope.sleeperId
      || record.payload.kind !== value.query.kind || record.startsAt >= value.query.endsAt || record.endsAt <= value.query.startsAt)
    || (value.nextCursor !== null && value.records.length !== value.query.limit))
    context.addIssue({ code: 'custom', message: 'History does not match the requested person and interval.' })
})
export const personalHistoryDetailSchema = z.object({ ...envelope, record: personalHistoryRecordSchema }).strict()
  .refine(value => value.record.sleeperId === value.scope.sleeperId, 'History belongs to a different person.')
export type PersonalHistoryPage = z.infer<typeof personalHistoryPageSchema>
export type PersonalHistoryDetail = z.infer<typeof personalHistoryDetailSchema>

/** HTTP accepts only canonical decimal milliseconds and one of each named field. */
export function parsePersonalHistorySearch(search: URLSearchParams) {
  const input: Record<string, unknown> = {}
  for (const [key, value] of search) {
    if (!['startsAt', 'endsAt', 'kind', 'limit', 'cursor'].includes(key)) throw new Error('Unsupported history query field')
    if (Object.hasOwn(input, key)) throw new Error('Duplicate history query field')
    if (['startsAt', 'endsAt', 'limit'].includes(key)) {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid history query number')
      input[key] = Number(value)
    }
    else input[key] = value
  }
  return personalHistoryQuerySchema.parse(input)
}
