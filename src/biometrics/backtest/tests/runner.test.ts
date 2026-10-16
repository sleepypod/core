import { ReferenceStore } from '../../references/store'
import { previewReferenceImport } from '../../references/normalize'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { stageObjectiveTestPolicy } from './fixtures/stage-objective'
// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { DatasetStore } from '../datasets'
import { BacktestJobStore } from '../jobs'
import { workerBuildHash } from '../child'
import { failureMessage, executeNextBacktest } from '../runner'
import { backtestFixture } from './fixtures/backtest'
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let jobs: BacktestJobStore
let jobId: string
let directory: string
let evaluatorBuildHash: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'biometric-runner-test-'))
  await promisify(execFile)(process.execPath, ['scripts/build/biometrics-worker.mjs', directory])
  evaluatorBuildHash = await workerBuildHash(join(directory, 'worker.cjs'))
})
afterAll(async () => rm(directory, { recursive: true, force: true }))
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  const fixture = backtestFixture()
  const session = fixture.dataset.snapshot.sessions[0]
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(session.startMs), leftBedAt: new Date(session.endMs), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
  for (const row of session.vitals) db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(row.timestampMs), heartRate: row.heartRate, hrv: row.hrv, breathingRate: row.breathingRate }).run()
  const dataset = new DatasetStore(db).create({ side: 'left', subjectId: 'A', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'run' })
  jobs = new BacktestJobStore(db)
  const experiment = jobs.createExperiment(dataset.id, fixture.job.protocol)
  jobId = jobs.enqueue({ evaluatorBuildHash, experimentId: experiment.id, configs: fixture.job.configs,
    idempotencyKey: 'run', split: 'tuning' }).id
})
afterEach(() => sqlite.close())
const options = { owner: 'integration-test', get workerPath() {
  return join(directory, 'worker.cjs')
}, admit: async () => true }

