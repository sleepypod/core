import { z } from 'zod'

export const journalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  value >= '1970-01-01' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
'Use a real calendar date on or after 1970-01-01')
export const journalSideSchema = z.enum(['left', 'right'])
export const journalFieldsSchema = z.object({
  restfulness: z.number().int().min(1).max(5),
  comfort: z.enum(['cold', 'comfortable', 'warm']),
  caffeine: z.boolean(), alcohol: z.boolean(), exercise: z.boolean(),
  notes: z.string().trim().max(500),
}).strict()
export type JournalFields = z.infer<typeof journalFieldsSchema>
const milliseconds = z.number().int().nonnegative().max(253402300799000)
const timeZone = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
    return true
  }
  catch { return false }
}, 'Unknown time zone')
export const journalRecordSchema = z.object({
  side: journalSideSchema, date: journalDateSchema, fields: journalFieldsSchema,
  timeZone, origin: z.enum(['free-sleep', 'sleepypod']),
  createdAt: milliseconds.nullable(), updatedAt: milliseconds.nullable(), importedAt: milliseconds.nullable(),
}).strict()
export type JournalRecord = z.infer<typeof journalRecordSchema>
export const journalSelectionSchema = z.object({
  side: journalSideSchema, date: journalDateSchema, revision: z.uuid().nullable(), record: journalRecordSchema.nullable(),
})
export type JournalSelection = z.infer<typeof journalSelectionSchema>
export const journalReadSchema = z.object({
  side: journalSideSchema, date: journalDateSchema.optional(), days: z.number().int().min(1).max(90).default(30),
}).strict()
export const journalWriteSchema = z.object({
  side: journalSideSchema, date: journalDateSchema, expectedRevision: z.uuid().nullable(),
  // Null deletes only this entry; its tombstone prevents stale recreation.
  fields: journalFieldsSchema.nullable(),
}).strict()
export type JournalWrite = z.infer<typeof journalWriteSchema>
export const journalCohortSchema = z.object({
  source: z.enum(['sleepypod', 'free-sleep']), timeZone: z.string().nullable(),
  status: z.enum(['ready', 'unavailable', 'not_imported', 'too_many_records']),
  matchedDates: z.number().int().nonnegative(), excludedDates: z.number().int().nonnegative(),
  associations: z.array(z.object({
    habit: z.enum(['caffeine', 'alcohol', 'exercise']), withCount: z.number().int().min(5), withoutCount: z.number().int().min(5),
    presenceDifferenceMinutes: z.number(),
  })),
})
export type JournalCohort = z.infer<typeof journalCohortSchema>
export const journalPageSchema = z.object({
  apiVersion: z.literal(1), side: journalSideSchema, timeZone, deviceDate: journalDateSchema,
  from: journalDateSchema, through: journalDateSchema, selected: journalSelectionSchema,
  entries: z.array(journalSelectionSchema).max(90),
  patterns: z.object({
    recentEntries: z.number().int().min(0).max(7), averageRestfulness: z.number().nullable(), warmCount: z.number().int(), coldCount: z.number().int(),
    cohorts: z.array(journalCohortSchema).max(2),
    note: z.string(),
  }),
})
export type JournalPage = z.infer<typeof journalPageSchema>
export class JournalError extends Error {
  constructor(message: string, readonly code: 'CONFLICT' | 'BAD_REQUEST' | 'PRECONDITION_FAILED') { super(message) }
}
