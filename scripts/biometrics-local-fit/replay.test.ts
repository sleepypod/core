// @vitest-environment node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import { retainedWaveformInputSchema } from '@/src/biometrics/backtest/waveform-contracts'
import { defaultConfig, manifestHash, resolveConfig } from '@/src/biometrics/algorithms/registry'
import { openArchiveDatabase as createArchiveDatabase } from '../biometrics-archive/merge'
import { archiveNights, inBedSpans, nightGenerations, nightWindow, planReplayInputs, PREROLL_MS, rawCandidates, selectArtifacts, storedParity, warmRawSpans, type RawInspection } from './archive'
import { runLocalFitCli } from './cli'
import { extractExportRaw } from './export-tar'
import { parityGate, profileFileSchema, readingsFileName, replayArchive, trainingGate } from './replay'

const MINUTE = 60000
const HOUR = 60 * MINUTE
// 2026-10-20T03:00:00Z, which is the evening of 10-19 in Los Angeles.
const T0 = Date.UTC(2026, 9, 20, 3)

let directory: string
let db: Database.Database
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'local-fit-replay-'))
  db = createArchiveDatabase(join(directory, 'biometrics.db'))
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const sleepRecord = (id: number, side: string, startMs: number, endMs: number, present: unknown = null) => db.prepare(`INSERT INTO sleep_records
  (id, side, entered_bed_at, left_bed_at, sleep_duration_seconds, times_exited_bed, present_intervals, not_present_intervals, created_at)
  VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?)`).run(id, side, startMs / 1000, endMs / 1000, (endMs - startMs) / 1000, present === null ? null : JSON.stringify(present), endMs / 1000)

function inspection(sha: string, first: number | null, last: number | null, ordered = true): RawInspection {
  const sha256 = sha.repeat(64).slice(0, 64)
  return { source_name: `${sha}.RAW.gz`, retained: false, artifact: { name: `${sha256}.RAW.gz`, sha256, compressed_bytes: 10, expanded_bytes: 20 },
    inventory: { version: 'retained-raw-inventory-v1', artifact_sha256: sha256, decoded_records: 2, piezo_records: 2, pump_records: 0,
      usable_dual_frames: ordered ? 2 : 0, empty_channel_frames: ordered ? 0 : 2, oversize_channel_frames: 0, invalid_timestamps: 0, timestamp_reversals: 0,
      duplicate_timestamps: 0, first_event_ms: first, last_event_ms: last,
      channels: { left1: { samples: 0, lost_markers: 0, truncated_tail_bytes: 0 }, right1: { samples: 0, lost_markers: 0, truncated_tail_bytes: 0 } },
      ordered_waveform_available: ordered, limitations: [] } }
}

describe('night selection', () => {
  it('keys nights noon to noon in the pod timezone by entered_bed_at and keeps every session of that night', () => {
    sleepRecord(1, 'left', T0, T0 + 3 * HOUR)
    sleepRecord(2, 'left', T0 + 4 * HOUR, T0 + 8 * HOUR) // 07:00 UTC: still the night of 10-19
    sleepRecord(3, 'left', T0 + 24 * HOUR, T0 + 30 * HOUR)
    sleepRecord(4, 'right', T0, T0 + 8 * HOUR)
    sleepRecord(5, 'left', T0 + 48 * HOUR, T0 + 48 * HOUR) // zero length: never a night
    sleepRecord(6, 'left', T0 + 10 * HOUR, T0 + 11 * HOUR) // 13:00 UTC: the night of 10-20
    const utc = archiveNights(db, 'left', 'UTC')
    expect([...utc.keys()]).toEqual(['2026-10-19', '2026-10-20'])
    expect(utc.get('2026-10-19')?.map(row => row.id)).toEqual([1, 2])
    expect(utc.get('2026-10-20')?.map(row => row.id)).toEqual([6, 3])
    // 03:00 UTC on 10-20 is 20:00 on 10-19 in Los Angeles, as is the nap at 06:00 there.
    const local = archiveNights(db, 'left', 'America/Los_Angeles')
    expect([...local.keys()]).toEqual(['2026-10-19', '2026-10-20'])
    expect(local.get('2026-10-19')?.map(row => row.id)).toEqual([1, 2, 6])
    expect(archiveNights(db, 'right', 'UTC').get('2026-10-19')?.map(row => row.id)).toEqual([4])
  })

  it('spans every session of the night with the pod pre-roll and its recorded occupancy', () => {
    sleepRecord(1, 'left', T0, T0 + HOUR, [[T0 / 1000, (T0 + 30 * MINUTE) / 1000]])
    sleepRecord(2, 'left', T0 + 2 * HOUR, T0 + 3 * HOUR)
    const window = nightWindow('left', archiveNights(db, 'left', 'UTC').get('2026-10-19') ?? [])
    expect(window).toMatchObject({ startMs: T0, endMs: T0 + 3 * HOUR, retainedStartMs: T0 - PREROLL_MS })
    expect(window.contexts).toEqual([{ start_ms: T0, end_ms: T0 + 30 * MINUTE, active_sides: null, left_occupied: true, right_occupied: null, pump_context_known: false }])
  })

  it('reports the generation in effect at bed time and each one acknowledged during the night', () => {
    const receipt = db.prepare(`INSERT INTO biometric_runtime_receipts (side, component, generation, applied_hash, effective_sample_time_ms, state, heartbeat_at_ms)
      VALUES ('left', ?, ?, 'h', ?, ?, 0)`)
    const config = db.prepare(`INSERT INTO biometric_runtime_configs (side, generation, resolved_hash, payload, boundary, created_at_ms) VALUES ('left', ?, ?, '{}', 'immediate', 0)`)
    expect(nightGenerations(db, 'left', T0, T0 + 8 * HOUR)).toEqual([{ generation: null, effectiveSampleTimeMs: null, resolvedHash: null }])
    for (const component of ['heart_rate', 'breathing_rate', 'hrv_index']) {
      receipt.run(component, 1, T0 - 2 * HOUR, 'applied')
      receipt.run(component, 2, T0 - HOUR, 'applied')
      receipt.run(component, 3, T0 + 2 * HOUR, 'applied')
      receipt.run(component, 4, T0 + 3 * HOUR, 'failed')
    }
    config.run(2, 'b'.repeat(64))
    expect(nightGenerations(db, 'left', T0, T0 + HOUR)).toEqual([{ generation: 2, effectiveSampleTimeMs: T0 - HOUR, resolvedHash: 'b'.repeat(64) }])
    expect(nightGenerations(db, 'left', T0, T0 + 8 * HOUR).map(row => row.generation)).toEqual([2, 3])
  })
})