describe('durable replay execution', () => {
  it('runs retained data through a child and publishes an integrity-checked result without changing canonical observations', async () => {
    const before = sqlite.prepare('SELECT * FROM vitals').all()
    expect(await executeNextBacktest(db, options)).toEqual({ state: 'succeeded', jobId })
    expect(jobs.result(jobId)?.report).toMatchObject({ version: 'processed-backtest-report-v1', status: 'insufficient_evidence', nights: [{ uniqueObservationCount: 10 }] })
    expect(jobs.result(jobId)?.report).toMatchObject({ jobOperations: { ingestion: { allChecksMeasured: false, samples: 0, maximumObservedAgeMs: null } } })
    expect(sqlite.prepare('SELECT * FROM vitals').all()).toEqual(before)
    expect(await executeNextBacktest(db, options)).toEqual({ state: 'idle' })
  })
  it('retains supervisor observations in the committed report and marks legacy boolean admission unmeasured', async () => {
    let checks = 0
    expect(await executeNextBacktest(db, { ...options, admit: async () => {
      checks++
      return true
    },
    admissionReceipt: () => ({ allowed: true, sample: { qualificationId: 'test-policy', checkedAtMs: Date.now(), ingestionAgeMs: checks * 100 } }),
    })).toEqual({ state: 'succeeded', jobId })
    expect(jobs.result(jobId)?.report).toMatchObject({ jobOperations: { version: 'backtest-job-operations-v1',
      ingestion: { allChecksMeasured: true, checks: 2, samples: 2, maximumObservedAgeMs: 200, qualificationId: 'test-policy' } } })
  })
  it('finalizes retained stage objectives after the real scoring child completes', async () => {
    const datasetId = jobs.getExperiment(jobs.get(jobId).experimentId).datasetId
    jobs.cancel(jobId)
    const fixture = backtestFixture()
    const experiment = jobs.createExperiment(datasetId, { ...fixture.job.protocol, stageObjectivePolicy: stageObjectiveTestPolicy })
    const staged = jobs.enqueue({ evaluatorBuildHash, experimentId: experiment.id, idempotencyKey: 'stage-objective', split: 'tuning',
      configs: [...fixture.job.configs, { ...fixture.job.configs[0], label: 'candidate' }] })
    expect(await executeNextBacktest(db, options)).toEqual({ state: 'succeeded', jobId: staged.id })
    expect(jobs.result(staged.id)?.report).toMatchObject({ status: 'no_material_change', stageObjectiveAssessments: [
      { baseline: 'default', status: 'insufficient_evidence', evidence: { operational: null } },
      { baseline: 'current', status: 'insufficient_evidence', evidence: { operational: null } },
    ] })
  })
  it.each([['wake', 'improved'], ['deep', 'regressed']] as const)('publishes %s candidate evidence as %s through the real scoring worker', async (stage, status) => {
    jobs.cancel(jobId)
    const first = 1791673200000
    const ids = Array.from({ length: 12 }, (_, index) => index + 10)
    const rows = ids.flatMap((id, index) => {
      const start = first + id * 86400000, end = start + 600000
      db.insert(schema.sleepRecords).values({ id, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(end), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
      for (let minute = 0; minute < 10; minute++) db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(start + minute * 60000), heartRate: 60, hrv: 30, breathingRate: 14 }).run()
      const middle = start + 360000 + index % 3 * 60000
      return [{ recordKey: `${id}-wake`, metric: 'sleep_stages', value: 'wake', unit: 'stage', startMs: start, endMs: middle },
        { recordKey: `${id}-light`, metric: 'sleep_stages', value: 'light', unit: 'stage', startMs: middle, endMs: end }]
    })
    const input = { side: 'left' as const, source: 'synthetic-runner-test', subjectId: 'fixture', rows }
    const reference = new ReferenceStore(db).commit({ import: input, previewHash: previewReferenceImport(input).summary.contentHash })
    const dataset = new DatasetStore(db).create({ side: 'left', subjectId: 'fixture', sessionIds: ids, referenceImportIds: [reference.id], timezone: 'UTC', idempotencyKey: 'qualified-test' })
    const policy = { ...stageObjectiveTestPolicy, requiredStages: ['wake' as const], maximumMacroF1Regression: 0.5,
      operational: { maximumWallMs: 60000, maximumPeakRssBytes: 1000000000, maximumIngestionAgeMs: 1000,
        observations: { version: 'sampled-process-group-v1' as const, maximumMemoryGapMs: 60000, maximumIngestionGapMs: 60000 } } }
    const protocol = { ...backtestFixture().job.protocol, assumedStageCalibrationQuality: 1, stageObjectivePolicy: policy,
      nightUncertainty: { version: 'paired-night-percentile-v1' as const, seed: 'runner-qualified', resamples: 200, minimumNights: 3 } }
    const experiment = jobs.createExperiment(dataset.id, protocol)
    const candidate = structuredClone(defaultConfig)
    candidate.sleep_stages.ruleset.rules = [{ stage, when: [] }]
    const configurations = [...backtestFixture().job.configs, { label: 'candidate' as const, revisionId: '33333333-3333-4333-8333-333333333333',
      resolved: candidate, resolvedHash: configHash(candidate), manifestHash }]
    const request = { evaluatorBuildHash, experimentId: experiment.id, configs: configurations, split: 'holdout' as const }
    const staged = jobs.enqueue({ ...request, idempotencyKey: 'qualified' })
    const registry = join(directory, 'promotion-qualifications.json')
    await writeFile(registry, JSON.stringify({ version: 'biometric-promotion-qualifications-v1', entries: [{
      qualificationId: policy.qualificationId, manifestHash, evaluatorBuildHash, protocol,
      fixtureEvidenceHash: 'a'.repeat(64), podEvidenceHash: 'b'.repeat(64), waveformContext: null,
    }] }))
    const before = sqlite.prepare('SELECT * FROM vitals').all()
    const measuredOptions = { ...options, admissionReceipt: () => ({ allowed: true,
      sample: { qualificationId: policy.qualificationId, checkedAtMs: Date.now(), ingestionAgeMs: 10 },
      memory: { version: 'process-group-rss-observations-v1' as const, scope: 'sum_rss_of_replay_process_group' as const,
        attempts: 2, samples: 2, allSamplesAvailable: true, peakObservedRssBytes: 1000, maximumObservationGapMs: 1, intervalMs: 1000 as const, exactKernelPeak: false as const } }) }
    try {
      expect(await executeNextBacktest(db, measuredOptions)).toEqual({ state: 'succeeded', jobId: staged.id })
      expect(jobs.result(staged.id)?.report).toMatchObject({ status,
        stageObjectiveAssessments: [{ status, designated: true }, { status, designated: true }] })
      if (status === 'improved') expect(jobs.result(staged.id)?.report).toMatchObject({ evidence: 'qualified_reference_agreement' })
      expect(sqlite.prepare('SELECT * FROM vitals').all()).toEqual(before)
      const reused = jobs.enqueue({ ...request, idempotencyKey: 'reused' })
      expect(await executeNextBacktest(db, measuredOptions)).toEqual({ state: 'succeeded', jobId: reused.id })
      expect(jobs.result(reused.id)?.report).toMatchObject({ status: 'insufficient_evidence' })
    }
    finally { await rm(registry, { force: true }) }
  })

  it('refuses to execute a different worker bundle after enqueue', async () => {
    sqlite.prepare('UPDATE biometric_backtest_jobs SET input = json_set(input, \'$.evaluatorBuildHash\', ?)').run('0'.repeat(64))
    expect(await executeNextBacktest(db, options)).toEqual({ state: 'stopped', jobId })
    expect(jobs.get(jobId).state).toBe('failed')
    expect(jobs.result(jobId)).toBeNull()
  })

  it('defers work before claim when resource admission is denied or shutdown arrives', async () => {
    expect(await executeNextBacktest(db, { ...options, admit: async () => false })).toEqual({ state: 'deferred' })
    expect(jobs.get(jobId).attempt).toBe(0)
    const controller = new AbortController()
    expect(await executeNextBacktest(db, { ...options, signal: controller.signal, admit: async () => {
      controller.abort()
      return true
    } })).toEqual({ state: 'deferred' })
    expect(jobs.get(jobId).attempt).toBe(0)
  })
  it('interrupts a running child when health declines and never publishes its result', async () => {
    const stalledPath = join(directory, 'stalled.cjs')
    await writeFile(stalledPath, 'process.stdin.resume(); setInterval(() => {}, 1000)')
    const hash = await workerBuildHash(stalledPath)
    sqlite.prepare('UPDATE biometric_backtest_jobs SET input = json_set(input, \'$.evaluatorBuildHash\', ?)').run(hash)
    let checks = 0
    const result = await executeNextBacktest(db, { ...options, workerPath: stalledPath, admit: async () => ++checks === 1 })
    expect(result).toEqual({ state: 'stopped', jobId })
    expect(checks).toBe(2)
    expect(jobs.get(jobId)).toMatchObject({ state: 'interrupted', error: 'Resource admission withdrawn' })
    expect(jobs.result(jobId)).toBeNull()
  }, 10000)

  it('withholds publication when the final resource check fails', async () => {
    let checks = 0
    expect(await executeNextBacktest(db, { ...options, admit: async () => {
      if (++checks === 1) return true
      throw new Error('Health collector unavailable')
    } })).toEqual({ state: 'stopped', jobId })
    expect(checks).toBe(2)
    expect(jobs.get(jobId)).toMatchObject({ state: 'interrupted', error: 'Resource admission withdrawn' })
    expect(jobs.result(jobId)).toBeNull()
  })
})

