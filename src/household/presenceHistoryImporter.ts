import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { HISTORY_MAX_INTERVAL_BYTES } from '@/src/history/contract'
import { historyIntervals } from '@/src/history/intervals'
import { householdIdSchema, householdSideSchema } from './contract'
import type { PersonHistoryStore } from './personHistory'
import type { PersonHistorySource } from './historySource'

const safeRowId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const cursorSchema = z.object({ afterId: safeRowId, watermark: safeRowId }).strict()
  .refine(value => value.afterId <= value.watermark, 'The source cursor is outside its snapshot.')
const scanSchema = z.object({
  householdId: householdIdSchema, datasetId: householdIdSchema,
  cursor: cursorSchema.optional(), afterId: safeRowId.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().refine(value => value.cursor === undefined || value.afterId === undefined,
  'Continue a snapshot or begin after a checkpoint, not both.')
const sourceSeconds = z.number().int().nonnegative().max(8_640_000_000_000)
const rowSchema = z.object({
  id: safeRowId.min(1), side: householdSideSchema,
  entered: sourceSeconds, left: sourceSeconds, created: sourceSeconds.nullable(),
  duration: z.number().int().nonnegative().max(86_400),
  exits: z.number().int().nonnegative().max(10_000),
  present: z.string().nullable(), absent: z.string().nullable(),
}).strict().refine(row => row.left > row.entered && row.left - row.entered <= 86_400
  && row.duration <= row.left - row.entered, 'The recording interval is incomplete or unsupported.')
interface SourceMetadata { id: number, presentBytes: number, absentBytes: number }
type WithheldReason = 'invalid_recording' | 'incomplete_or_future' | 'source_changed' | 'source_conflict' | 'unassigned' | 'overlapping_presence'
const MAX_PAGE_BYTES = 8 * 1024 * 1024

/** Read completed Pod presence, never estimated sleep or invented vital windows.
 * Each bounded page is a source snapshot. Restarting a scan rechecks older rows;
 * replay is idempotent and changes invalidate private copies instead of moving them. */
export class PresenceHistoryImporter {
  constructor(private readonly biometrics: Database.Database,
    private readonly source: Pick<PersonHistorySource, 'verify'>,
    private readonly history: Pick<PersonHistoryStore, 'admitObservation' | 'rejectSourceObservation' | 'revalidateObservation'>,
    private readonly now = () => Date.now()) {}

  scan(input: unknown) {
    const request = scanSchema.parse(input)
    return this.biometrics.transaction(() => {
      this.source.verify(request.householdId, request.datasetId)
      const maximum = this.biometrics.prepare('SELECT COALESCE(MAX(id), 0) AS watermark FROM sleep_records').get() as { watermark: number }
      const watermark = safeRowId.parse(maximum.watermark)
      // Retention can lower an empty source's maximum. Periodic complete scans
      // still inspect reused IDs; the private store never reassigns their copies.
      const cursor = request.cursor ?? { afterId: Math.min(request.afterId ?? 0, watermark), watermark }
      const candidates = this.biometrics.prepare(`SELECT id,
        COALESCE(length(CAST(present_intervals AS BLOB)), 0) AS presentBytes,
        COALESCE(length(CAST(not_present_intervals AS BLOB)), 0) AS absentBytes
        FROM sleep_records WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`)
        .all(cursor.afterId, cursor.watermark, request.limit + 1) as SourceMetadata[]
      const counts = { scanned: 0, admitted: 0, unchanged: 0, withheld: 0 }
      const withheldReasons: Partial<Record<WithheldReason, number>> = {}
      let bytesRead = 0, afterId = cursor.afterId
      const withhold = (reason: WithheldReason) => {
        counts.withheld++
        withheldReasons[reason] = (withheldReasons[reason] ?? 0) + 1
      }
      for (const metadata of candidates.slice(0, request.limit)) {
        safeRowId.min(1).parse(metadata.id)
        const withinSize = [metadata.presentBytes, metadata.absentBytes].every(size => Number.isSafeInteger(size) && size >= 0 && size <= HISTORY_MAX_INTERVAL_BYTES)
        const totalBytes = withinSize ? metadata.presentBytes + metadata.absentBytes : 0
        // Stop before reading a large page. The unconsumed row is the next page's
        // first candidate, so a byte limit can never silently skip source records.
        if (bytesRead + totalBytes > MAX_PAGE_BYTES) break
        bytesRead += totalBytes
        afterId = metadata.id
        counts.scanned++
        const identity = { householdId: request.householdId, datasetId: request.datasetId,
          sourceRecordKey: `sleep-record:${metadata.id}` }
        const raw = withinSize
          ? this.biometrics.prepare(`SELECT id, side, entered_bed_at AS entered, left_bed_at AS left,
          created_at AS created, sleep_duration_seconds AS duration, times_exited_bed AS exits,
          present_intervals AS present, not_present_intervals AS absent FROM sleep_records WHERE id = ?`).get(metadata.id)
          : null
        const parsed = rowSchema.safeParse(raw)
        const row = parsed.success ? parsed.data : null
        const intervals = row ? historyIntervals(row.present, metadata.presentBytes, row.entered, row.left) : null
        if (!row || !intervals?.intervals || intervals.coveredSeconds === null) {
          this.history.rejectSourceObservation({ ...identity, kind: 'presence' })
          withhold('invalid_recording')
          continue
        }
        const observation = { ...identity,
          sourceFingerprint: createHash('sha256').update(JSON.stringify({ adapter: 'pod-presence-v1', row })).digest('hex'),
          recordedSide: row.side, startsAt: row.entered * 1000, endsAt: row.left * 1000,
          payload: { kind: 'presence', reportedPresenceSeconds: intervals.coveredSeconds,
            exits: row.exits, interpretation: 'bed_presence_not_sleep' } }
        const completed = row.left * 1000 <= this.now() && (row.created === null || row.created * 1000 <= this.now())
        const result = completed ? this.history.admitObservation(observation) : this.history.revalidateObservation(observation)
        if (!result) {
          withhold('incomplete_or_future')
          continue
        }
        if (result.status === 'admitted') counts.admitted++
        else if (result.status === 'unchanged') counts.unchanged++
        else withhold(result.reason)
      }
      return { counts, withheldReasons, watermark: cursor.watermark,
        nextCursor: candidates.length > counts.scanned ? { afterId, watermark: cursor.watermark } : null }
    })()
  }
}
