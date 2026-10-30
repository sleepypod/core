import { z } from 'zod'

export const HISTORY_FORMAT = 'sleepypod-imported-history/1' as const
export const HISTORY_FILENAME = 'free-sleep-history.db'
export const HISTORY_MAX_SECONDS = 253402300799
export const HISTORY_MAX_RANGE_MS = 90 * 86_400_000
export const HISTORY_MAX_INTERVAL_BYTES = 262144
export const historyKindSchema = z.enum(['presence', 'vitals', 'movement'])
export type HistoryKind = z.infer<typeof historyKindSchema>
export const historySideSchema = z.enum(['left', 'right'])
const identity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const seconds = z.number().int().min(0).max(HISTORY_MAX_SECONDS)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const bounds = z.object({ records: count, readableRecords: count, firstAt: seconds.nullable(), lastAt: seconds.nullable() })
  .refine(value => value.readableRecords <= value.records && (value.readableRecords === 0
    ? value.firstAt === null && value.lastAt === null
    : value.firstAt !== null && value.lastAt !== null && value.firstAt <= value.lastAt), 'Invalid history bounds')
const sideBounds = z.object({ presence: bounds, vitals: bounds, movement: bounds })

export const historySnapshotSchema = z.object({
  format: z.literal(HISTORY_FORMAT), source: z.literal('free-sleep'), snapshotId: digest,
  sourceSha256: digest, timeZone: z.string().min(1).max(100), importedAt: count.max(HISTORY_MAX_SECONDS * 1000),
  sides: z.object({ left: sideBounds, right: sideBounds }), unassignedRecords: count,
})
export type HistorySnapshot = z.infer<typeof historySnapshotSchema>

export const HISTORY_SEMANTICS = {
  access: 'read_only', purpose: 'history_only', quality: 'legacy_unqualified',
  presence: 'bed_presence_not_sleep_stages', vitals: 'five_minute_interval_start_averages',
  hrv: 'original_estimator_definition_unverified', movement: 'original_total_movement',
  previewEvidence: false, automationInput: false,
} as const
const semanticsSchema = z.object({
  access: z.literal(HISTORY_SEMANTICS.access), purpose: z.literal(HISTORY_SEMANTICS.purpose),
  quality: z.literal(HISTORY_SEMANTICS.quality), presence: z.literal(HISTORY_SEMANTICS.presence),
  vitals: z.literal(HISTORY_SEMANTICS.vitals), hrv: z.literal(HISTORY_SEMANTICS.hrv),
  movement: z.literal(HISTORY_SEMANTICS.movement), previewEvidence: z.literal(false), automationInput: z.literal(false),
})
export const historyStatusSchema = z.object({
  apiVersion: z.literal(1), status: z.enum(['ready', 'not_imported', 'unavailable']),
  snapshot: historySnapshotSchema.nullable(), message: z.string(), semantics: semanticsSchema,
})

export const historyPageInputSchema = z.object({
  snapshotId: digest, side: historySideSchema, kind: historyKindSchema,
  startTime: z.iso.datetime({ offset: true }), endTime: z.iso.datetime({ offset: true }),
  cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(500).default(100),
}).strict().refine((input) => {
  const duration = Date.parse(input.endTime) - Date.parse(input.startTime)
  return duration > 0 && duration <= HISTORY_MAX_RANGE_MS && Date.parse(input.startTime) >= 0
}, 'Choose a range after 1970 of at most 90 days')
export type HistoryPageInput = z.infer<typeof historyPageInputSchema>

export const presenceHistoryRecordSchema = z.object({
  kind: z.literal('presence'), id: identity, side: historySideSchema,
  enteredBedAt: seconds, leftBedAt: seconds,
  reportedDurationSeconds: z.number().nullable(), exits: z.number().nullable(),
})
export const vitalsHistoryRecordSchema = z.object({
  kind: z.literal('vitals'), id: identity, side: historySideSchema, timestamp: seconds,
  heartRateBpm: z.number().nullable(), hrvEstimateMs: z.number().nullable(), breathingRatePerMinute: z.number().nullable(),
})
export const movementHistoryRecordSchema = z.object({
  kind: z.literal('movement'), id: identity, side: historySideSchema, timestamp: seconds, totalMovement: z.number().nullable(),
})
export const historyRecordSchema = z.discriminatedUnion('kind', [presenceHistoryRecordSchema, vitalsHistoryRecordSchema, movementHistoryRecordSchema])
export type HistoryRecord = z.infer<typeof historyRecordSchema>
export const historyPageSchema = z.object({
  apiVersion: z.literal(1), snapshotId: digest, side: historySideSchema, kind: historyKindSchema,
  records: z.array(historyRecordSchema), nextCursor: z.string().nullable(), semantics: semanticsSchema,
})
export type HistoryPage = z.infer<typeof historyPageSchema>

export const historyDetailInputSchema = z.object({ snapshotId: digest, side: historySideSchema, id: identity }).strict()
const intervalsSchema = z.object({
  status: z.enum(['available', 'unavailable', 'invalid', 'too_large', 'unsupported_window']),
  intervals: z.array(z.tuple([seconds, seconds])).nullable(), coveredSeconds: z.number().nonnegative().nullable(),
})
export const historyDetailSchema = z.object({
  apiVersion: z.literal(1), snapshotId: digest, record: presenceHistoryRecordSchema,
  present: intervalsSchema, absent: intervalsSchema,
  rawPresentIntervals: z.string().nullable(), rawAbsentIntervals: z.string().nullable(),
  semantics: semanticsSchema,
})
export type HistoryIntervals = z.infer<typeof intervalsSchema>