describe('RAW selection', () => {
  const window = { retainedStartMs: T0 - PREROLL_MS, endMs: T0 + HOUR }
  it('inspects only files written during the window plus the next two', () => {
    const files = [-20, -4, 10, 40, 59, 75, 90, 120].map(minutes => ({ sha256: String(minutes), mtimeMs: T0 + minutes * MINUTE }))
    expect(rawCandidates(files, window).map(file => file.sha256)).toEqual(['-4', '10', '40', '59', '75', '90'])
    expect(rawCandidates([], window)).toEqual([])
    // A night before the archive's first file: files written weeks later are never candidates.
    expect(rawCandidates([{ sha256: 'later', mtimeMs: T0 + 30 * 24 * HOUR }], window)).toEqual([])
    expect(rawCandidates([{ sha256: 'tail', mtimeMs: T0 + 2 * HOUR }], window).map(file => file.sha256)).toEqual(['tail'])
  })

  it('keeps files with frames in the window in event order and says why the rest were left out', () => {
    const selected = selectArtifacts([
      { sha256: 'b'.repeat(64), inspection: inspection('b', T0 + 20 * MINUTE, T0 + 40 * MINUTE) },
      { sha256: 'a'.repeat(64), inspection: inspection('a', T0 - 10 * MINUTE, T0 + 20 * MINUTE) },
      { sha256: 'c'.repeat(64), inspection: inspection('c', T0 + HOUR, T0 + 2 * HOUR) },
      { sha256: 'd'.repeat(64), inspection: inspection('d', T0 + 40 * MINUTE, T0 + 50 * MINUTE, false) },
      { sha256: 'e'.repeat(64), inspection: null },
      { sha256: 'f'.repeat(64), inspection: inspection('f', T0 - 30 * MINUTE, T0 - 6 * MINUTE) },
    ], window)
    expect(selected.artifacts.map(row => row.artifact.sha256[0])).toEqual(['a', 'b'])
    expect(selected.artifacts[0]).toMatchObject({ first_event_ms: T0 - 10 * MINUTE, last_event_ms: T0 + 20 * MINUTE })
    expect(selected.excluded.map(row => [row.sha256[0], row.reason])).toEqual([['c', 'no_frames_in_window'], ['d', 'no_ordered_waveform'],
      ['e', 'uninspectable'], ['f', 'no_frames_in_window']])
  })

  it('keeps overlapping files for planning and refuses a night with no frames', () => {
    const selected = selectArtifacts([{ sha256: 'b'.repeat(64), inspection: inspection('b', T0 + 10 * MINUTE, T0 + 30 * MINUTE) },
      { sha256: 'a'.repeat(64), inspection: inspection('a', T0, T0 + 20 * MINUTE) }], window)
    expect(selected.artifacts.map(row => row.artifact.sha256[0])).toEqual(['a', 'b'])
    expect(() => selectArtifacts([{ sha256: 'c', inspection: inspection('c', T0 + 2 * HOUR, T0 + 3 * HOUR) }], window)).toThrow('No RAW file')
  })
})

