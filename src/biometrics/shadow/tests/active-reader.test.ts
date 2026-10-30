// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, renameSync, copyFileSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { biometricManifest, defaultConfig, manifestHash } from '../../algorithms/registry'
import { configHash } from '../../algorithms/canonical'
import { plannedShadowSourceFactory } from '../planned-sources'
import { shadowPlanSchema } from '../store'
import { openShadowActiveDatabase, openShadowStateDatabase } from '../active-database'
import { openShadowLiveSources } from '../live-sources'
import { publishProspectiveFrame } from '../../../streaming/prospectiveFrameTap'
import { ShadowActiveReader } from '../active-reader'
import { ShadowStore } from '../store'
import { ShadowStreamJoin } from '../stream-join'
const start = 1700000000000, hash = configHash(defaultConfig)
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.useRealTimers()
})
function setup(maximumRows = 10) {
  const directory = mkdtempSync(join(tmpdir(), 'shadow-active-')), path = join(directory, 'biometrics.db')
  const writer = new Database(path)
  writer.pragma('journal_mode = WAL')
  migrate(drizzle(writer), { migrationsFolder: fileURLToPath(new URL('../../../db/biometrics-migrations/', import.meta.url)) })
  const readonly = new Database(path, { readonly: true, fileMustExist: true })
  cleanups.push(() => {
    readonly.close()
    writer.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const runId = randomUUID()
  const bundle = { schemaVersion: 1, manifestHash, resolved: defaultConfig, generation: 0, revisionId: null,
    components: biometricManifest.components, sourceHashes: biometricManifest.sourceHashes }
  writer.prepare('INSERT INTO biometric_processing_runs (id, side, kind, bundle, config_hash, calibration_hash, input_identity, started_at_ms) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
    .run(runId, 'left', 'live', JSON.stringify(bundle), hash, JSON.stringify({ sourceSide: 'right', timestampBasis: 'firmware_event_time_v1', rawIdentity: 'not_retained', sensorCalibration: 'not_consumed', mechanicalContext: 'mechanical-context-v1' }), start)
  const options = { side: 'left', startMs: start, endMs: start + 10000, activeConfigHash: hash, maximumRows }
  let now = start
  const reader = () => new ShadowActiveReader(readonly, options, () => now)
  const insert = (seconds = 0, side = 'left', provenance: string | null = runId) => {
    const id = Number(writer.prepare('INSERT INTO vitals (side,timestamp,heart_rate,hrv,breathing_rate,processing_run_id) VALUES (?,?,60,NULL,12,?)').run(side, start / 1000 + seconds, provenance).lastInsertRowid)
    writer.prepare('INSERT INTO vitals_quality (vitals_id,side,timestamp,quality_score,created_at,flags) VALUES (?,?,?,0.9,?,?)').run(id, side, start / 1000 + seconds, start / 1000 + seconds, JSON.stringify([`mechanical_context_v1:${runId}:${runId}:${start + seconds * 1000 - 61000}:${start + seconds * 1000 + 1000}`]))
    return id
  }
  return { writer, readonly, path, runId, bundle, options, reader, insert, advance: (milliseconds: number) => {
    now += milliseconds
  } }
}
it('captures only newly inserted rows with original values, quality and verified live provenance', () => {
  const { reader, insert, advance, runId } = setup()
  insert()
  const capture = reader()
  expect(capture.poll()).toEqual([])
  advance(1000)
  insert(1)
  const rows = capture.poll()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ timestampMs: start + 1000, configHash: hash, inputHash: null,
    provenance: { processingRunId: runId, sourceSide: 'right', generation: 0, manifestHash, timestampBasis: 'firmware_event_time_v1' },
    readings: [{ metric: 'heart_rate', value: 60, quality: 0.9 }, { metric: 'breathing_rate', value: 12 }, { metric: 'window_ibi_variability_v1', value: null, windowMs: 300000 }] })
  expect(capture.poll()).toEqual([])
})
it('requires read-only access and never writes through the capture connection', () => {
  const { writer, readonly, options, reader, insert } = setup()
  expect(() => new ShadowActiveReader(writer, options)).toThrow(/read-only/)
  const capture = reader()
  insert()
  expect(capture.poll()).toHaveLength(1)
  expect(() => readonly.prepare('DELETE FROM vitals').run()).toThrow(/readonly/)
})
it('withholds legacy processing-clock rows from firmware-time comparisons', () => {
  const { writer, reader, insert } = setup()
  writer.prepare('UPDATE biometric_processing_runs SET input_identity=?').run(JSON.stringify({
    sourceSide: 'right', timestampBasis: 'processing_clock', rawIdentity: 'not_retained', sensorCalibration: 'not_consumed',
  }))
  const capture = reader()
  insert()
  expect(() => capture.poll()).toThrow()
  expect(() => capture.poll()).toThrow() // A failed batch must not advance past the mismatch.
})
it('advances past other-side and out-of-window inserts without labelling them active', () => {
  const { reader, insert } = setup()
  const capture = reader()
  insert(0, 'right')
  insert(-1)
  expect(capture.poll()).toEqual([])
  insert()
  expect(capture.poll()).toHaveLength(1)
})
it('refuses a batch above the poll quota without silently taking a prefix', () => {
  const { reader, insert, advance } = setup(1)
  const capture = reader()
  insert()
  advance(1000)
  insert(1)
  expect(() => capture.poll()).toThrow(/quota/)
  expect(() => capture.poll()).toThrow(/quota/)
})
it.each(['legacy', 'quality_missing', 'quality_duplicate', 'quality_side', 'quality_timestamp', 'quality_invalid', 'config', 'bundle', 'kind', 'source', 'future'])('fails closed for %s evidence', (mode) => {
  const { reader, insert, writer, runId } = setup()
  const capture = reader()
  const id = insert(mode === 'future' ? 1 : 0, 'left', mode === 'legacy' ? null : runId)
  if (mode === 'quality_missing') writer.prepare('DELETE FROM vitals_quality').run()
  if (mode === 'quality_duplicate') writer.prepare('INSERT INTO vitals_quality (vitals_id,side,timestamp,quality_score,created_at) SELECT vitals_id,side,timestamp,quality_score,created_at FROM vitals_quality').run()
  if (mode === 'quality_side') writer.prepare('UPDATE vitals_quality SET side=\'right\' WHERE vitals_id=?').run(id)
  if (mode === 'quality_timestamp') writer.prepare('UPDATE vitals_quality SET timestamp=timestamp+1').run()
  if (mode === 'quality_invalid') writer.prepare('UPDATE vitals_quality SET quality_score=2').run()
  if (mode === 'config') writer.prepare('UPDATE biometric_processing_runs SET config_hash=?').run('b'.repeat(64))
  if (mode === 'bundle') writer.prepare('UPDATE biometric_processing_runs SET bundle=?').run('x'.repeat(65537))
  if (mode === 'kind') writer.prepare('UPDATE biometric_processing_runs SET kind=\'replay\'').run()
  if (mode === 'source') writer.prepare('UPDATE biometric_processing_runs SET input_identity=?').run('{}')
  expect(() => capture.poll()).toThrow()
  expect(() => capture.poll()).toThrow()
})
it('detects deletion or replacement of its cursor instead of resuming through a reset', () => {
  const { reader, insert, writer } = setup()
  insert()
  const capture = reader()
  writer.prepare('UPDATE vitals SET heart_rate=99').run()
  expect(() => capture.poll()).toThrow(/cursor changed/)
  writer.prepare('DELETE FROM vitals').run()
  expect(() => capture.poll()).toThrow(/cursor changed/)
})
it('retains active run provenance when the stream join persists an active-only point', () => {
  const { reader, insert, writer, runId } = setup()
  const capture = reader()
  const store = new ShadowStore(writer, { maximumRuns: 10, maximumPoints: 10, maximumBytes: 100000 }, () => start)
  const run = store.create({ schema: 'biometric-shadow-plan-v1', subjectId: 'test', side: 'left', candidateConfigHash: hash, activeConfigHash: hash,
    qualificationHash: hash, engineBuildHash: hash, startMs: start, endMs: start + 1000, maximumPoints: 10, maximumBytes: 10000, metrics: ['heart_rate'],
    joining: { maximumPendingPoints: 10, maximumLatenessMs: 1, drainGraceMs: 100 }, monitoring: { expectedIntervalMs: 1000, maximumGapMs: 1000, heartbeatStaleMs: 1000,
      minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8, alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } } }, 'test')
  const lease = store.claim(run.id, 1000, () => {})
  const stream = new ShadowStreamJoin(store, lease)
  insert()
  stream.active(capture.poll()[0])
  stream.advance(start + 1)
  expect(store.snapshot(run.id, { maximumPoints: 10, maximumBytes: 10000 }).samples[0]).toMatchObject({
    inputHash: null, inputIdentityKind: 'unavailable', activeProvenance: { processingRunId: runId, sourceSide: 'right', timestampBasis: 'firmware_event_time_v1' }, pairing: { activePresent: true, candidatePresent: false } })
})
it.each(['manifestHash', 'components', 'sourceHashes', 'resolved'])('rejects substituted %s in a live run bundle', (field) => {
  const { reader, insert, writer, bundle } = setup()
  const capture = reader()
  insert()
  writer.prepare('UPDATE biometric_processing_runs SET bundle=?').run(JSON.stringify({ ...bundle, [field]: field === 'manifestHash' ? 'a'.repeat(64) : {} }))
  expect(() => capture.poll()).toThrow()
  writer.prepare('UPDATE biometric_processing_runs SET bundle=?').run(JSON.stringify(bundle))
  // Failed validation did not advance the cursor or hide this observation.
  expect(capture.poll()).toHaveLength(1)
})
function liveSetup() {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  const fixture = setup()
  const controller = new AbortController(), active = vi.fn(), fail = vi.fn(), databaseCurrent = vi.fn()
  const options = { db: fixture.readonly, side: 'left' as const, startMs: start, endMs: start + 10000, activeConfigHash: hash,
    maximumActiveRows: 10, maximumLatenessMs: 100, pollMs: 50,
    frameBudgets: { maximumFrames: 2, maximumBytes: 10000, maximumEventAgeMs: 1000, maximumFutureSkewMs: 0 },
    context: () => ({ activeSides: ['left'], leftOccupied: true, rightOccupied: false, pumpContextKnown: false }),
    assertDatabaseCurrent: databaseCurrent, signal: controller.signal, active, fail }
  const open = () => {
    const source = openShadowLiveSources(options)
    // Close subscribers before the owning database connections in afterEach.
    cleanups.unshift(source.close)
    return source
  }
  return { ...fixture, controller, active, fail, databaseCurrent, options, open }
}
it('composes real waveform capture and read-only active polling with an explicit final flush', async () => {
  const { insert, open, active, fail } = liveSetup()
  insert()
  const source = open(), frames = source.frames[Symbol.asyncIterator]()
  const frame = frames.next()
  publishProspectiveFrame({ type: 'piezo-dual', ts: start / 1000, freq: 500, left1: [1, 2], right1: [3, 4] }, false, start)
  expect((await frame).value).toMatchObject({ observedAtMs: start, context: { activeSides: ['left'] } })
  expect(active).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  insert(1)
  source.flush?.()
  expect(active).toHaveBeenCalledOnce()
  expect(active.mock.calls[0][0]).toMatchObject({ timestampMs: start + 1000 })
  await vi.advanceTimersByTimeAsync(50)
  expect(active).toHaveBeenCalledOnce()
  expect(fail).not.toHaveBeenCalled()
})
it('keeps active polling available during final drain after waveform collection ends', async () => {
  const { insert, open, active, fail } = liveSetup()
  const source = open(), frames = source.frames[Symbol.asyncIterator]()
  const done = frames.next()
  await vi.advanceTimersByTimeAsync(10000)
  expect((await done).done).toBe(true)
  insert(9)
  source.flush?.()
  expect(active.mock.calls[0][0]).toMatchObject({ timestampMs: start + 9000 })
  expect(fail).not.toHaveBeenCalled()
})
it('closes both captures on a database identity failure without delivering old-connection data', async () => {
  const { insert, open, active, fail, databaseCurrent } = liveSetup()
  const source = open(), frames = source.frames[Symbol.asyncIterator]()
  const pending = frames.next()
  insert()
  databaseCurrent.mockImplementation(() => {
    throw new Error('database inode changed')
  })
  await vi.advanceTimersByTimeAsync(50)
  expect((await pending).done).toBe(true)
  expect(active).not.toHaveBeenCalled()
  expect(fail).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it('clears polling and subscriptions on abort and refuses asynchronous delivery', async () => {
  const fixture = liveSetup()
  const source = fixture.open()
  fixture.controller.abort()
  expect(vi.getTimerCount()).toBe(0)
  expect(() => source.flush?.()).toThrow(/closed/)
  expect(fixture.fail).not.toHaveBeenCalled()
  const next = liveSetup()
  next.active.mockImplementation(async () => {})
  next.open()
  next.insert()
  await vi.advanceTimersByTimeAsync(50)
  expect(next.fail).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it('opens a bounded read-only active connection and detects path replacement', () => {
  const { path } = setup()
  const connection = openShadowActiveDatabase(path, { busyTimeoutMs: 50 })
  cleanups.unshift(connection.close)
  expect(connection.db.readonly).toBe(true)
  expect(connection.db.pragma('busy_timeout', { simple: true })).toBe(50)
  connection.assertCurrent()
  renameSync(path, path + '.old')
  copyFileSync(path + '.old', path)
  expect(() => connection.assertCurrent()).toThrow(/replaced/)
  connection.close()
  expect(() => connection.assertCurrent()).toThrow(/closed/)
})
it('refuses missing files, symlinks and unbounded busy timeouts', () => {
  const { path } = setup()
  expect(() => openShadowActiveDatabase(path + '.missing', { busyTimeoutMs: 50 })).toThrow()
  symlinkSync(path, path + '.link')
  expect(() => openShadowActiveDatabase(path + '.link', { busyTimeoutMs: 50 })).toThrow(/regular file/)
  expect(() => openShadowActiveDatabase(path, { busyTimeoutMs: 1001 })).toThrow()
})
it('rechecks database identity after the snapshot and before active delivery', async () => {
  const { insert, open, active, fail, databaseCurrent } = liveSetup()
  databaseCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementation(() => {
    throw new Error('database replaced during snapshot')
  })
  open()
  insert()
  await vi.advanceTimersByTimeAsync(50)
  expect(active).not.toHaveBeenCalled()
  expect(fail).toHaveBeenCalledOnce()
})
function plannedSetup() {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  const fixture = setup()
  const configPath = join(dirname(fixture.path), 'configuration.db'), presencePath = join(dirname(fixture.path), 'presence.json')
  const config = new Database(configPath)
  config.exec('CREATE TABLE side_settings(side TEXT, away_mode INTEGER); INSERT INTO side_settings VALUES(\'left\',0),(\'right\',1); CREATE TABLE device_settings(id INTEGER, bed_mode TEXT); INSERT INTO device_settings VALUES(1,\'two\');')
  cleanups.unshift(() => config.close())
  writeFileSync(presencePath, JSON.stringify({ version: 1, left: { vitals_presence: true, vitals_evidence_ts: start / 1000 } }))
  utimesSync(presencePath, start / 1000, start / 1000)
  const plan = shadowPlanSchema.parse({ schema: 'biometric-shadow-plan-v1', subjectId: 'test', side: 'left', startMs: start, endMs: start + 10000,
    candidateConfigHash: hash, activeConfigHash: hash, qualificationHash: hash, engineBuildHash: hash, maximumPoints: 100, maximumBytes: 100000, metrics: ['heart_rate'],
    joining: { maximumPendingPoints: 10, maximumLatenessMs: 100, drainGraceMs: 500 },
    monitoring: { expectedIntervalMs: 1000, maximumGapMs: 1000, heartbeatStaleMs: 1000, minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8,
      alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } },
    execution: { version: 'shadow-execution-policy-v1', configHashes: { left: hash, right: hash },
      maximumRecords: 10, maximumOutputs: 10, maximumCpuMs: 1000, maximumInputBytes: 100000, maximumOutputBytes: 100000,
      budgets: { cpuSeconds: 2, addressSpaceBytes: 100000000, maximumRssBytes: 100000000, wallMs: 15000, acknowledgmentMs: 1000, idleMs: 1000, rssIntervalMs: 100, rssTimeoutMs: 100 },
      leaseMs: 1500, heartbeatMs: 200, sources: { pollMs: 50, maximumActiveRows: 10, databaseBusyTimeoutMs: 50,
        frames: { maximumFrames: 1, maximumBytes: 10000, maximumEventAgeMs: 1000, maximumFutureSkewMs: 0 },
        context: { presenceStaleMs: 300000, pumpStaleMs: 1000, maximumPresenceBytes: 4096 } } } })
  const paths = { biometricsDatabase: fixture.path, configurationDatabase: configPath, presenceFile: presencePath }
  const abort = new AbortController(), active = vi.fn(), fail = vi.fn()
  const execution = plan.execution
  if (!execution) throw new Error('Fixture execution missing')
  const input = { execution, collectionEndsAtMs: plan.endMs, signal: abort.signal, active, fail }
  const factory = plannedShadowSourceFactory(plan, paths)
  const open = () => {
    const source = factory(input)
    cleanups.unshift(source.close)
    return source
  }
  return { ...fixture, paths, plan, input, factory, open, abort, active, fail }
}
it('applies the saved context and capture policy to real connections and subscriptions', async () => {
  const { open, insert, active, fail } = plannedSetup()
  const source = open(), frames = source.frames[Symbol.asyncIterator]()
  const next = frames.next()
  publishProspectiveFrame({ type: 'piezo-dual', ts: start / 1000, freq: 500, left1: [1], right1: [2] }, false, start)
  expect((await next).value.context).toEqual({ activeSides: ['left'], leftOccupied: true, rightOccupied: null, pumpContextKnown: false, mechanical: null })
  insert()
  source.flush?.()
  expect(active).toHaveBeenCalledOnce()
  expect(fail).not.toHaveBeenCalled()
})
it('refuses changed source policies before opening resources', () => {
  const { factory, input } = plannedSetup()
  const changed = structuredClone(input.execution)
  changed.sources.frames.maximumFrames++
  expect(() => factory({ ...input, execution: changed })).toThrow(/saved plan/)
  expect(vi.getTimerCount()).toBe(0)
})
it('closes both owned read-only handles on abort exactly once', () => {
  const { open, abort } = plannedSetup()
  const close = vi.spyOn(Database.prototype, 'close')
  const source = open()
  abort.abort()
  expect(close).toHaveBeenCalledTimes(2)
  source.close()
  expect(close).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
  close.mockRestore()
})
it('unwinds the first connection if the second database cannot open', () => {
  const { plan, paths, input } = plannedSetup()
  const factory = plannedShadowSourceFactory(plan, { ...paths, configurationDatabase: paths.configurationDatabase + '.missing' })
  const close = vi.spyOn(Database.prototype, 'close')
  expect(() => factory(input)).toThrow()
  expect(close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  close.mockRestore()
})
it('enforces the saved frame count and releases owned resources on overflow', () => {
  const { open, fail } = plannedSetup()
  open()
  const frame = { type: 'piezo-dual', ts: start / 1000, freq: 500, left1: [1], right1: [2] }
  const close = vi.spyOn(Database.prototype, 'close')
  publishProspectiveFrame(frame, false, start)
  publishProspectiveFrame(frame, false, start)
  expect(fail).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
  close.mockRestore()
})

it('opens owned shadow state writable while keeping active capture read-only and detecting replacement', () => {
  const { path, readonly } = setup()
  const state = openShadowStateDatabase(path, { busyTimeoutMs: 50 })
  try {
    expect(state.db.readonly).toBe(false)
    state.db.exec('CREATE TABLE shadow_connection_test (value INTEGER)')
    state.db.prepare('INSERT INTO shadow_connection_test VALUES (1)').run()
    expect(() => readonly.prepare('INSERT INTO shadow_connection_test VALUES (2)').run()).toThrow(/readonly/)
    state.assertCurrent()
    renameSync(path, path + '.moved')
    expect(state.assertCurrent).toThrow()
  }
  finally { state.close() }
})
