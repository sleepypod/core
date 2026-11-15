import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { z } from 'zod'
import type { DatasetSnapshot } from '@/src/biometrics/backtest/contracts'
import { rawInspectionSchema } from '@/src/biometrics/backtest/raw-catalog'
import { recordedWaveformContexts } from '@/src/biometrics/backtest/waveform-selection'
import type { retainedWaveformInputSchema } from '@/src/biometrics/backtest/waveform-contracts'

export type Side = 'left' | 'right'
export type RawInspection = z.infer<typeof rawInspectionSchema>
export type RetainedInput = z.infer<typeof retainedWaveformInputSchema>

/** Same pre-roll the pod gives a selected waveform dataset. */
export const PREROLL_MS = 300000
/** The retained input format accepts at most this many RAW files. */
export const MAX_ARTIFACTS = 64
/** A pod HR row and a replayed reading count as the same minute within this. */
export const MATCH_TOLERANCE_MS = 30000

/** Read-only: the archive is never written by replay. */
export function openArchiveDatabase(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  return db
}

/** The local noon-to-noon night a time belongs to: before local noon is the
 * previous evening's night. Same key as the training repo (local time - 12 h)
 * and the pod's whole-night splits. */
export function nightOf(timestampMs: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  const parts = Object.fromEntries(formatter.formatToParts(timestampMs).map(part => [part.type, part.value]))
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)))
  if (Number(parts.hour) < 12) day.setUTCDate(day.getUTCDate() - 1)
  return day.toISOString().slice(0, 10)
}

const parseJson = (value: unknown) => {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value) as unknown
  }
  catch {
    return null
  }
}

export interface ArchiveSession {
  id: number
  startMs: number
  endMs: number
  sleepDurationSeconds: number
  timesExitedBed: number
  presentIntervals: unknown
  notPresentIntervals: unknown
}

interface SleepRecordRow { id: number, entered: number, left: number, duration: number, exits: number, present: unknown, absent: unknown }

/** Group a side's sleep records by the night they were entered (nightOf).
 * The archive keeps rows the pod deleted. */
export function archiveNights(db: Database.Database, side: Side, timezone: string) {
  const rows = db.prepare(`SELECT id, entered_bed_at AS entered, left_bed_at AS left, sleep_duration_seconds AS duration,
    times_exited_bed AS exits, present_intervals AS present, not_present_intervals AS absent
    FROM sleep_records WHERE side = ? AND left_bed_at > entered_bed_at ORDER BY entered_bed_at, id`).all(side) as SleepRecordRow[]
  const nights = new Map<string, ArchiveSession[]>()
  for (const row of rows) {
    // sleep_records stores Unix seconds (Drizzle timestamp mode).
    const session = { id: row.id, startMs: row.entered * 1000, endMs: row.left * 1000, sleepDurationSeconds: row.duration,
      timesExitedBed: row.exits, presentIntervals: parseJson(row.present), notPresentIntervals: parseJson(row.absent) }
    const night = nightOf(session.startMs, timezone)
    nights.set(night, [...nights.get(night) ?? [], session])
  }
  return nights
}

/** The in-bed window of a night's sessions and the occupancy the pod recorded,
 * through the same builder the pod uses for a frozen waveform dataset. */
export function nightWindow(side: Side, sessions: ArchiveSession[]) {
  const startMs = Math.min(...sessions.map(row => row.startMs)), endMs = Math.max(...sessions.map(row => row.endMs))
  const retainedStartMs = Math.max(0, startMs - PREROLL_MS)
  const snapshot: DatasetSnapshot = { version: 'processed-dataset-v1', side, subjectId: 'archive', references: [], processingRuns: [],
    sessions: sessions.map(row => ({ ...row, vitals: [], movement: [] })) }
  return { startMs, endMs, retainedStartMs, contexts: recordedWaveformContexts(snapshot, retainedStartMs, endMs) }
}

export interface RawFile { sha256: string, name: string, mtimeMs: number, path: string }

/** Files worth inspecting for a window. A file's mtime is at or after its last
 * frame, so anything older than the window holds none of it; the first files
 * written after the window ends can still hold its tail. Inspection decides. */
export function rawCandidates<T extends { mtimeMs: number, sha256: string }>(files: T[], window: { retainedStartMs: number, endMs: number }, tail = 2) {
  const sorted = files.filter(file => file.mtimeMs >= window.retainedStartMs - 60000).sort((a, b) => a.mtimeMs - b.mtimeMs || a.sha256.localeCompare(b.sha256))
  const inside = sorted.filter(file => file.mtimeMs < window.endMs)
  return [...inside, ...sorted.slice(inside.length, inside.length + tail)]
}