describe('replay inputs for long and overlapping nights', () => {
  const file = (index: number, first: number, last: number) => {
    const sha256 = index.toString(16).padStart(64, '0')
    return { artifact: { name: `${sha256}.RAW.gz`, sha256, compressed_bytes: 1, expanded_bytes: 1 }, first_event_ms: first, last_event_ms: last }
  }
  // 15-minute archives from 10 minutes before bed time, as the pod writes them.
  const archives = (count: number) => Array.from({ length: count }, (_, index) => file(index, T0 + (index * 15 - 10) * MINUTE, T0 + ((index + 1) * 15 - 10) * MINUTE - 1000))
  const night = (count: number) => ({ retainedStartMs: T0 - PREROLL_MS, startMs: T0, endMs: T0 + (count * 15 - 12) * MINUTE,
    contexts: [{ start_ms: T0, end_ms: T0 + (count * 15 - 12) * MINUTE, active_sides: null, left_occupied: true, right_occupied: null, pump_context_known: false }] })

  it('keeps a night of at most 64 files as one input', () => {
    const { inputs, coldRestarts } = planReplayInputs(night(64), archives(64))
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ retained_start_ms: T0 - PREROLL_MS, score_start_ms: T0, score_end_ms: T0 + (64 * 15 - 12) * MINUTE })
    expect(inputs[0].artifacts).toHaveLength(64)
    expect(coldRestarts).toEqual([])
  })

  it('splits a long night into inputs of at most 64 files whose score windows tile the night, each with a full pre-roll', () => {
    const files = archives(90)
    const { inputs } = planReplayInputs(night(90), files)
    expect(inputs.map(input => input.artifacts.length)).toEqual([64, 27])
    for (const input of inputs) expect(() => retainedWaveformInputSchema.parse(input)).not.toThrow()
    expect(inputs[0]).toMatchObject({ score_start_ms: T0, score_end_ms: files[64].first_event_ms })
    // The second input re-reads the file before its first new one for the 5-minute pre-roll.
    expect(inputs[1]).toMatchObject({ retained_start_ms: files[64].first_event_ms - PREROLL_MS, score_start_ms: files[64].first_event_ms,
      score_end_ms: night(90).endMs })
    expect(inputs[1].artifacts[0].artifact.sha256).toBe(files[63].artifact.sha256)
    expect(inputs[1].contexts).toEqual([{ ...night(90).contexts[0], start_ms: files[64].first_event_ms - PREROLL_MS }])
    expect(inputs[0].contexts[0].end_ms).toBe(files[64].first_event_ms)
    // Smaller parts tile the same way.
    const small = planReplayInputs(night(10), archives(10), 3).inputs
    expect(small.map(input => input.artifacts.length)).toEqual([3, 3, 3, 3, 2])
    for (let index = 1; index < small.length; index++) expect(small[index].score_start_ms).toBe(small[index - 1].score_end_ms)
    expect(small.at(-1)?.score_end_ms).toBe(night(10).endMs)
  })

  it('starts a cold segment, scored after its pre-roll, where a file overlaps the one before', () => {
    // Pod 5 archives that start a second before the previous one ends, and a duplicate under a second name.
    const files = archives(6)
    files[3] = { ...files[3], first_event_ms: files[2].last_event_ms - 1000 }
    const duplicate = { ...file(99, files[4].first_event_ms, files[4].last_event_ms) }
    const sorted = [...files.slice(0, 5), duplicate, files[5]].sort((a, b) => a.first_event_ms - b.first_event_ms || a.artifact.sha256.localeCompare(b.artifact.sha256))
    const { inputs, coldRestarts } = planReplayInputs(night(6), sorted)
    expect(coldRestarts).toHaveLength(2)
    expect(coldRestarts[0]).toEqual({ atMs: files[3].first_event_ms, previousSha256: files[2].artifact.sha256, nextSha256: files[3].artifact.sha256, overlapMs: 1000 })
    expect(coldRestarts[1]).toMatchObject({ atMs: files[4].first_event_ms, overlapMs: files[4].last_event_ms - files[4].first_event_ms })
    for (const input of inputs) expect(() => retainedWaveformInputSchema.parse(input)).not.toThrow()
    expect(inputs[0]).toMatchObject({ score_start_ms: T0, score_end_ms: files[3].first_event_ms })
    expect(inputs[1]).toMatchObject({ retained_start_ms: files[3].first_event_ms, score_start_ms: files[3].first_event_ms + PREROLL_MS })
    // No input reads two overlapping files, and nothing is scored before a cold segment's pre-roll.
    for (const input of inputs) {
      for (let index = 1; index < input.artifacts.length; index++) expect(input.artifacts[index].first_event_ms).toBeGreaterThanOrEqual(input.artifacts[index - 1].last_event_ms)
    }
    const spans = warmRawSpans({ retained_start_ms: T0 - PREROLL_MS, artifacts: sorted })
    expect(spans[0]).toEqual({ startMs: T0, endMs: files[2].last_event_ms + 1 })
    expect(spans[1].startMs).toBe(files[3].first_event_ms + PREROLL_MS)
  })

  it('compares only inside the night\'s sleep sessions', () => {
    expect(inBedSpans([{ startMs: 0, endMs: 100 }], [{ startMs: 10, endMs: 40 }, { startMs: 60, endMs: 200 }]))
      .toEqual([{ startMs: 10, endMs: 40 }, { startMs: 60, endMs: 100 }])
  })
})