describe('lease, cancellation and worker protocol failures', () => {
  /** A scripted worker standing in for the scoring bundle; the job is re-pinned to its hash. */
  async function scriptedWorker(name: string, body: string) {
    const path = join(directory, name)
    await writeFile(path, `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const work=JSON.parse(input);const emit=e=>process.stdout.write(JSON.stringify(e)+'\\n');${body}});`)
    sqlite.prepare('UPDATE biometric_backtest_jobs SET input = json_set(input, \'$.evaluatorBuildHash\', ?)').run(await workerBuildHash(path))
    return path
  }
  const progress = (completedNights: number, totalNights = 1) => `emit({type:'progress',completedNights:${completedNights},totalNights:${totalNights}});`
  const identity = 'const report={version:"processed-backtest-report-v1",datasetHash:work.job.datasetHash,protocolHash:work.job.protocolHash,evaluatorBuildHash:work.job.evaluatorBuildHash,split:work.job.split,nights:[{}]};'

  it('interrupts a running replay when the host shuts down and leaves it for the next claimant', async () => {
    const workerPath = await scriptedWorker('shutdown.cjs', 'setInterval(()=>{},1000)')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    expect(await executeNextBacktest(db, { ...options, workerPath, signal: controller.signal })).toEqual({ state: 'stopped', jobId })
    expect(jobs.get(jobId)).toMatchObject({ state: 'interrupted', error: 'Worker host stopped' })
    expect(jobs.result(jobId)).toBeNull()
  })

  it('acknowledges a cancellation observed through a progress heartbeat', async () => {
    const workerPath = await scriptedWorker('cancel.cjs', `setInterval(()=>{${progress(0)}},50)`)
    setTimeout(() => jobs.cancel(jobId), 300)
    expect(await executeNextBacktest(db, { ...options, workerPath })).toEqual({ state: 'stopped', jobId })
    expect(jobs.get(jobId)).toMatchObject({ state: 'cancelled', leaseOwner: null })
    expect(jobs.result(jobId)).toBeNull()
  })

  it('stops without touching job state once its lease is no longer authoritative', async () => {
    const workerPath = await scriptedWorker('fenced.cjs', `setInterval(()=>{${progress(0)}},50)`)
    setTimeout(() => sqlite.prepare('UPDATE biometric_backtest_jobs SET fencing_token = fencing_token + 1').run(), 300)
    expect(await executeNextBacktest(db, { ...options, workerPath })).toEqual({ state: 'stopped', jobId })
    expect(jobs.get(jobId)).toMatchObject({ state: 'running', error: null })
  })

  it.each([
    ['a different night count', progress(0, 5)],
    ['regressing completion', progress(1) + progress(0)],
    ['completion beyond the night count', progress(2)],
  ])('fails a worker reporting %s', async (_, body) => {
    const workerPath = await scriptedWorker('progress.cjs', `${body}setInterval(()=>{},1000)`)
    expect(await executeNextBacktest(db, { ...options, workerPath })).toEqual({ state: 'stopped', jobId })
    expect(jobs.get(jobId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/^Replay failed validation, resources, or execution/) })
  })

  it.each([
    ['evaluator build', 'report.evaluatorBuildHash="0".repeat(64);'],
    ['dataset', 'report.datasetHash="0".repeat(64);'],
    ['protocol', 'report.protocolHash="0".repeat(64);'],
    ['split', 'report.split="holdout";'],
    ['night count', 'report.nights=[];'],
  ])('rejects a report whose %s identity differs from the leased job', async (_, mutate) => {
    const workerPath = await scriptedWorker('identity.cjs', `${identity}${mutate}${progress(1)}emit({type:'result',report});`)
    expect(await executeNextBacktest(db, { ...options, workerPath })).toEqual({ state: 'stopped', jobId })
    expect(jobs.get(jobId)).toMatchObject({ state: 'failed' })
    expect(jobs.result(jobId)).toBeNull()
  })

  it('rejects a report published before every night was reported complete', async () => {
    const workerPath = await scriptedWorker('incomplete.cjs', `${identity}emit({type:'result',report});`)
    expect(await executeNextBacktest(db, { ...options, workerPath })).toEqual({ state: 'stopped', jobId })
    expect(jobs.get(jobId)).toMatchObject({ state: 'failed' })
  })
})

describe('failure messages', () => {
  it('names the failed step for the pipeline’s own messages and stays generic for anything that could carry data', () => {
    expect(failureMessage(new Error('Waveform worker failed or returned an incomplete result')))
      .toBe('Replay failed validation, resources, or execution: Waveform worker failed or returned an incomplete result')
    expect(failureMessage(new z.ZodError([]))).toBe('Replay failed validation, resources, or execution: job input or report did not match its schema')
    for (const error of [new Error('ENOENT: /persistent/sleepypod-data/x.db'), new Error('{"heartRate":61}'), new Error(''), 'text', null]) {
      expect(failureMessage(error)).toBe('Replay failed validation, resources, or execution')
    }
  })
})