export function archiveRawFiles(db: Database.Database, archiveDirectory: string): RawFile[] {
  return (db.prepare('SELECT sha256, archive_name AS name, mtime_ms AS mtimeMs FROM archive_raw_files').all() as Array<Omit<RawFile, 'path'>>)
    .map(row => ({ ...row, path: join(archiveDirectory, 'raw', `${row.sha256}.RAW.gz`) }))
}

/** Inspections the pod already recorded for these bytes, if the archive has them. */
export function archivedInspection(db: Database.Database, sha256: string): RawInspection | null {
  const row = db.prepare(`SELECT source_name AS name, descriptor, inventory FROM biometric_raw_sources
    WHERE artifact_hash = ? AND inventory_version = 'retained-raw-inventory-v1' ORDER BY inspected_at_ms DESC LIMIT 1`).get(sha256) as
    { name: string, descriptor: string, inventory: string } | undefined
  if (!row) return null
  const parsed = rawInspectionSchema.safeParse({ source_name: row.name, retained: false, artifact: parseJson(row.descriptor), inventory: parseJson(row.inventory) })
  return parsed.success ? parsed.data : null
}

export interface SelectedArtifacts {
  artifacts: RetainedInput['artifacts']
  excluded: Array<{ sha256: string, reason: 'no_frames_in_window' | 'no_ordered_waveform' | 'uninspectable' }>
}

/** Keep the inspected files with frames in [retainedStart, end), in event order.
 * Overlapping files are refused rather than guessing which frames to drop. */
export function selectArtifacts(inspections: Array<{ sha256: string, inspection: RawInspection | null }>, window: { retainedStartMs: number, endMs: number }): SelectedArtifacts {
  const excluded: SelectedArtifacts['excluded'] = []
  const artifacts: RetainedInput['artifacts'] = []
  for (const { sha256, inspection } of inspections) {
    if (!inspection) {
      excluded.push({ sha256, reason: 'uninspectable' })
      continue
    }
    const { first_event_ms: first, last_event_ms: last } = inspection.inventory
    if (first === null || last === null || last < window.retainedStartMs || first >= window.endMs) {
      excluded.push({ sha256, reason: 'no_frames_in_window' })
      continue
    }
    if (!inspection.inventory.ordered_waveform_available) {
      excluded.push({ sha256, reason: 'no_ordered_waveform' })
      continue
    }
    artifacts.push({ artifact: inspection.artifact, first_event_ms: first, last_event_ms: last })
  }
  artifacts.sort((a, b) => a.first_event_ms - b.first_event_ms || a.artifact.sha256.localeCompare(b.artifact.sha256))
  for (let index = 1; index < artifacts.length; index++) {
    // Bounds may touch, as in the worker.
    if (artifacts[index].first_event_ms < artifacts[index - 1].last_event_ms) {
      throw new Error(`RAW files overlap in time: ${artifacts[index - 1].artifact.sha256} and ${artifacts[index].artifact.sha256}`)
    }
  }
  if (!artifacts.length) throw new Error('No RAW file has frames in the in-bed window')
  if (artifacts.length > MAX_ARTIFACTS) throw new Error(`The night needs ${artifacts.length} RAW files; one replay takes at most ${MAX_ARTIFACTS}`)
  return { artifacts, excluded }
}

export interface Generation {
  generation: number | null
  /** When the numeric components acknowledged it; null for the state before any acknowledgement. */
  effectiveSampleTimeMs: number | null
  resolvedHash: string | null
}

/** Runtime-config generations in effect during [start, end): the one acknowledged
 * last before start, then each acknowledged inside. Same receipts the stage view reads. */
export function nightGenerations(db: Database.Database, side: Side, startMs: number, endMs: number): Generation[] {
  const rows = (db.prepare(`SELECT r.generation AS generation, MAX(r.effective_sample_time_ms) AS atMs, c.resolved_hash AS resolvedHash
    FROM biometric_runtime_receipts r LEFT JOIN biometric_runtime_configs c ON c.side = r.side AND c.generation = r.generation
    WHERE r.side = ? AND r.state = 'applied' AND r.component IN ('heart_rate', 'breathing_rate', 'hrv_index')
    GROUP BY r.generation`).all(side) as Array<{ generation: number, atMs: number | null, resolvedHash: string | null }>)
    .filter((row): row is typeof row & { atMs: number } => row.atMs !== null).sort((a, b) => a.atMs - b.atMs || a.generation - b.generation)
  const before = rows.filter(row => row.atMs <= startMs).at(-1)
  const during = rows.filter(row => row.atMs > startMs && row.atMs < endMs)
  const first: Generation = before
    ? { generation: before.generation, effectiveSampleTimeMs: before.atMs, resolvedHash: before.resolvedHash }
    : { generation: null, effectiveSampleTimeMs: null, resolvedHash: null }
  return [first, ...during.map(row => ({ generation: row.generation, effectiveSampleTimeMs: row.atMs, resolvedHash: row.resolvedHash }))]
}

