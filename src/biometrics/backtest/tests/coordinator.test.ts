import { withBiometricBackgroundSlot } from '../../background-admission'
import * as cleanup from '../../shadow/process-cleanup'
// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { runCoordinatorTask } from '../coordinator'
import { BacktestJobStore } from '../jobs'
import { ShadowStore } from '../../shadow/store'
import { dataHash } from '../../algorithms/canonical'
import { DatasetStore } from '../datasets'
import { workerBuildHash } from '../child'
import { backtestFixture } from './fixtures/backtest'
import * as schema from '@/src/db/biometrics-schema'
let directory: string
let databasePath: string
let coordinatorPath: string
let workerPath: string

it('computes shadow health and reference agreement in the shipped coordinator without canonical writes', async () => {
  const sqlite = new Database(databasePath)
  const at = 1700000000000, hash = 'a'.repeat(64)
  const store = new ShadowStore(sqlite, { maximumRuns: 10, maximumPoints: 10, maximumBytes: 100000 }, () => at)
  const run = store.create({ schema: 'biometric-shadow-plan-v1', side: 'left', subjectId: 'shadow-fixture', startMs: at, endMs: at + 1000,
    candidateConfigHash: hash, activeConfigHash: hash, engineBuildHash: hash, qualificationHash: hash,
    maximumPoints: 10, maximumBytes: 10000, metrics: ['heart_rate'],
    monitoring: { expectedIntervalMs: 1000, maximumGapMs: 2000, heartbeatStaleMs: 2000, minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8,
      alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } } }, 'shadow-report')
  const lease = store.claim(run.id, 10000, () => {})
  store.append(lease, { sequence: 0, side: 'left', timestampMs: at, inputHash: null, candidateConfigHash: hash, activeConfigHash: hash,
    readings: [{ metric: 'heart_rate', candidate: { value: 62, quality: 1 }, active: { value: 60, quality: 1 } }] })
  store.finish(lease, 'completed', 'complete')
  const before = sqlite.prepare('SELECT * FROM vitals').all()
  try {
    const reference = { side: 'left' as const, subjectId: 'shadow-fixture', source: 'test', rows: [{ recordKey: 'hr', metric: 'heart_rate', value: 63, unit: 'bpm', timestampMs: at }] }
    const report = await runCoordinatorTask(options(), { type: 'readShadowReport', input: { id: run.id, reference } })
    expect(report.metrics[0].comparison.differences.commonMae).toBe(-2)
    expect(report.metrics[0].comparison.commonSupport.candidate.pairedCount).toBe(1)
    expect(report.interpretation).toBe('prospective_observation_and_reference_agreement_not_activation_authorization')
    const { reportHash, ...body } = report
    expect(reportHash).toBe(dataHash(body))
    expect(sqlite.prepare('SELECT * FROM vitals').all()).toEqual(before)
    await expect(runCoordinatorTask(options(), { type: 'readShadowReport', input: { id: run.id, reference: { ...reference, side: 'right' } } })).rejects.toMatchObject({ code: 'SUBJECT_MISMATCH' })
  }
  finally { sqlite.close() }
})
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'biometric-coordinator-test-'))
  await promisify(execFile)(process.execPath, ['scripts/build/biometrics-worker.mjs', directory])
  databasePath = join(directory, 'synthetic.db')
  coordinatorPath = join(directory, 'coordinator.cjs')
  workerPath = join(directory, 'worker.cjs')
  const sqlite = new Database(databasePath)
  sqlite.pragma('journal_mode = WAL')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  const start = Date.UTC(2026, 0, 1)
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600000), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
  db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(start), heartRate: 60 }).run()
  sqlite.close()
})
afterAll(async () => rm(directory, { recursive: true, force: true }))
const options = () => ({ databasePath, coordinatorPath, workerPath, modulePath: resolve('node_modules') })
const id = '11111111-1111-4111-8111-111111111111'
it('creates retained inputs off-process and preserves idempotent retries and source observations', async () => {
  const input = { side: 'left' as const, subjectId: 'fixture', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'coordinator-test' }
  const first = await runCoordinatorTask(options(), { type: 'createDataset', input })
  const retry = await runCoordinatorTask(options(), { type: 'createDataset', input })
  expect(retry).toEqual(first)
  expect(first.available).toBe(true)
  const db = new Database(databasePath, { readonly: true })
  expect(db.prepare('SELECT count(*) n FROM vitals').get()).toEqual({ n: 1 })
  expect(db.prepare('SELECT count(*) n FROM biometric_datasets').get()).toEqual({ n: 1 })
  db.close()
})
it('preserves known error codes without leaking database diagnostics', async () => {
  await expect(runCoordinatorTask(options(), { type: 'readTrace', input: { id, configuration: 'default', expectedContentHash: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(runCoordinatorTask({ ...options(), databasePath: join(directory, 'missing.db') }, { type: 'readResult', input: { id } })).rejects.toMatchObject({ code: 'COORDINATOR_FAILED', message: 'Biometrics coordinator failed' })
})
it('requires fresh parent admission and supports a successful idle execution', async () => {
  let checks = 0
  expect(await runCoordinatorTask(options(), { type: 'execute', owner: 'test' })).toEqual({ state: 'deferred' })
  expect(await runCoordinatorTask(options(), { type: 'execute', owner: 'test' }, { admit: async () => {
    checks++
    return true
  } })).toEqual({ state: 'idle' })
  expect(checks).toBe(1)
})
it('keeps the calling event loop responsive during synchronous coordinator work', async () => {
  const busy = join(directory, 'busy.cjs')
  await writeFile(busy, 'process.on(\'message\',()=>{const end=Date.now()+500;while(Date.now()<end){};process.send({type:\'result\',result:null},()=>process.disconnect())})')
  let ticks = 0
  const timer = setInterval(() => ticks++, 25)
  try {
    expect(await runCoordinatorTask({ ...options(), coordinatorPath: busy }, { type: 'collectArtifacts' })).toBeNull()
    expect(ticks).toBeGreaterThan(4)
  }
  finally { clearInterval(timer) }
})
it('bounds a stalled coordinator and permits subsequent work', async () => {
  const stalled = join(directory, 'stalled.cjs')
  await writeFile(stalled, 'process.on("message",()=>{});setInterval(()=>{},1000)')
  await expect(runCoordinatorTask({ ...options(), coordinatorPath: stalled, timeoutMs: 100 }, { type: 'collectArtifacts' })).rejects.toThrow('time budget')
  expect(await runCoordinatorTask(options(), { type: 'collectArtifacts' })).toBeNull()
})
it('allows an explicit longer execution budget without extending read deadlines', async () => {
  const fixture = join(directory, 'budget.cjs')
  const replayBudget = { jobWallMs: 300000, waveformWallMs: 200000, waveformCpuSeconds: 180 }
  await writeFile(fixture, `process.on('message',()=>{process.send({type:'result',result:JSON.parse(process.argv[5])},()=>process.disconnect())})`)
  const configured = { ...options(), coordinatorPath: fixture, replayBudget }
  expect(await runCoordinatorTask({ ...configured, timeoutMs: 200000 }, { type: 'execute', owner: 'test' })).toEqual(replayBudget)
  expect(await runCoordinatorTask(configured, { type: 'collectArtifacts' })).toBeNull()
  expect(() => runCoordinatorTask({ ...configured, timeoutMs: 200000 }, { type: 'collectArtifacts' })).toThrow('Invalid coordinator timeout')
  expect(() => runCoordinatorTask({ ...configured, timeoutMs: 300001 }, { type: 'execute', owner: 'test' })).toThrow('Invalid coordinator timeout')
  for (const changed of [{ jobWallMs: 500 }, { waveformWallMs: 400000 }, { waveformCpuSeconds: 201 }, { jobWallMs: 172800001 }]) {
    expect(() => runCoordinatorTask({ ...configured, replayBudget: { ...replayBudget, ...changed } }, { type: 'execute', owner: 'test' })).toThrow()
  }
})
it('enforces the configured job deadline when no test timeout overrides it', async () => {
  const stalled = join(directory, 'budget-stalled.cjs')
  await writeFile(stalled, 'process.on("message",()=>{});setInterval(()=>{},1000)')
  const began = performance.now()
  await expect(runCoordinatorTask({ ...options(), coordinatorPath: stalled,
    replayBudget: { jobWallMs: 1000, waveformWallMs: 1000, waveformCpuSeconds: 1 } },
  { type: 'execute', owner: 'test' })).rejects.toThrow('time budget')
  expect(performance.now() - began).toBeLessThan(3000)
})
it.skipIf(process.platform === 'win32')('kills evaluator descendants when a coordinator crashes', async () => {
  const script = join(directory, 'crash.cjs'), pidPath = join(directory, 'descendant.pid')
  await writeFile(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('message',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));process.exit(1)})`)
  await expect(runCoordinatorTask({ ...options(), coordinatorPath: script }, { type: 'collectArtifacts' })).rejects.toThrow('complete result')
  const pid = Number(await readFile(pidPath, 'utf8'))
  let alive = true
  for (let attempt = 0; attempt < 20 && alive; attempt++) {
    try {
      process.kill(pid, 0)
      if (process.platform === 'linux' && (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z') alive = false
    }
    catch { alive = false }
    if (alive) await new Promise(resolve => setTimeout(resolve, 25))
  }
  expect(alive).toBe(false)
})

it('runs a leased evaluation and preserves report identity across the process boundary', async () => {
  const sqlite = new Database(databasePath)
  const db = drizzle(sqlite, { schema })
  const dataset = new DatasetStore(db).create({ side: 'left', subjectId: 'fixture', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'execute-dataset' })
  const jobs = new BacktestJobStore(db)
  const fixture = backtestFixture().job
  const experiment = jobs.createExperiment(dataset.id, fixture.protocol)
  const job = jobs.enqueue({ experimentId: experiment.id, evaluatorBuildHash: await workerBuildHash(workerPath), configs: fixture.configs, split: 'tuning', idempotencyKey: 'execute-job' })
  try {
    expect(await runCoordinatorTask(options(), { type: 'execute', owner: 'integration' }, { healthAdmission: async () => ({ allowed: true, sample: { qualificationId: 'integration-policy', checkedAtMs: Date.now(), ingestionAgeMs: 123 } }) })).toEqual({ state: 'succeeded', jobId: job.id })
    const result = await runCoordinatorTask(options(), { type: 'readResult', input: { id: job.id } })
    expect(result?.contentHash).toBe(jobs.result(job.id)?.contentHash)
    expect(result?.available).toBe(true)
    expect(result?.report).toMatchObject({ jobOperations: { memory: { scope: 'sum_rss_of_replay_process_group', attempts: expect.any(Number), exactKernelPeak: false } } })
    expect(result?.report).toMatchObject({ jobOperations: { ingestion: { allChecksMeasured: true, samples: 2, maximumObservedAgeMs: 123, qualificationId: 'integration-policy' } } })
    const summary = await runCoordinatorTask(options(), { type: 'readSummary', input: { id: job.id } })
    expect(summary).toMatchObject({ contentHash: result?.contentHash, contentHashScope: 'complete_retained_report' })
    expect(JSON.stringify(summary?.report)).not.toContain('"blocks"')
    expect(JSON.stringify(result?.report)).toContain('"blocks"')
  }
  finally { sqlite.close() }
})

it('cooperatively interrupts a running lease before shutdown completes', async () => {
  const slow = join(directory, 'slow-evaluator.cjs')
  await writeFile(slow, 'process.stdin.resume();setInterval(()=>{},1000)')
  const sqlite = new Database(databasePath)
  const db = drizzle(sqlite, { schema })
  const dataset = new DatasetStore(db).create({ side: 'left', subjectId: 'fixture', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'cancel-dataset' })
  const jobs = new BacktestJobStore(db), fixture = backtestFixture().job
  const experiment = jobs.createExperiment(dataset.id, fixture.protocol)
  const job = jobs.enqueue({ experimentId: experiment.id, evaluatorBuildHash: await workerBuildHash(slow), configs: fixture.configs, split: 'tuning', idempotencyKey: 'cancel-job' })
  const controller = new AbortController()
  const running = runCoordinatorTask({ ...options(), workerPath: slow }, { type: 'execute', owner: 'cancel-test' }, { signal: controller.signal, admit: async () => true })
  const rejected = expect(running).rejects.toThrow('cancelled')
  try {
    for (let i = 0; i < 100 && jobs.get(job.id).state !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(jobs.get(job.id).state).toBe('running')
    controller.abort()
    await rejected
    expect(jobs.get(job.id)).toMatchObject({ state: 'interrupted', error: 'Worker host stopped' })
    expect(jobs.result(job.id)).toBeNull()
  }
  finally {
    controller.abort()
    await running.catch(() => {})
    sqlite.close()
  }
})

// Needs the locked piezo-processor venv, which Stryker's sandbox doesn't carry.
it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('inspects actual archives through the isolated coordinator and persists only admitted evidence', async () => {
  const archiveDirectory = join(directory, 'archive')
  await mkdir(archiveDirectory)
  const pythonPath = resolve('modules/piezo-processor/.venv/bin/python')
  const rawLocation = { pythonPath, modulesPath: resolve('modules'), archiveDirectory }
  await promisify(execFile)(pythonPath, ['-c', 'import gzip,sys;from pathlib import Path;Path(sys.argv[1]).write_bytes(gzip.compress(bytes.fromhex(\'a26373657101646461746148a164747970656178\'),mtime=0))', join(archiveDirectory, 'a.RAW.gz')])
  const scan = () => ({ type: 'inspectRawSource' as const, input: { afterName: null } })
  expect(await runCoordinatorTask({ ...options(), rawLocation }, scan())).toEqual({ status: 'deferred', nextCursor: null })
  let checks = 0
  expect(await runCoordinatorTask({ ...options(), rawLocation }, scan(), { admit: async () => ++checks === 1 })).toEqual({ status: 'deferred', nextCursor: null })
  const sqlite = new Database(databasePath)
  try {
    expect(sqlite.prepare('SELECT count(*) n FROM biometric_raw_sources').get()).toEqual({ n: 0 })
    const result = await runCoordinatorTask({ ...options(), rawLocation }, scan(), { admit: async () => true })
    expect(result.status).toBe('inspected')
    if (result.status !== 'inspected') throw new Error('Missing inspection')
    expect(result.source).toMatchObject({ availability: 'requires_reverification', inspection: { source_name: 'a.RAW.gz', retained: false, inventory: { decoded_records: 1 } } })
    expect(sqlite.prepare('SELECT count(*) n FROM biometric_raw_sources').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT count(*) n FROM biometric_raw_artifacts').get()).toEqual({ n: 0 })
    expect(await runCoordinatorTask(options(), { type: 'pageRawSources', input: { startMs: 0, endMs: 1 } })).toEqual({ items: [], nextCursor: null })
    await writeFile(join(archiveDirectory, 'a.RAW.gz'), 'corrupt')
    expect(await runCoordinatorTask({ ...options(), rawLocation }, scan(), { admit: async () => true })).toEqual({ status: 'source_unavailable', nextCursor: 'a.RAW.gz' })
    expect(sqlite.prepare('SELECT unavailable_at_ms unavailable FROM biometric_raw_sources').get()).toEqual({ unavailable: null })
    expect(await runCoordinatorTask({ ...options(), rawLocation }, { type: 'inspectRawSource', input: { afterName: 'a.RAW.gz' } }, { admit: async () => true })).toEqual({ status: 'complete', nextCursor: null })
  }
  finally { sqlite.close() }
})

it('cancels archive inspection when ongoing resource admission is withdrawn', async () => {
  const pythonPath = join(directory, 'slow-inspection')
  await writeFile(pythonPath, `#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);setTimeout(()=>process.exit(91),10000).unref();`, { mode: 0o700 })
  let checks = 0
  expect(await runCoordinatorTask({ ...options(), rawLocation: { pythonPath, modulesPath: directory, archiveDirectory: directory } },
    { type: 'inspectRawSource', input: { afterName: null } }, { admit: async () => ++checks === 1 })).toEqual({ status: 'deferred', nextCursor: null })
  expect(checks).toBe(2)
}, 10000)

it('collects aged RAW orphans through the admitted coordinator without touching fresh files', async () => {
  const retained = join(directory, 'biometric-raw')
  await mkdir(retained, { recursive: true })
  const old = join(retained, `${'a'.repeat(64)}.RAW.gz`), fresh = join(retained, `${'b'.repeat(64)}.RAW.gz`)
  await writeFile(old, 'old unpublished copy')
  await writeFile(fresh, 'fresh unpublished copy')
  await utimes(old, 0, 0)
  const rawLocation = { pythonPath: resolve('modules/piezo-processor/.venv/bin/python'), modulesPath: resolve('modules'), archiveDirectory: directory }
  await runCoordinatorTask({ ...options(), rawLocation }, { type: 'collectArtifacts' }, { admit: async () => false })
  expect(await readFile(old, 'utf8')).toBe('old unpublished copy')
  await runCoordinatorTask({ ...options(), rawLocation }, { type: 'collectArtifacts' }, { admit: async () => true })
  await expect(readFile(old)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(fresh, 'utf8')).toBe('fresh unpublished copy')
})

it('does not fall back to permissive boolean admission when the health callback denies or fails', async () => {
  for (const healthAdmission of [async () => ({ allowed: false, sample: null }), async () => {
    throw new Error('missing health')
  }]) {
    expect(await runCoordinatorTask(options(), { type: 'execute', owner: 'deny-health' }, { admit: async () => true, healthAdmission })).toEqual({ state: 'deferred' })
  }
})

it('shares background capacity with shadow attempts while retaining report access', async () => {
  let finish!: () => void
  const busy = withBiometricBackgroundSlot('work', () => new Promise<void>((resolve) => {
    finish = resolve
  }))
  try {
    for (const task of [{ type: 'execute', owner: 'test' }, { type: 'collectArtifacts' }] as const) {
      await expect(runCoordinatorTask(options(), task)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    }
    await expect(runCoordinatorTask(options(), { type: 'readResult', input: { id: '00000000-0000-4000-8000-000000000001' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }
  finally {
    finish()
    await busy
  }
  expect(await runCoordinatorTask(options(), { type: 'execute', owner: 'test' })).toEqual({ state: 'deferred' })
})
it('does not release background capacity when coordinator cleanup cannot be confirmed', async () => {
  const observation = vi.spyOn(cleanup, 'confirmShadowProcessCleanup').mockResolvedValueOnce(false)
  try {
    await expect(runCoordinatorTask(options(), { type: 'execute', owner: 'test' })).rejects.toMatchObject({ code: 'BIOMETRIC_COORDINATOR_CLEANUP_UNCONFIRMED' })
    await expect(withBiometricBackgroundSlot('work', async () => null)).rejects.toThrow('cleanup is unconfirmed')
  }
  finally {
    observation.mockRestore()
    delete (globalThis as typeof globalThis & { __biometricBackgroundSlotsV1?: unknown }).__biometricBackgroundSlotsV1
  }
})