describe('export archives', () => {
  /** ustar header with the pod's ./raw/ prefix and an explicit entry type. */
  function header(name: string, bytes: number, type: string, mtimeSeconds = 0) {
    const block = Buffer.alloc(512)
    block.write(name, 0, 'ascii')
    block.write('0000644\0', 100, 'ascii')
    block.write(`${bytes.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    block.write(`${mtimeSeconds.toString(8).padStart(11, '0')}\0`, 136, 'ascii')
    block.write('        ', 148, 'ascii')
    block.write(type, 156, 'ascii')
    block.write('ustar  \0', 257, 'ascii')
    let sum = 0
    for (const byte of block) sum += byte
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    return block
  }
  const entry = (name: string, body: Buffer, type = '0', mtime = 0) => [header(name, body.length, type, mtime), body, Buffer.alloc((512 - (body.length % 512)) % 512)]

  it('unpacks raw/*.RAW.gz under their SHA-256 and skips everything else', async () => {
    const first = gzipSync(Buffer.from('first night chunk')), second = gzipSync(Buffer.from('x'.repeat(1500)))
    const tar = Buffer.concat([...entry('./', Buffer.alloc(0), '5'), ...entry('./raw/', Buffer.alloc(0), '5'),
      ...entry('./raw/05D081F4.RAW.gz', first, '0', 1792800000), ...entry('./notes.txt', Buffer.from('not raw')),
      ...entry('raw/05D08E2D.RAW.gz', second, '0', 1792800900), Buffer.alloc(1024)])
    const path = join(directory, 'session.tar.gz')
    writeFileSync(path, gzipSync(tar))
    const files = await extractExportRaw(path, join(directory, 'out'))
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
    expect(files).toEqual([
      { sha256: sha(first), name: '05D081F4.RAW.gz', mtimeMs: 1792800000000, path: join(directory, 'out', `${sha(first)}.RAW.gz`), bytes: first.length },
      { sha256: sha(second), name: '05D08E2D.RAW.gz', mtimeMs: 1792800900000, path: join(directory, 'out', `${sha(second)}.RAW.gz`), bytes: second.length },
    ])
    expect(readFileSync(files[1].path)).toEqual(second)
    // A plain (not gzipped) tar reads the same way.
    writeFileSync(join(directory, 'plain.tar'), tar)
    expect((await extractExportRaw(join(directory, 'plain.tar'), join(directory, 'plain'))).map(file => file.name)).toEqual(['05D081F4.RAW.gz', '05D08E2D.RAW.gz'])
  })

  it('rejects corrupt, truncated and RAW-less archives', async () => {
    const body = gzipSync(Buffer.from('raw'))
    const good = Buffer.concat([...entry('./raw/A.RAW.gz', body), Buffer.alloc(1024)])
    const corrupt = Buffer.from(good)
    corrupt[0] ^= 0xff
    writeFileSync(join(directory, 'corrupt.tar'), corrupt)
    await expect(extractExportRaw(join(directory, 'corrupt.tar'), join(directory, 'c'))).rejects.toThrow('checksum')
    writeFileSync(join(directory, 'short.tar'), good.subarray(0, 700))
    await expect(extractExportRaw(join(directory, 'short.tar'), join(directory, 's'))).rejects.toThrow('Truncated')
    writeFileSync(join(directory, 'empty.tar'), Buffer.concat([...entry('./notes.txt', Buffer.from('n')), Buffer.alloc(1024)]))
    await expect(extractExportRaw(join(directory, 'empty.tar'), join(directory, 'e'))).rejects.toThrow('no raw')
    writeFileSync(join(directory, 'twice.tar'), Buffer.concat([...entry('./raw/A.RAW.gz', body), ...entry('raw/A.RAW.gz', body), Buffer.alloc(1024)]))
    await expect(extractExportRaw(join(directory, 'twice.tar'), join(directory, 't'))).rejects.toThrow('twice')
  })
})

describe('stored-row parity', () => {
  const rows = (rates: Array<number | null>, offsetMs = 0) => rates.map((heartRate, index) => ({ timestampMs: T0 + index * MINUTE + offsetMs, heartRate }))
  it('matches each stored minute to the nearest replayed reading within 30 s', () => {
    const parity = storedParity(rows([60, 61, 62, null, 64, null]), rows([60.05, 61.2, null, 63, 64, null], 20000))
    // Minute 5 has no heart rate on either side and is not compared.
    expect(parity).toMatchObject({ storedRows: 6, comparedMinutes: 5, withinMinutes: 2, bothHeartRateMinutes: 3, storedWithoutReplay: 0, replayedWithoutStored: 0 })
    expect(parity.share).toBeCloseTo(0.4)
    expect(parity.shareWithinOneBpm).toBeCloseTo(0.6)
    expect(parity.heartRateCoverage).toBeCloseTo(4 / 4)
    expect(parity.meanDifference).toBeCloseTo(0.25 / 3)
    expect(parity.medianAbsDifference).toBeCloseTo(0.05)
    expect(parity.meanAbsDifference).toBeCloseTo(0.25 / 3)
    expect(parity.maxAbsDifference).toBeCloseTo(0.2)
    // A shift is bias; scatter around the same level is not.
    expect(storedParity(rows([60, 60, 60, 60]), rows([61, 61, 61, 61]))).toMatchObject({ meanDifference: 1, medianAbsDifference: 1, shareWithinOneBpm: 1, share: 0 })
    expect(storedParity(rows([60, 60, 60, 60]), rows([60.5, 59.5, 60.5, 59.5]))).toMatchObject({ meanDifference: 0, medianAbsDifference: 0.5, shareWithinOneBpm: 1, share: 0 })
  })

  it('counts a stored minute with no reading nearby as a miss and reports readings without rows', () => {
    const parity = storedParity(rows([60, 60]), [{ timestampMs: T0, heartRate: 60 }, { timestampMs: T0 + MINUTE + 31000, heartRate: 60 }, { timestampMs: T0 + 9 * MINUTE, heartRate: 70 }])
    expect(parity).toMatchObject({ comparedMinutes: 2, withinMinutes: 1, storedWithoutReplay: 1, replayedWithoutStored: 2, share: 0.5 })
    expect(storedParity([], rows([60]))).toMatchObject({ comparedMinutes: 0, share: null, meanAbsDifference: null, medianAbsDifference: null, heartRateCoverage: null })
    expect(storedParity(rows([60, 60, 60, 60]), rows([60]))).toMatchObject({ heartRateCoverage: 0.25, storedWithoutReplay: 3 })
  })

  it('gates only nights whose stored rows all came from the replayed config', () => {
    const hash = 'a'.repeat(64), other = 'b'.repeat(64)
    const gate = (share: number | null, configHashes: Array<string | null>, generations = 1) =>
      parityGate(share, { storedConfigHashes: configHashes.map(configHash => ({ configHash })), generations, configHash: hash })
    expect(gate(0.96, [hash])).toBe('pass')
    expect(gate(0.94, [hash])).toBe('fail')
    // Row provenance outranks receipts: two receipted generations but every row ran this config.
    expect(gate(0.96, [hash], 2)).toBe('pass')
    expect(gate(0.96, [other])).toBe('not_gated_different_config')
    expect(gate(0.96, [hash, other])).toBe('not_gated_mixed_configs')
    expect(gate(0.96, [hash, null])).toBe('not_gated_mixed_configs')
    // Legacy rows without provenance fall back to the receipts.
    expect(gate(0.96, [null])).toBe('pass')
    expect(gate(0.5, [null], 2)).toBe('not_gated_mixed_generations')
    expect(gate(null, [hash])).toBe('no_heart_rate_to_compare')
  })

  it('passes a night for training on level, scatter, jumps and coverage, not per-minute 0.1 bpm', () => {
    // Window-phase scatter: alternate minutes 0.4 bpm either side, no bias, full coverage.
    const stored = rows(Array.from({ length: 120 }, () => 60))
    const scattered = rows(Array.from({ length: 120 }, (_, index) => index % 2 ? 60.4 : 59.6))
    const parity = storedParity(stored, scattered)
    expect(parityGate(parity.share, { storedConfigHashes: [{ configHash: null }], generations: 1, configHash: 'a' })).toBe('fail')
    expect(trainingGate(parity, 'fail')).toMatchObject({ trainingGate: 'pass', trainingChecks: { comparedMinutes: { value: 120, pass: true },
      heartRateCoverage: { value: 1, pass: true }, trimmedMeanDifference: { pass: true }, medianAbsDifference: { pass: true },
      matchedShareWithinOneBpm: { value: 1, pass: true }, jumpShare: { value: 0, pass: true } } })
    // A few jumps move the plain mean but not the trimmed one, and pass while rare.
    const jumps = storedParity(stored, rows(Array.from({ length: 120 }, (_, index) => index < 6 ? 90 : index % 2 ? 60.4 : 59.6)))
    expect(jumps.meanDifference).toBeCloseTo(1.5)
    expect(trainingGate(jumps, 'fail')).toMatchObject({ trainingGate: 'pass', trainingChecks: { trimmedMeanDifference: { value: 0, pass: true }, jumpShare: { value: 0.05, pass: true } } })
    expect(trainingGate(storedParity(stored, rows(Array.from({ length: 120 }, (_, index) => index < 15 ? 90 : 60))), 'fail').trainingChecks.jumpShare.pass).toBe(false)
    // A level shift, lost coverage, wide scatter or too few minutes each fail it.
    expect(trainingGate(storedParity(stored, rows(Array.from({ length: 120 }, () => 60.3))), 'fail').trainingChecks.trimmedMeanDifference.pass).toBe(false)
    const sparse = storedParity(stored, rows(Array.from({ length: 120 }, (_, index) => index % 4 ? 60 : null)))
    expect(trainingGate(sparse, 'fail')).toMatchObject({ trainingGate: 'fail', trainingChecks: { heartRateCoverage: { value: 0.75, pass: false } } })
    const wide = storedParity(stored, rows(Array.from({ length: 120 }, (_, index) => index % 2 ? 61.5 : 58.5)))
    expect(trainingGate(wide, 'fail')).toMatchObject({ trainingGate: 'fail', trainingChecks: { medianAbsDifference: { pass: false }, matchedShareWithinOneBpm: { value: 0, pass: false } } })
    expect(trainingGate(storedParity(rows([60, 60]), rows([60, 60])), 'pass')).toMatchObject({ trainingGate: 'fail', trainingChecks: { comparedMinutes: { value: 2, pass: false } } })
    // Nights the parity gate doesn't hold to the replayed config aren't judged either.
    expect(trainingGate(parity, 'not_gated_different_config').trainingGate).toBe('not_gated_different_config')
  })

  it('compares only where replay had RAW and had warmed up', () => {
    const artifact = (first: number, last: number) => ({ artifact: { name: `${'a'.repeat(64)}.RAW.gz`, sha256: 'a'.repeat(64), compressed_bytes: 1, expanded_bytes: 1 },
      first_event_ms: T0 + first * MINUTE, last_event_ms: T0 + last * MINUTE - 1000 })
    const input = { version: 'retained-waveform-input-v1' as const, retained_start_ms: T0 - 5 * MINUTE, score_start_ms: T0, score_end_ms: T0 + 120 * MINUTE,
      artifacts: [artifact(-20, 15), artifact(15, 30), artifact(60, 90)], contexts: [] }
    // The first run starts at the retained start, so it is warm at score start; the second starts cold at 60 min.
    expect(warmRawSpans(input)).toEqual([{ startMs: T0, endMs: T0 + 30 * MINUTE - 999 }, { startMs: T0 + 65 * MINUTE, endMs: T0 + 90 * MINUTE - 999 }])
    const stored = Array.from({ length: 120 }, (_, index) => ({ timestampMs: T0 + index * MINUTE, heartRate: 60 }))
    const parity = storedParity(stored, stored, 0.1, warmRawSpans(input))
    expect(parity).toMatchObject({ storedRows: 30 + 25, outsideRawRows: 65, share: 1, heartRateCoverage: 1 })
  })
})

describe('replay inputs and outputs', () => {
  it('names readings by night and the first 12 hex of the resolved config hash', () => {
    expect(readingsFileName('2026-10-20', 'abcdef0123456789'.repeat(4))).toBe('2026-10-20-abcdef012345.json')
  })

  it('accepts an overrides array, one candidate, or a one-candidate file', () => {
    const overrides = [{ path: 'heart_rate.trackingToleranceBpm', value: 12 }]
    expect(profileFileSchema.parse(overrides)).toEqual(overrides)
    expect(profileFileSchema.parse({ id: 'tol12', overrides })).toEqual(overrides)
    expect(profileFileSchema.parse([{ id: 'tol12', overrides }])).toEqual(overrides)
    expect(() => profileFileSchema.parse([{ id: 'a', overrides }, { id: 'b', overrides }])).toThrow()
  })

  it('checks arguments before opening the archive', async () => {
    await expect(runLocalFitCli(['replay', '--archive', directory, '--side', 'left', '--config', 'defaults', 'out'])).rejects.toThrow('--nights is required')
    await expect(runLocalFitCli(['replay', '--archive', directory, '--nights', '2026-13-01', '--side', 'left', '--config', 'defaults', 'out'])).rejects.toThrow('calendar date')
    await expect(runLocalFitCli(['replay', '--archive', directory, '--nights', 'all', '--side', 'middle', '--config', 'defaults', 'out'])).rejects.toThrow('--side')
    await expect(runLocalFitCli(['replay', '--archive', directory, '--nights', 'all', '--side', 'left', '--config', 'defaults', '--export', 'bad', 'out'])).rejects.toThrow('NIGHT=PATH')
    await expect(runLocalFitCli(['replay', '--archive', directory, '--nights', 'all', '--side', 'left', '--config', 'defaults', '--bogus', 'x', 'out'])).rejects.toThrow('Unknown')
    await expect(runLocalFitCli(['replay', '--archive', directory, '--nights', 'all', '--side', 'left', '--config', 'defaults', '--timezone', 'Mars/Base', 'out'])).rejects.toThrow('IANA')
  })
})

async function replay(args: string[]) {
  const manifest = await runLocalFitCli(args)
  if (!manifest) throw new Error('replay returned no manifest')
  return manifest
}

const python = resolve('modules/piezo-processor/.venv/bin/python')
// Needs the locked piezo-processor venv, which Stryker's sandbox doesn't carry.
describe.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined || !existsSync(python))('replay through the shipped worker', () => {
  /** Synthetic RAW files of a 1.2 Hz waveform, in the cbor framing the pod writes. Each file holds
   * the given [from, to) seconds; by default ten minutes in two files, so the in-bed window from
   * minute 6 to 9 has a full pre-roll of frames. */
  function synthesizeRaw(root: string, startMs: number, files: Array<[number, number]> = [[0, 300], [300, 600]]) {
    mkdirSync(root, { recursive: true })
    execFileSync(python, ['-B', '-c', `
import gzip, json, sys
from pathlib import Path
import cbor2
import numpy as np
root=Path(sys.argv[1]); start=int(sys.argv[2]); files=json.loads(sys.argv[3])
def record(second):
    samples=(np.sin((np.arange(500)+second*500)/500*2*np.pi*1.2)*1000000).astype('<i4').tobytes()
    return {'type':'piezo-dual','ts':start/1000+second,'left1':samples,'right1':bytes(2000)}
for index, (first, last) in enumerate(files):
    group=([{'type':'frzHealth','ts':start/1000,'left':{'pumpRpm':0},'right':{'pumpRpm':0}}] if index == 0 else [])+[record(second) for second in range(first, last)]
    payload=b''.join(cbor2.dumps({'seq':number,'data':cbor2.dumps(item)}) for number,item in enumerate(group))
    (root/(str(index)+'.RAW.gz')).write_bytes(gzip.compress(payload,mtime=0))
`, root, String(startMs), JSON.stringify(files)], { env: { PYTHONPATH: resolve('modules'), LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test' }, timeout: 60000 })
    return files.map(([, last], index) => {
      const bytes = readFileSync(join(root, `${index}.RAW.gz`))
      return { name: `05D${String(index).padStart(2, '0')}.RAW.gz`, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), mtimeMs: startMs + last * 1000 }
    })
  }

  it('replays a night of more files than one worker run takes, and one with overlapping files, in parts', async () => {
    const archive = join(directory, 'archive', 'long')
    mkdirSync(join(archive, 'raw'), { recursive: true })
    const archiveDb = createArchiveDatabase(join(archive, 'biometrics.db'))
    // Eight files of 2.5 minutes; the sixth starts two seconds before the fifth ends.
    const ranges = Array.from({ length: 8 }, (_, index): [number, number] => [index === 5 ? 748 : index * 150, (index + 1) * 150])
    for (const file of synthesizeRaw(join(directory, 'synth-long'), T0, ranges)) {
      writeFileSync(join(archive, 'raw', `${file.sha256}.RAW.gz`), file.bytes)
      archiveDb.prepare(`INSERT INTO archive_raw_files (sha256, name, archive_name, mtime_ms, bytes, pull_key) VALUES (?, ?, ?, ?, ?, 'p')`)
        .run(file.sha256, file.name, file.name, file.mtimeMs, file.bytes.length)
    }
    archiveDb.prepare(`INSERT INTO sleep_records (id, side, entered_bed_at, left_bed_at, sleep_duration_seconds, times_exited_bed, present_intervals, created_at)
      VALUES (1, 'left', ?, ?, 780, 0, ?, 0)`).run((T0 + 360000) / 1000, (T0 + 1140000) / 1000, JSON.stringify([[(T0 + 360000) / 1000, (T0 + 1140000) / 1000]]))
    archiveDb.close()
    const manifest = await replayArchive({ archiveDirectory: archive, nights: ['2026-10-19'], side: 'left', config: { source: 'defaults', overrides: [] },
      outputDirectory: join(directory, 'long-out'), timezone: 'UTC', jobs: 2, maxArtifacts: 4 })
    const night = manifest.nights[0]
    expect(night.raw).toHaveLength(8)
    expect(night.coldRestarts).toEqual([expect.objectContaining({ atMs: T0 + 748000, overlapMs: 1000 })])
    expect(night.inputs.length).toBeGreaterThan(2)
    // Score windows tile the night up to the overlap, then resume after a cold pre-roll.
    expect(night.inputs.every(input => input.raw <= 4)).toBe(true)
    for (let index = 1; index < night.inputs.length; index++) {
      const previous = night.inputs[index - 1], input = night.inputs[index]
      if (input.scoreStartMs !== previous.scoreEndMs) expect([previous.scoreEndMs, input.scoreStartMs]).toEqual([T0 + 748000, T0 + 748000 + PREROLL_MS])
    }
    expect(night.inputs[0].scoreStartMs).toBe(T0 + 360000)
    expect(night.inputs.at(-1)?.scoreEndMs).toBe(T0 + 1140000)
    const saved = JSON.parse(readFileSync(join(directory, 'long-out', night.readingsFile), 'utf8')) as { readings: Array<{ side: string, timestampMs: number }> }
    const left = saved.readings.filter(row => row.side === 'left').map(row => row.timestampMs)
    expect(left.length).toBeGreaterThan(0)
    expect(new Set(left).size).toBe(left.length)
    expect(left.every((time, index) => index === 0 || time > left[index - 1])).toBe(true)
    expect(left.every(time => time >= T0 + 360000 && time < T0 + 1140000 && (time < T0 + 748000 || time >= T0 + 748000 + PREROLL_MS))).toBe(true)
    expect(night.run?.counts.scored_outputs).toBe(saved.readings.length)
  }, 180000)

  it('replays an archived night and a pre-archive export night with one pinned profile, then checks stored-row parity', async () => {
    const archive = join(directory, 'archive', 'abc123')
    mkdirSync(join(archive, 'raw'), { recursive: true })
    const archiveDb = createArchiveDatabase(join(archive, 'biometrics.db'))
    const night = T0, exportNight = T0 + 24 * HOUR
    for (const file of synthesizeRaw(join(directory, 'synth-a'), night)) {
      writeFileSync(join(archive, 'raw', `${file.sha256}.RAW.gz`), file.bytes)
      archiveDb.prepare(`INSERT INTO archive_raw_files (sha256, name, archive_name, mtime_ms, bytes, pull_key) VALUES (?, ?, ?, ?, ?, 'p')`)
        .run(file.sha256, file.name, file.name, file.mtimeMs, file.bytes.length)
    }
    // The export night's RAW lives only in a GET /api/export/archive tarball.
    const exported = synthesizeRaw(join(directory, 'synth-b'), exportNight)
    const tarHeader = (name: string, bytes: number, mtimeMs: number) => {
      const block = Buffer.alloc(512)
      block.write(name, 0, 'ascii')
      block.write(`${bytes.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
      block.write(`${Math.floor(mtimeMs / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii')
      block.write('        ', 148, 'ascii')
      block.write('0', 156, 'ascii')
      block.write('ustar\u000000', 257, 'ascii')
      let sum = 0
      for (const byte of block) sum += byte
      block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
      return block
    }
    const tarPath = join(directory, 'session-9.tar.gz')
    writeFileSync(tarPath, gzipSync(Buffer.concat([...exported.flatMap(file => [tarHeader(`./raw/${file.name}`, file.bytes.length, file.mtimeMs), file.bytes,
      Buffer.alloc((512 - (file.bytes.length % 512)) % 512)]), Buffer.alloc(1024)])))
    for (const [id, start] of [[1, night], [2, exportNight]]) {
      archiveDb.prepare(`INSERT INTO sleep_records (id, side, entered_bed_at, left_bed_at, sleep_duration_seconds, times_exited_bed, present_intervals, created_at)
        VALUES (?, 'left', ?, ?, 180, 0, ?, 0)`).run(id, (start + 360000) / 1000, (start + 540000) / 1000, JSON.stringify([[(start + 360000) / 1000, (start + 540000) / 1000]]))
    }
    archiveDb.close()
    const output = join(directory, 'out')
    const profile = join(directory, 'profile.json')
    const overrides = [{ path: 'heart_rate.trackingToleranceBpm', value: 12 }]
    writeFileSync(profile, JSON.stringify({ id: 'tol12', overrides }))
    const args = ['replay', '--archive', archive, '--nights', '2026-10-19', '--side', 'left', '--config', profile, '--timezone', 'UTC',
      '--export', `2026-10-20=${tarPath}`, '--jobs', '2', output]
    const manifest = await replay(args)
    const hash = resolveConfig(overrides as never).hash
    expect(manifest).toMatchObject({ version: 'biometrics-local-fit-replay-v1', label: 'exploratory-local', side: 'left', timezone: 'UTC',
      archive: { podId: 'abc123', databaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/), cursorEndMs: null },
      engine: { manifestHash }, config: { source: profile, overrides, configHash: hash }, otherSideConfigHash: configHash(defaultConfig),
      pythonBuild: { hash: expect.stringMatching(/^[a-f0-9]{64}$/) }, skipped: [] })
    expect(manifest.nights.map(row => [row.night, row.source, row.raw.length])).toEqual([['2026-10-19', 'archive', 2], ['2026-10-20', 'export', 2]])
    expect(manifest.nights[1].raw.map(row => [row.name, row.sha256])).toEqual(exported.map(file => [file.name, file.sha256]))
    expect(manifest.nights[0]).toMatchObject({ sessionIds: [1], scoreStartMs: night + 360000, scoreEndMs: night + 540000, retainedStartMs: night + 360000 - PREROLL_MS,
      contexts: 1, generations: [{ generation: null, matchesReplayedConfig: false }], readingsFile: `readings/2026-10-19-${hash.slice(0, 12)}.json` })
    expect(manifest).not.toHaveProperty('parity')
    const saved = JSON.parse(readFileSync(join(output, manifest.nights[0].readingsFile), 'utf8'))
    expect(saved).toMatchObject({ cohortId: '2026-10-19', configHash: hash, side: 'left' })
    expect(saved.readings.length).toBe(manifest.nights[0].readings)
    expect(saved.readings.length).toBeGreaterThan(0)
    expect(existsSync(join(output, 'work'))).toBe(false)
    expect(existsSync(join(output, 'inspections', `${manifest.nights[0].raw[0].sha256}.json`))).toBe(true)

    // Store the replayed rows as if the pod had written them: parity passes; one changed minute fails the gate.
    const store = createArchiveDatabase(join(archive, 'biometrics.db'))
    const insert = store.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (\'left\', ?, ?)')
    const rated = (saved.readings as Array<{ timestampMs: number, heartRate: number | null }>).filter(row => row.heartRate !== null)
    expect(rated.length).toBeGreaterThan(0)
    for (const row of rated) insert.run(Math.round(row.timestampMs / 1000), row.heartRate)
    store.close()
    const checked = await replay([...args.slice(0, 4), '2026-10-19', ...args.slice(5, 11), '--compare-stored', output])
    expect(checked.nights[0].parity).toMatchObject({ gate: 'pass', share: 1, comparedMinutes: rated.length, outsideRawRows: 0,
      comparedSpans: [{ startMs: night + 360000, endMs: night + 540000 }] })
    expect(checked.parity).toMatchObject({ toleranceBpm: 0.1, minimumShare: 0.95, gatedNights: 1, failedNights: [], passed: true,
      // Three synthetic minutes are too few to train on, whatever their agreement.
      training: { minimumComparedMinutes: 60, passedNights: [], failedNights: ['2026-10-19'] } })
    expect(checked.nights[0].parity).toMatchObject({ trainingGate: 'fail', trainingChecks: { comparedMinutes: { pass: false }, trimmedMeanDifference: { value: 0, pass: true } } })
    const changed = createArchiveDatabase(join(archive, 'biometrics.db'))
    changed.prepare('UPDATE vitals SET heart_rate = heart_rate + 1').run()
    changed.close()
    process.exitCode = undefined
    const failed = await replay([...args.slice(0, 4), '2026-10-19', ...args.slice(5, 11), '--compare-stored', output])
    expect(failed.parity).toMatchObject({ failedNights: ['2026-10-19'], passed: false })
    expect(process.exitCode).toBe(2)
    process.exitCode = undefined
    // A night with no sleep record is refused by name, never silently dropped.
    await expect(runLocalFitCli([...args.slice(0, 4), '2026-10-25', ...args.slice(5, 11), output])).rejects.toThrow('2026-10-25: no left sleep record')
    renameSync(join(archive, 'raw'), join(archive, 'raw-gone'))
    const all = await replay([...args.slice(0, 4), 'all', ...args.slice(5, 11), output])
    expect(all.skipped).toEqual(['2026-10-19', '2026-10-20'].map(night => ({ night, reason: 'the archive holds no RAW file written during the night' })))
    expect(all.nights).toEqual([])
  }, 120000)
})