export interface StoredVital { timestampMs: number, heartRate: number | null }

export function storedVitals(db: Database.Database, side: Side, startMs: number, endMs: number) {
  const rows = db.prepare(`SELECT v.timestamp AS timestamp, v.heart_rate AS heartRate, r.config_hash AS configHash
    FROM vitals v LEFT JOIN biometric_processing_runs r ON r.id = v.processing_run_id
    WHERE v.side = ? AND v.timestamp >= ? AND v.timestamp < ? ORDER BY v.timestamp`)
    .all(side, Math.ceil(startMs / 1000), Math.ceil(endMs / 1000)) as Array<{ timestamp: number, heartRate: number | null, configHash: string | null }>
  const configs = new Map<string | null, number>()
  for (const row of rows) configs.set(row.configHash, (configs.get(row.configHash) ?? 0) + 1)
  return { vitals: rows.map(row => ({ timestampMs: row.timestamp * 1000, heartRate: row.heartRate })),
    // The config hash recorded with each stored row; null is legacy_unknown provenance.
    configHashes: [...configs].map(([configHash, rows]) => ({ configHash, rows })).sort((a, b) => b.rows - a.rows) }
}

/** Per stored minute: the nearest replayed reading within MATCH_TOLERANCE_MS.
 * A minute counts when either side has a heart rate, and matches only when both
 * do and differ by at most toleranceBpm, so abstaining is never agreement.
 * Live writes land every 60-63 s on the arrival clock and replay every 60 s on
 * event time, so matched minutes average different samples; bias, the median
 * and the 1 bpm share separate that scatter from a real shift. */
export function storedParity(stored: StoredVital[], replayed: StoredVital[], toleranceBpm = 0.1) {
  const readings = [...replayed].sort((a, b) => a.timestampMs - b.timestampMs)
  let cursor = 0, compared = 0, within = 0, withinOne = 0, unmatched = 0
  const differences: number[] = []
  const used = new Set<number>()
  for (const row of [...stored].sort((a, b) => a.timestampMs - b.timestampMs)) {
    while (cursor + 1 < readings.length && Math.abs(readings[cursor + 1].timestampMs - row.timestampMs) <= Math.abs(readings[cursor].timestampMs - row.timestampMs)) cursor++
    const nearest = readings[cursor]
    const match = nearest && Math.abs(nearest.timestampMs - row.timestampMs) <= MATCH_TOLERANCE_MS ? nearest : null
    if (!match) unmatched++
    else used.add(cursor)
    const replayedRate = match?.heartRate ?? null
    if (row.heartRate === null && replayedRate === null) continue
    compared++
    if (row.heartRate === null || replayedRate === null) continue
    const difference = replayedRate - row.heartRate
    differences.push(difference)
    if (Math.abs(difference) <= toleranceBpm) within++
    if (Math.abs(difference) <= 1) withinOne++
  }
  const absolute = differences.map(Math.abs).sort((a, b) => a - b)
  const storedRated = stored.filter(row => row.heartRate !== null).length
  return { toleranceBpm, storedRows: stored.length, comparedMinutes: compared, withinMinutes: within, bothHeartRateMinutes: differences.length,
    storedWithoutReplay: unmatched, replayedWithoutStored: readings.filter((row, index) => !used.has(index) && row.heartRate !== null).length,
    share: compared ? within / compared : null, shareWithinOneBpm: compared ? withinOne / compared : null,
    // Replayed heart-rate minutes per stored heart-rate minute: low when replay lacks context the live side had.
    heartRateCoverage: storedRated ? readings.filter(row => row.heartRate !== null).length / storedRated : null,
    meanDifference: differences.length ? differences.reduce((sum, value) => sum + value, 0) / differences.length : null,
    medianAbsDifference: absolute.length ? (absolute[(absolute.length - 1) >> 1] + absolute[absolute.length >> 1]) / 2 : null,
    meanAbsDifference: absolute.length ? absolute.reduce((sum, value) => sum + value, 0) / absolute.length : null, maxAbsDifference: absolute.at(-1) ?? null }
}
