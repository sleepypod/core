// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { ReportArtifactStore } from '../artifacts'
import { DatasetStore } from '../datasets'
import { BacktestJobStore } from '../jobs'
import { freezeWaveformDataset } from './fixtures/waveform'
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let store: BacktestJobStore
let datasets: DatasetStore
let now: number
let datasetId: string
let experimentId: string
const config = { label: 'default' as const, revisionId: null, resolved: defaultConfig, resolvedHash: configHash(defaultConfig), manifestHash }
const protocol = { version: 'descriptive-evaluation-v1' as const, mode: 'stage_replay' as const, assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 }
const enqueue = (idempotencyKey = 'job-1', split: 'tuning' | 'validation' | 'holdout' = 'tuning') => store.enqueue({ experimentId, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey, split, configs: [config] })
const lease = (job: NonNullable<ReturnType<BacktestJobStore['claim']>>) => ({ id: job.id, owner: job.leaseOwner as string, token: job.fencingToken })
beforeEach(() => {
  now = 1791673200000
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  for (let id = 1; id <= 3; id++) db.insert(schema.sleepRecords).values({ id, side: 'left', enteredBedAt: new Date(now + id * 86400000),
    leftBedAt: new Date(now + id * 86400000 + 3600000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
  datasets = new DatasetStore(db, () => now)
  datasetId = datasets.create({ side: 'left', subjectId: 'A', sessionIds: [1, 2, 3], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'dataset' }).id
  store = new BacktestJobStore(db, () => now)
  experimentId = store.createExperiment(datasetId, protocol).id
})
afterEach(() => sqlite.close())

describe('durable backtest leases and results', () => {
  it('deduplicates requests, permits only one active worker, and atomically publishes the winning attempt', () => {
    const job = enqueue()
    expect(enqueue().id).toBe(job.id)
    expect(() => enqueue('job-1', 'validation')).toThrow('changed')
    const claimed = store.claim('worker-A')
    expect(claimed).toMatchObject({ id: job.id, attempt: 1, fencingToken: 1 })
    expect(store.claim('worker-B')).toBeNull()
    if (!claimed) throw new Error('Missing claim')
    const token = lease(claimed)
    store.heartbeat(token, { phase: 'evaluating', completedNights: 0, totalNights: 1 })
    store.complete(token, { status: 'insufficient_evidence' })
    expect(store.get(job.id).state).toBe('succeeded')
    expect(sqlite.prepare('SELECT count(*) AS n FROM biometric_backtest_results').get()).toEqual({ n: 1 })
    expect(() => store.complete(token, {})).toThrow('no longer authoritative')
  })
  it('releases inline report bytes idempotently without erasing holdout exposure or job identity', () => {
    const job = enqueue('release-report', 'holdout')
    expect(() => store.releaseResult(job.id, '0'.repeat(64))).toThrow('Only completed')
    const claimed = store.claim('worker-A')
    if (!claimed) throw new Error('Missing claim')
    const published = store.complete(lease(claimed), { traces: ['retained until release'] })
    expect(() => store.releaseResult(job.id, '0'.repeat(64))).toThrow('hash changed')
    expect(store.result(job.id)?.available).toBe(true)
    const released = store.releaseResult(job.id, published.contentHash)
    expect(released).toMatchObject({ available: false, report: null, releasedAtMs: now,
      contentHash: published.contentHash, fencingToken: claimed.fencingToken, currentHoldoutUseCount: 1 })
    now += 1000
    expect(store.releaseResult(job.id, published.contentHash)).toEqual(released)
    expect(store.result(job.id)).toEqual(released)
    expect(enqueue('release-report', 'holdout').id).toBe(job.id)
    expect(store.get(job.id).state).toBe('succeeded')
    expect(sqlite.prepare('SELECT report FROM biometric_backtest_results').get()).toEqual({ report: '{}' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM biometric_holdout_accesses').get()).toEqual({ n: 1 })
  })
  it('fences expired workers and retries crashes only within the attempt limit', () => {
    const job = enqueue()
    const first = store.claim('worker-A', 1000)
    if (!first) throw new Error('Missing claim')
    now += 1000
    expect(() => store.complete(lease(first), {})).toThrow('no longer authoritative')
    const second = store.claim('worker-B', 1000)
    expect(second).toMatchObject({ attempt: 2, fencingToken: 2 })
    expect(() => store.heartbeat(lease(first), { phase: 'loading', completedNights: 0, totalNights: 1 })).toThrow('no longer authoritative')
    now += 1000
    expect(store.claim('worker-C', 1000)).toMatchObject({ attempt: 3 })
    now += 1000
    expect(store.claim('worker-D')).toBeNull()
    expect(store.get(job.id)).toMatchObject({ state: 'failed', error: 'Worker lease expired' })
  })
  it('cancels queued jobs immediately and rejects publication after running cancellation', () => {
    const queued = enqueue()
    expect(store.cancel(queued.id).state).toBe('cancelled')
    expect(store.claim('worker')).toBeNull()
    const running = enqueue('second')
    const claimed = store.claim('worker')
    if (!claimed) throw new Error('Missing claim')
    expect(store.cancel(running.id).state).toBe('cancel_requested')
    expect(store.heartbeat(lease(claimed), { phase: 'loading', completedNights: 0, totalNights: 1 })).toEqual({ cancelRequested: true })
    expect(() => store.complete(lease(claimed), {})).toThrow('cannot publish')
    store.acknowledgeCancellation(lease(claimed))
    expect(store.get(running.id).state).toBe('cancelled')
    expect(sqlite.prepare('SELECT count(*) AS n FROM biometric_backtest_results').get()).toEqual({ n: 0 })
  })
  it('recovers abandoned cancellations without rerunning and rolls back failed result inserts', () => {
    const job = enqueue()
    const claimed = store.claim('worker', 1000)
    if (!claimed) throw new Error('Missing claim')
    sqlite.exec('CREATE TRIGGER reject_result BEFORE INSERT ON biometric_backtest_results BEGIN SELECT RAISE(ABORT, \'fixture failure\'); END;')
    expect(() => store.complete(lease(claimed), {})).toThrow('fixture failure')
    expect(store.get(job.id).state).toBe('running')
    store.cancel(job.id)
    now += 1000
    expect(store.claim('replacement')).toBeNull()
    expect(store.get(job.id).state).toBe('cancelled')
  })
  it('records holdout reuse across experiments and keeps duplicate enqueue from consuming it again', () => {
    const first = enqueue('holdout', 'holdout')
    expect(first.input).toMatchObject({ holdoutUse: 1, evidence: 'descriptive_only' })
    enqueue('holdout', 'holdout')
    expect(store.holdoutUseCount(datasetId)).toBe(1)
    experimentId = store.createExperiment(datasetId, protocol).id
    expect(enqueue('holdout-again', 'holdout').input).toMatchObject({ holdoutUse: 2, evidence: 'reused_holdout_is_validation' })
    expect(store.holdoutUseCount(datasetId)).toBe(2)
    const clone = datasets.create({ side: 'left', subjectId: 'different-asserted-name', sessionIds: [1, 2, 3], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'clone' })
    experimentId = store.createExperiment(clone.id, protocol).id
    expect(enqueue('cloned-holdout', 'holdout').input).toMatchObject({ holdoutUse: 3, evidence: 'reused_holdout_is_validation' })
    expect(store.holdoutUseCount(datasetId)).toBe(3)
  })
  it('rejects forged engine hashes and invalid progress without changing the lease', () => {
    expect(() => store.enqueue({ experimentId, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey: 'bad', split: 'tuning', configs: [{ ...config, resolvedHash: '0'.repeat(64) }] })).toThrow('does not match')
    enqueue()
    const claimed = store.claim('worker')
    if (!claimed) throw new Error('Missing claim')
    expect(() => store.heartbeat(lease(claimed), { phase: 'evaluating', completedNights: 2, totalNights: 1 })).toThrow('monotonic')
    expect(store.get(claimed.id).progress).toMatchObject({ completedNights: 0 })
    store.fail(lease(claimed), 'bounded failure')
    expect(store.get(claimed.id).state).toBe('failed')
  })
})

it('refuses signal experiments without immutable waveform inputs', () => {
  expect(() => store.createExperiment(datasetId, { ...protocol, mode: 'signal_replay' })).toThrow('retained waveform inputs')
})

describe('experiment and job bookkeeping', () => {
  it('recovers an exact experiment retry after dataset release without reopening inputs or accepting a changed request', () => {
    const original = store.createExperiment(datasetId, protocol, 'lost-experiment-reply')
    datasets.release(datasetId)
    now += 60000
    const restarted = new BacktestJobStore(db, () => now)
    expect(restarted.createExperiment(datasetId, { ...protocol, waveformStages: undefined }, 'lost-experiment-reply')).toEqual(original)
    expect(() => restarted.createExperiment(datasetId, { ...protocol, clockOffsetMs: 1 }, 'lost-experiment-reply')).toThrow('idempotency key changed')
    expect(() => restarted.createExperiment('00000000-0000-4000-8000-000000000000', protocol, 'lost-experiment-reply')).toThrow('idempotency key changed')
    expect(() => restarted.createExperiment(datasetId, protocol, 'new-experiment')).toThrow('explicitly released')
    expect(() => restarted.createExperiment(datasetId, { ...protocol, assumedStageCalibrationQuality: 2 }, 'lost-experiment-reply')).toThrow()
    expect(() => restarted.createExperiment(datasetId, protocol, '')).toThrow()
    expect(() => datasets.read(datasetId)).toThrow('explicitly released')
    expect(db.select().from(schema.biometricExperiments).all()).toHaveLength(2)
  })
  it('deduplicates experiments by idempotency key and pages them newest first', () => {
    const experiment = store.getExperiment(experimentId)
    expect(experiment.protocol).toEqual(protocol)
    expect(store.createExperiment(datasetId, protocol, experiment.idempotencyKey ?? undefined).id).toBe(experimentId)
    expect(() => store.createExperiment(datasetId, { ...protocol, clockOffsetMs: 1 }, experiment.idempotencyKey ?? undefined)).toThrow('idempotency key changed')
    expect(() => store.getExperiment('00000000-0000-4000-8000-000000000000')).toThrow('Experiment not found')
    for (let index = 0; index < 51; index++) {
      now += 1
      store.createExperiment(datasetId, protocol, `page-${index}`)
    }
    const first = store.pageExperiments('left')
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).toEqual({ createdAtMs: first.items[49].createdAtMs, id: first.items[49].id })
    const second = store.pageExperiments('left', first.nextCursor ?? undefined)
    expect(second.items).toHaveLength(2)
    expect(second.items.at(-1)?.id).toBe(experimentId)
    expect(second.nextCursor).toBeNull()
    expect(store.pageExperiments('right').items).toEqual([])
  })
  it('pages jobs with a cursor and reports missing jobs, datasets and results explicitly', () => {
    for (let index = 0; index < 51; index++) {
      now += 1
      enqueue(`job-${index}`)
    }
    const first = store.page('left')
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).not.toBeNull()
    const second = store.page('left', first.nextCursor ?? undefined)
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(store.page('right').items).toEqual([])
    expect(() => store.get('00000000-0000-4000-8000-000000000000')).toThrow('Backtest job not found')
    expect(() => store.holdoutUseCount('00000000-0000-4000-8000-000000000000')).toThrow('Dataset unavailable')
    expect(store.result(first.items[0].id)).toBeNull()
    expect(() => store.cancel('00000000-0000-4000-8000-000000000000')).toThrow('not found')
  })
  it('rejects malformed enqueue requests before touching the queue', () => {
    expect(() => store.enqueue({ experimentId, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey: 'dup', split: 'tuning', configs: [config, config] })).toThrow('labels must be unique')
    expect(() => store.enqueue({ experimentId: '00000000-0000-4000-8000-000000000000', evaluatorBuildHash: 'f'.repeat(64), idempotencyKey: 'missing', split: 'tuning', configs: [config] })).toThrow('Experiment not found')
    const waveform = { pythonBuildHash: 'b'.repeat(64), otherSide: { manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig } }
    expect(() => store.enqueue({ experimentId, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey: 'waveform', split: 'tuning', configs: [config], waveform })).toThrow('Waveform replay requires')
    const single = datasets.create({ side: 'left', subjectId: 'A', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'single' })
    experimentId = store.createExperiment(single.id, protocol).id
    expect(() => enqueue('no-nights', 'validation')).toThrow('no nights assigned')
    datasets.release(single.id)
    expect(() => enqueue('released')).toThrow('explicitly released')
    expect(sqlite.prepare('SELECT count(*) AS n FROM biometric_backtest_jobs').get()).toEqual({ n: 0 })
  })
  it('pins waveform replay jobs to the frozen other-side configuration', () => {
    freezeWaveformDataset(db, datasetId)
    const signal = { ...protocol, mode: 'signal_replay' as const, waveformStages: true }
    experimentId = store.createExperiment(datasetId, signal).id
    expect(store.getExperiment(experimentId).protocol).toEqual(signal)
    expect(() => enqueue('no-waveform')).toThrow('Waveform replay requires')
    const waveform = { pythonBuildHash: 'b'.repeat(64), otherSide: { manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig } }
    expect(() => store.enqueue({ experimentId, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey: 'forged', split: 'tuning', configs: [config],
      waveform: { ...waveform, otherSide: { ...waveform.otherSide, resolvedHash: '0'.repeat(64) } } })).toThrow('Other-side configuration identity mismatch')
    const job = store.enqueue({ experimentId, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey: 'waveform', split: 'tuning', configs: [config], waveform })
    expect(job.input).toMatchObject({ waveform, protocol: signal })
  })
  it('refuses stale leases for finished work and leaves finished jobs untouched by cancellation', () => {
    const job = enqueue()
    const claimed = store.claim('worker')
    if (!claimed) throw new Error('Missing claim')
    expect(() => store.acknowledgeCancellation(lease(claimed))).toThrow('has not been requested')
    expect(store.interrupt(lease(claimed), 'Resource admission withdrawn')).toMatchObject({ state: 'interrupted', error: 'Resource admission withdrawn' })
    expect(() => store.heartbeat(lease(claimed), { phase: 'loading', completedNights: 0, totalNights: 1 })).toThrow('no longer authoritative')
    const again = store.claim('worker')
    if (!again) throw new Error('Missing claim')
    store.complete(lease(again), { ok: true })
    expect(store.cancel(job.id).state).toBe('succeeded')
    expect(() => store.interrupt(lease(again))).toThrow('no longer authoritative')
    const third = enqueue('third')
    const claimedThird = store.claim('worker')
    if (!claimedThird) throw new Error('Missing claim')
    store.cancel(third.id)
    expect(store.interrupt(lease(claimedThird)).state).toBe('cancelled')
    const fourth = enqueue('fourth')
    const claimedFourth = store.claim('worker')
    if (!claimedFourth) throw new Error('Missing claim')
    store.cancel(fourth.id)
    expect(store.fail(lease(claimedFourth), 'late failure').state).toBe('cancelled')
  })
  it('detects corrupted results and refuses to release them', () => {
    const job = enqueue()
    const claimed = store.claim('worker')
    if (!claimed) throw new Error('Missing claim')
    const published = store.complete(lease(claimed), { report: 'bytes' })
    sqlite.prepare('UPDATE biometric_backtest_results SET report = ?').run(JSON.stringify({ report: 'tampered' }))
    expect(() => store.result(job.id)).toThrow('integrity check failed')
    sqlite.prepare('UPDATE biometric_backtest_results SET fencing_token = 99').run()
    expect(() => store.result(job.id)).toThrow('integrity check failed')
    expect(() => store.releaseResult(job.id, published.contentHash)).toThrow('integrity check failed')
    expect(() => store.releaseResult(job.id, 'not-a-hash')).toThrow()
  })
  it('refuses oversized reports and exhausted inline storage budgets', () => {
    enqueue('first')
    const first = store.claim('worker')
    if (!first) throw new Error('Missing claim')
    store.complete(lease(first), { ok: true })
    enqueue('second')
    const claimed = store.claim('worker')
    if (!claimed) throw new Error('Missing claim')
    expect(() => store.complete(lease(claimed), { padding: Array.from({ length: 8200 }, () => 'x'.repeat(2048)) })).toThrow('exceeds 16 MiB')
    expect(() => store.complete(lease(claimed), { padding: Array.from({ length: 1600 }, () => 'x'.repeat(2048)) })).toThrow('persistent artifact directory')
    expect(() => store.collectOrphanedArtifacts()).toThrow('persistent artifact directory')
    sqlite.prepare('UPDATE biometric_backtest_results SET report = ?').run(`"${'x'.repeat(63 * 1024 * 1024)}"`)
    expect(() => store.complete(lease(claimed), { padding: Array.from({ length: 520 }, () => 'x'.repeat(2048)) })).toThrow('storage budget')
    expect(store.get(claimed.id).state).toBe('running')
  })
  it('stores large reports through an explicit artifact store and collects orphans', () => {
    const directory = mkdtempSync(join(tmpdir(), 'biometric-jobs-artifacts-'))
    try {
      const artifacts = new ReportArtifactStore(directory)
      const stored = new BacktestJobStore(db, () => now, artifacts)
      const job = enqueue()
      const claimed = stored.claim('worker')
      if (!claimed) throw new Error('Missing claim')
      const report = { padding: Array.from({ length: 1600 }, () => 'x'.repeat(2048)) }
      const published = stored.complete(lease(claimed), report)
      expect(stored.result(job.id)?.report).toEqual(report)
      expect(stored.collectOrphanedArtifacts()).toBe(0)
      const released = stored.releaseResult(job.id, published.contentHash)
      expect(released).toMatchObject({ available: false, report: null })
      expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toEqual([])
      expect(stored.releaseResult(job.id, published.contentHash)).toEqual(released)
    }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
