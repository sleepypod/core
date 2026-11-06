import { createHash } from 'node:crypto'
import { and, asc, eq, gt, lte } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import type * as schema from '@/src/db/biometrics-schema'
import { watchMotionCaptures } from '@/src/db/biometrics-schema'

/**
 * Apple Watch wrist-movement recordings (sleepypod-ios docs/watch-motion-format.md).
 * Stored as a movement label for comparison and off-pod training only; nothing
 * here feeds sleep staging, movement scoring or hardware control.
 */

export const WATCH_MOTION_VERSIONS = ['watch-motion-v1', 'watch-motion-v2'] as const
export const WATCH_MOTION_MAX_BYTES = 8 * 1024 * 1024
/** Series reads parse every overlapping file, so keep the window to a month. */
export const WATCH_MOTION_MAX_SERIES_DAYS = 31

const BIN_SECONDS = 2
const BIN_MS = BIN_SECONDS * 1000
const MINUTE_MS = 60_000
// The iOS app records at most 12 h; anything far beyond a night is not a Watch recording.
const MAX_SPAN_MS = 24 * 60 * MINUTE_MS
// Unix ms between 2001 and 2100, as the reference import contract.
const unixMs = z.number().int().min(978_307_200_000).max(4_102_444_800_000)
// zod 4 numbers reject Infinity, which JSON.parse makes of overflowing literals like 1e999.
const finite = z.number()
const count = z.number().int().nonnegative()

const binsSchema = z.object({
  startMs: z.array(z.number().int()),
  samples: z.array(count),
  meanMagnitude: z.array(finite),
  magnitudeVariance: z.array(finite),
  maxJerk: z.array(finite),
  movingSamples: z.array(count),
  meanX: z.array(finite).optional(),
  meanY: z.array(finite).optional(),
  meanZ: z.array(finite).optional(),
}).strict()

const fileSchema = z.object({
  version: z.enum(WATCH_MOTION_VERSIONS),
  recordedFromMs: unixMs,
  recordedToMs: unixMs,
  timeZone: z.string().min(1).max(64),
  utcOffsetSeconds: z.number().int().min(-18 * 3600).max(18 * 3600),
  sampleRateHz: z.number().positive().max(1000),
  binSeconds: z.literal(BIN_SECONDS),
  jerkThresholdGPerSecond: z.number().nonnegative(),
  device: z.string().max(200),
  bins: binsSchema,
}).strict()

export type WatchMotionFile = z.infer<typeof fileSchema>
type Bins = WatchMotionFile['bins']
type Column = Exclude<keyof Bins, 'startMs'>

const BASE_COLUMNS = ['samples', 'meanMagnitude', 'magnitudeVariance', 'maxJerk', 'movingSamples'] as const satisfies readonly Column[]
const AXIS_COLUMNS = ['meanX', 'meanY', 'meanZ'] as const satisfies readonly Column[]

export class WatchMotionError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message)
    this.name = 'WatchMotionError'
  }
}

export interface ParsedWatchMotion {
  file: WatchMotionFile
  /** Sorted-key compact JSON of the trimmed file: what is stored and served. */
  canonical: string
  sha256: string
  trimmedBins: number
}

function describeIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || 'file'}: ${issue.message}`)
  const more = error.issues.length > 5 ? `; and ${error.issues.length - 5} more` : ''
  return `Invalid watch-motion file: ${issues.join('; ')}${more}`
}

/** JSON with object keys sorted at every level, matching the iOS encoder's `.sortedKeys`. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v)
}

/**
 * Validates a watch-motion file and trims bins outside [recordedFromMs,
 * recordedToMs). A bin overlapping the start edge stays: bins are Unix-aligned,
 * so the first one can begin up to 2 s before the requested span. Bins wholly
 * outside are leftovers the Watch recorder handed back from an earlier
 * recording; files already on phones contain them, so they are dropped, not
 * rejected.
 */
export function parseWatchMotion(text: string): ParsedWatchMotion {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    throw new WatchMotionError('Body is not valid JSON')
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'raw')) {
    throw new WatchMotionError('raw readings are not accepted')
  }
  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) throw new WatchMotionError(describeIssues(parsed.error))
  const file = parsed.data
  const { bins } = file

  if (file.recordedToMs <= file.recordedFromMs) throw new WatchMotionError('recordedToMs must be after recordedFromMs')
  if (file.recordedToMs - file.recordedFromMs > MAX_SPAN_MS) throw new WatchMotionError('A recording may span at most 24 hours')

  const hasAxes = AXIS_COLUMNS.map(column => bins[column] !== undefined)
  if (file.version === 'watch-motion-v2' && !hasAxes.every(Boolean)) {
    throw new WatchMotionError('watch-motion-v2 requires bins.meanX, bins.meanY and bins.meanZ')
  }
  if (file.version === 'watch-motion-v1' && hasAxes.some(Boolean)) {
    throw new WatchMotionError('watch-motion-v1 must not include bins.meanX, bins.meanY or bins.meanZ')
  }
  const columns: Column[] = file.version === 'watch-motion-v2' ? [...BASE_COLUMNS, ...AXIS_COLUMNS] : [...BASE_COLUMNS]
  const n = bins.startMs.length
  const mismatched = columns.filter(column => bins[column]?.length !== n)
  if (mismatched.length) throw new WatchMotionError(`bins columns must all have ${n} entries like bins.startMs; ${mismatched.map(c => `bins.${c}`).join(', ')} differ`)

  for (let i = 0; i < n; i++) {
    const start = bins.startMs[i]
    if (start % BIN_MS !== 0) throw new WatchMotionError(`bins.startMs.${i}: must be a multiple of ${BIN_MS} ms`)
    if (i > 0 && start <= bins.startMs[i - 1]) throw new WatchMotionError(`bins.startMs.${i}: must be strictly increasing`)
  }

  const keep: number[] = []
  for (let i = 0; i < n; i++) {
    const start = bins.startMs[i]
    if (start + BIN_MS > file.recordedFromMs && start < file.recordedToMs) keep.push(i)
  }
  if (keep.length === 0) throw new WatchMotionError('No bins fall inside recordedFromMs..recordedToMs')

  const trimmed = { ...file, bins: Object.fromEntries((['startMs', ...columns] as const).map(column => [column, keep.map(i => (bins[column] as number[])[i])])) as Bins }
  const canonical = canonicalJson(trimmed)
  return { file: trimmed, canonical, sha256: createHash('sha256').update(canonical).digest('hex'), trimmedBins: n - keep.length }
}

type BioDB = BetterSQLite3Database<typeof schema>
export type WatchMotionSide = 'left' | 'right'
export type WatchMotionStatus = 'created' | 'unchanged' | 'replaced'

export const watchMotionCaptureSchema = z.object({
  id: z.number().int(),
  side: z.enum(['left', 'right']),
  version: z.enum(WATCH_MOTION_VERSIONS),
  recordedFromMs: z.number().int(),
  recordedToMs: z.number().int(),
  bins: z.number().int(),
  trimmedBins: z.number().int(),
  sha256: z.string(),
  createdAt: z.date(),
})
export type WatchMotionCapture = z.infer<typeof watchMotionCaptureSchema>

const metadataColumns = {
  id: watchMotionCaptures.id,
  side: watchMotionCaptures.side,
  version: watchMotionCaptures.version,
  recordedFrom: watchMotionCaptures.recordedFrom,
  recordedTo: watchMotionCaptures.recordedTo,
  bins: watchMotionCaptures.bins,
  trimmedBins: watchMotionCaptures.trimmedBins,
  sha256: watchMotionCaptures.sha256,
  createdAt: watchMotionCaptures.createdAt,
}

function toCapture({ recordedFrom, recordedTo, ...row }: { [K in keyof typeof metadataColumns]: (typeof watchMotionCaptures.$inferSelect)[K] }): WatchMotionCapture {
  return { ...row, recordedFromMs: recordedFrom.getTime(), recordedToMs: recordedTo.getTime() }
}

/**
 * One capture per (side, recordedFromMs). Identical content is a no-op; new
 * content for the same night (a fixed app resending) replaces the stored file
 * and keeps the id.
 */
export function saveWatchMotion(db: BioDB, side: WatchMotionSide, parsed: ParsedWatchMotion): { capture: WatchMotionCapture, status: WatchMotionStatus } {
  const { file } = parsed
  const values = {
    side,
    version: file.version,
    recordedFrom: new Date(file.recordedFromMs),
    recordedTo: new Date(file.recordedToMs),
    bins: file.bins.startMs.length,
    trimmedBins: parsed.trimmedBins,
    sha256: parsed.sha256,
    file: parsed.canonical,
    createdAt: new Date(),
  }
  return db.transaction((tx) => {
    const existing = tx.select(metadataColumns).from(watchMotionCaptures)
      .where(and(eq(watchMotionCaptures.side, side), eq(watchMotionCaptures.recordedFrom, values.recordedFrom))).get()
    if (existing?.sha256 === parsed.sha256) return { capture: toCapture(existing), status: 'unchanged' as const }
    const row = existing
      ? tx.update(watchMotionCaptures).set(values).where(eq(watchMotionCaptures.id, existing.id)).returning(metadataColumns).get()
      : tx.insert(watchMotionCaptures).values(values).returning(metadataColumns).get()
    return { capture: toCapture(row), status: existing ? 'replaced' as const : 'created' as const }
  })
}

/** Captures overlapping [start, end], oldest first. Both bounds optional. */
export function listWatchMotion(db: BioDB, query: { side?: WatchMotionSide, start?: Date, end?: Date }): WatchMotionCapture[] {
  const conditions = []
  if (query.side) conditions.push(eq(watchMotionCaptures.side, query.side))
  if (query.start) conditions.push(gt(watchMotionCaptures.recordedTo, query.start))
  if (query.end) conditions.push(lte(watchMotionCaptures.recordedFrom, query.end))
  return db.select(metadataColumns).from(watchMotionCaptures)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(watchMotionCaptures.recordedFrom), asc(watchMotionCaptures.side)).all()
    .map(toCapture)
}

/** The stored canonical file, or null. */
export function getWatchMotionFile(db: BioDB, id: number): string | null {
  return db.select({ file: watchMotionCaptures.file }).from(watchMotionCaptures).where(eq(watchMotionCaptures.id, id)).get()?.file ?? null
}

export interface WatchMotionMinute {
  /** Minute start. */
  timestamp: Date
  movingSamples: number
  maxJerk: number
  meanVariance: number
  samples: number
}

/**
 * Per-minute summary of the bins starting in [startMs, endMs]. Minutes without
 * bins are absent: no data is not stillness. Overlapping captures count each
 * 2 s bin once (the earliest capture's copy).
 */
export function watchMotionMinutes(files: WatchMotionFile[], startMs: number, endMs: number): WatchMotionMinute[] {
  const seen = new Set<number>()
  const minutes = new Map<number, { moving: number, jerk: number, variance: number, bins: number, samples: number }>()
  for (const file of [...files].sort((a, b) => a.recordedFromMs - b.recordedFromMs)) {
    const { bins } = file
    for (let i = 0; i < bins.startMs.length; i++) {
      const start = bins.startMs[i]
      if (start < startMs || start > endMs || seen.has(start)) continue
      seen.add(start)
      const key = Math.floor(start / MINUTE_MS) * MINUTE_MS
      const minute = minutes.get(key) ?? { moving: 0, jerk: 0, variance: 0, bins: 0, samples: 0 }
      minute.moving += bins.movingSamples[i]
      minute.jerk = Math.max(minute.jerk, bins.maxJerk[i])
      minute.variance += bins.magnitudeVariance[i]
      minute.samples += bins.samples[i]
      minute.bins++
      minutes.set(key, minute)
    }
  }
  return [...minutes.entries()].sort(([a], [b]) => a - b).map(([t, m]) => ({
    timestamp: new Date(t),
    movingSamples: m.moving,
    maxJerk: m.jerk,
    meanVariance: m.variance / m.bins,
    samples: m.samples,
  }))
}

/** Per-minute Watch movement for one side, read from every capture overlapping the window. */
export function watchMotionSeries(db: BioDB, side: WatchMotionSide, start: Date, end: Date): WatchMotionMinute[] {
  const files = db.select({ file: watchMotionCaptures.file }).from(watchMotionCaptures)
    .where(and(eq(watchMotionCaptures.side, side), gt(watchMotionCaptures.recordedTo, new Date(start.getTime() - BIN_MS)),
      lte(watchMotionCaptures.recordedFrom, end))).all()
    .map(row => JSON.parse(row.file) as WatchMotionFile)
  return watchMotionMinutes(files, start.getTime(), end.getTime())
}
