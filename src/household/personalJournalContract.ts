import { z } from 'zod'
import { householdContextSchema, householdIdSchema } from './contract'
import { personalHistoryScopeSchema } from './historyApiContract'
import { journalDateSchema, journalFieldsSchema, journalRecordSchema } from '@/src/journal/contract'

export const personalJournalTimeZoneSchema = journalRecordSchema.shape.timeZone
const instant = z.number().int().nonnegative().max(253402300799000)
export const personalJournalRecordSchema = z.object({
  date: journalDateSchema, timeZone: personalJournalTimeZoneSchema,
  createdAt: instant, updatedAt: instant, fields: journalFieldsSchema,
}).strict().refine(value => value.updatedAt >= value.createdAt, 'Check-in clocks are inconsistent.')
export const personalJournalSelectionSchema = z.object({
  date: journalDateSchema, revision: householdIdSchema.nullable(),
  timeZone: personalJournalTimeZoneSchema.nullable(), record: personalJournalRecordSchema.nullable(),
}).strict().refine(value => (value.revision === null) === (value.timeZone === null)
  && (!value.record || (value.revision !== null && value.date === value.record.date && value.timeZone === value.record.timeZone)),
'Check-in identity is inconsistent.')
export const personalJournalWriteSchema = householdContextSchema.extend({
  date: journalDateSchema, expectedRevision: householdIdSchema.nullable(),
  expectedTimeZone: personalJournalTimeZoneSchema, fields: journalFieldsSchema.nullable(),
}).strict()
export const personalJournalReceiptSchema = z.object({
  requestId: householdIdSchema, date: journalDateSchema, revision: householdIdSchema,
  timeZone: personalJournalTimeZoneSchema, savedAt: instant, outcome: z.enum(['saved', 'deleted']),
}).strict()
const envelope = {
  version: z.literal(1), generatedAt: instant, scope: personalHistoryScopeSchema,
  interpretation: z.literal('personal_self_report_not_sleep_measurement'),
}
export const personalJournalRangeSchema = z.object({ from: journalDateSchema, through: journalDateSchema }).strict().refine((value) => {
  const days = (Date.parse(value.through) - Date.parse(value.from)) / 86_400_000
  return days >= 0 && days < 90
}, 'Choose at most 90 calendar dates.')
const querySchema = z.union([
  z.object({ date: journalDateSchema }).strict(), personalJournalRangeSchema,
])
export const personalJournalReadResponseSchema = z.object({
  ...envelope, currentTimeZone: personalJournalTimeZoneSchema,
  query: querySchema,
  entries: z.array(personalJournalSelectionSchema).max(90),
}).strict().superRefine((value, context) => {
  const query = value.query
  const inconsistent = 'date' in query
    ? value.entries.length !== 1 || value.entries[0].date !== query.date
    : value.entries.some((entry, index) => !entry.record || entry.date < query.from || entry.date > query.through
      || (index > 0 && entry.date >= value.entries[index - 1].date))
  if (inconsistent || value.entries.some(entry => entry.record && entry.record.updatedAt > value.generatedAt))
    context.addIssue({ code: 'custom', message: 'Check-in data does not match the selected dates or observation clock.' })
})
export const personalJournalWriteResponseSchema = z.object({ ...envelope, receipt: personalJournalReceiptSchema.nullable() }).strict()
  .refine(value => !value.receipt || value.receipt.savedAt <= value.generatedAt, 'Receipt is newer than the response clock.')
export type PersonalJournalSelection = z.infer<typeof personalJournalSelectionSchema>
export type PersonalJournalWrite = z.infer<typeof personalJournalWriteSchema>
export type PersonalJournalReceipt = z.infer<typeof personalJournalReceiptSchema>

/** Use an explicit single date or a bounded calendar range; there are no account or side selectors. */
export function parsePersonalJournalQuery(search: URLSearchParams) {
  const input: Record<string, string> = {}
  for (const [key, value] of search) {
    if (!['date', 'from', 'through'].includes(key) || Object.hasOwn(input, key)) throw new Error('Unsupported or duplicate check-in query.')
    input[key] = value
  }
  return querySchema.parse(input)
}
