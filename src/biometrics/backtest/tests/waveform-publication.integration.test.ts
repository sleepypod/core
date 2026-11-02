// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { configHash } from '../../algorithms/canonical'
import { BacktestJobStore } from '../jobs'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { DatasetStore } from '../datasets'
import { datasetManifestSchema } from '../contracts'
import { prepareSelectedWaveformDataset } from '../waveform-selection'
import { RawSourceCatalog } from '../raw-catalog'
import { waveformEvaluatorBuildIdentity } from '../waveform-build'
import { runCoordinatorTask } from '../coordinator'
import { runWaveformChild } from '../waveform-child'
import type { z } from 'zod'
import type { retainedWaveformInputSchema } from '../waveform-contracts'

type Input = z.infer<typeof retainedWaveformInputSchema>
const python = resolve('modules/piezo-processor/.venv/bin/python')
const environment: NodeJS.ProcessEnv = { PYTHONPATH: resolve('modules'), OPENBLAS_NUM_THREADS: '1', LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test' }

// Needs the locked piezo-processor venv, which Stryker's sandbox doesn't carry.
it.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)('publishes, verifies, replays, releases and collects a retained waveform dataset without changing observations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'waveform-publication-integration-'))
  const database = join(directory, 'biometrics.db')
  const archive = join(directory, 'archive')
  const retained = join(directory, 'biometric-raw')
  const sqlite = new Database(database)
  try {
    // Keep the kernel lock real but isolate its inode from /run and other tests.
    // Production has no CLI/environment override for the host execution lock.
    const fixturePython = join(directory, 'fixture-python')
    writeFileSync(fixturePython, `#!${python}
import runpy, sys
args = sys.argv[1:]
if args[0] == '-B':
    args = args[1:]
assert args[0] == '-m'
module = args[1]
sys.argv = [module, *args[2:]]
if module == 'common.biometrics.replay_worker':
    from common.biometrics import replay_worker
    from common.biometrics.execution_lock import acquire_execution_lock
    replay_worker.acquire_execution_lock = lambda: acquire_execution_lock(${JSON.stringify(join(directory, 'execution.lock'))})
    sys.exit(replay_worker.main())
runpy.run_module(module, run_name='__main__')
`, { mode: 0o700 })
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
    const fixture = JSON.parse(execFileSync(python, ['-B', '-c', `
import json, gzip, sys
from dataclasses import asdict
from pathlib import Path
import cbor2
import numpy as np
from common.biometrics.raw_sources import ArchiveSource
root=Path(sys.argv[1]); root.mkdir()
start=1700000000000
records=[{'type':'frzHealth','ts':start/1000,'left':{'pumpRpm':0},'right':{'pumpRpm':0}}]
for second in range(150):
    samples=(np.sin((np.arange(500)+second*500)/500*2*np.pi*1.2)*1000000).astype('<i4').tobytes()
    records.append({'type':'piezo-dual','ts':start/1000+second,'left1':samples,'right1':bytes(2000)})
artifacts=[]; inspections=[]
for index, group in enumerate([records[:76],records[76:]]):
    name=str(index)+'.RAW.gz'
    payload=b''.join(cbor2.dumps({'seq':number,'data':cbor2.dumps(record)}) for number,record in enumerate(group))
    (root/name).write_bytes(gzip.compress(payload,mtime=0))
    inspected=ArchiveSource(root,name).inspect()
    descriptor=asdict(inspected['artifact']); inventory=inspected['inventory']
    inspections.append({**inspected,'artifact':descriptor})
    artifacts.append({'artifact':descriptor,'first_event_ms':inventory['first_event_ms'],'last_event_ms':inventory['last_event_ms']})
print(json.dumps({'start':start,'artifacts':artifacts,'inspections':inspections}))
`, archive], { env: environment, encoding: 'utf8', timeout: 20000, maxBuffer: 65536 })) as {
      start: number
      inspections: unknown[]
      artifacts: Input['artifacts']
    }
    const input: Input = { version: 'retained-waveform-input-v1', retained_start_ms: fixture.start,
      score_start_ms: fixture.start + 60000, score_end_ms: fixture.start + 150000, artifacts: fixture.artifacts,
      contexts: [] }
    db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(input.score_start_ms),
      leftBedAt: new Date(input.score_end_ms), sleepDurationSeconds: 90, timesExitedBed: 0, presentIntervals: [[input.score_start_ms / 1000, input.score_end_ms / 1000]] }).run()
    db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(input.score_start_ms), heartRate: 65 }).run()
    const now = input.score_end_ms + 10000
    const datasets = new DatasetStore(db, () => now)
    const base = datasets.read(datasets.create({ side: 'left', subjectId: 'fixture', sessionIds: [1],
      referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'processed' }).id)
    const manifest = datasetManifestSchema.parse(base.manifest)
    const catalog = new RawSourceCatalog(db)
    const sourceIds = fixture.inspections.map(inspection => catalog.record(inspection))
    const request = { parentDatasetId: base.id, expectedContentHash: base.contentHash,
      cohorts: [{ cohortId: manifest.splitProtocol.assignments[0].cohortId, sourceIds }], idempotencyKey: 'waveform' }
    const { prepared } = prepareSelectedWaveformDataset(db, request, now)
    execFileSync(process.execPath, ['scripts/build/biometrics-worker.mjs', directory])
    const options = { replayBudget: { jobWallMs: 300000, waveformWallMs: 200000, waveformCpuSeconds: 180 }, databasePath: database, coordinatorPath: join(directory, 'coordinator.cjs'), workerPath: join(directory, 'worker.cjs'),
      modulePath: resolve('node_modules'), rawLocation: { pythonPath: fixturePython, modulesPath: resolve('modules'), archiveDirectory: archive } }
    expect(await runCoordinatorTask(options, { type: 'createWaveformDataset', input: request })).toEqual({ status: 'deferred' })
    let admissionChecks = 0
    expect(await runCoordinatorTask(options, { type: 'createWaveformDataset', input: request }, { admit: async () => ++admissionChecks === 1 })).toEqual({ status: 'deferred' })
    expect(admissionChecks).toBe(2)
    expect(readdirSync(directory)).not.toContain('biometric-raw')
    const slowPublisher = join(directory, 'slow-publisher')
    writeFileSync(slowPublisher, `#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);setTimeout(()=>process.exit(91),10000).unref();`, { mode: 0o700 })
    let resourceChecks = 0
    expect(await runCoordinatorTask({ ...options, rawLocation: { ...options.rawLocation, pythonPath: slowPublisher } },
      { type: 'createWaveformDataset', input: request }, { admit: async () => ++resourceChecks <= 2 })).toEqual({ status: 'deferred' })
    expect(resourceChecks).toBe(3)
    expect(sqlite.prepare('SELECT count(*) n FROM biometric_datasets').get()).toEqual({ n: 1 })
    const publish = async (input = request) => {
      const result = await runCoordinatorTask(options, { type: 'createWaveformDataset', input }, { admit: async () => true })
      if (result.status !== 'published') throw new Error('Publication was deferred')
      return { type: 'result', id: result.dataset.id, contentHash: result.dataset.contentHash, available: result.dataset.available }
    }
    const published = await publish()
    expect(published).toEqual({ type: 'result', id: expect.any(String), contentHash: prepared.contentHash, available: true })
    const frozen = datasets.read(published.id)
    expect(frozen.snapshot).toEqual(prepared.snapshot) // Includes shared cross-language content-hash verification.
    expect(sqlite.prepare('SELECT count(*) AS count FROM biometric_dataset_raw_artifacts').get()).toEqual({ count: 2 })
    rmSync(archive, { recursive: true })
    for (const id of sourceIds) catalog.markUnavailable(id)
    expect(await publish()).toEqual(published)
    const retryWithoutAdmission = await runCoordinatorTask(options, { type: 'createWaveformDataset', input: { ...request, cohorts: request.cohorts.map(item => ({ ...item, sourceIds: [...item.sourceIds].reverse() })) } })
    expect(retryWithoutAdmission).toMatchObject({ status: 'published', dataset: { id: published.id } })
    if (frozen.snapshot.version !== 'waveform-dataset-v1') throw new Error('Missing waveform inputs')
    const build = await waveformEvaluatorBuildIdentity(options.coordinatorPath, options.workerPath, options.rawLocation)
    const replay = await runWaveformChild({ pythonPath: fixturePython, modulesPath: resolve('modules'), retainedDirectory: retained }, {
      version: 'retained-waveform-work-v1', input: frozen.snapshot.waveformInputs[0].input,
      configs: { left: defaultConfig, right: defaultConfig },
    }, { expectedBuildHash: build.python.hash })
    expect(replay.run.build_hash).toBe(build.python.hash)
    expect(replay.readings.length).toBeGreaterThan(0)
    expect(replay.run.raw_records).toBe(151)
    expect(sqlite.prepare('SELECT heart_rate FROM vitals').all()).toEqual([{ heart_rate: 65 }])
    const jobs = new BacktestJobStore(db)
    const experiment = jobs.createExperiment(published.id, { version: 'descriptive-evaluation-v1', mode: 'signal_replay', waveformStages: true,
      assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0,
      objectivePolicy: { version: 'numeric-objective-v1', qualificationId: 'integration-only', metric: 'heart_rate',
        minimumNights: 3, minimumPairedReferencesPerNight: 10, maximumLostObservationFraction: 0.1, minimumMaeImprovement: 2,
        maximumNightMaeRegression: 1, maximumRegressedNightFraction: 0.34, maximumSubgroupMaeRegression: 1, requiredSubgroups: [],
        operational: { maximumWallMs: 30000, maximumPeakRssBytes: 536870912, maximumIngestionAgeMs: 5000,
          observations: { version: 'sampled-process-group-v1', maximumMemoryGapMs: 2000, maximumIngestionGapMs: 7000 } } } })
    const candidate = structuredClone(defaultConfig)
    candidate.heart_rate.trackingToleranceBpm = 20
    const jobInput = { experimentId: experiment.id, evaluatorBuildHash: build.hash, split: 'tuning' as const,
      waveform: { pythonBuildHash: build.python.hash, otherSide: { manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig } },
      configs: [
        { label: 'default' as const, revisionId: null, manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig },
        { label: 'current' as const, revisionId: null, manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig },
        { label: 'candidate' as const, revisionId: null, manifestHash, resolvedHash: configHash(candidate), resolved: candidate },
      ] }
    expect(() => jobs.enqueue({ ...jobInput, waveform: undefined, idempotencyKey: 'unpinned-signal' })).toThrow('pinned Python')
    expect(() => jobs.enqueue({ ...jobInput, waveform: { ...jobInput.waveform, otherSide: { ...jobInput.waveform.otherSide, resolvedHash: '0'.repeat(64) } }, idempotencyKey: 'wrong-other-side' })).toThrow('Other-side configuration')
    const job = jobs.enqueue({ ...jobInput, idempotencyKey: 'signal-job' })
    expect(await runCoordinatorTask(options, { type: 'execute', owner: 'signal-integration' }, { admit: async () => true })).toEqual({ state: 'succeeded', jobId: job.id })
    const report = jobs.result(job.id)?.report
    expect(report).toMatchObject({ version: 'waveform-backtest-report-v1', datasetHash: published.contentHash,
      evaluatorBuildHash: build.hash, protocol: { mode: 'signal_replay' }, waveform: { outputs: [{}, {}] },
      nights: [{ evaluations: [{ label: 'default' }, { label: 'current' }, { label: 'candidate' }] }] })
    expect(report).toMatchObject({ objectiveAssessments: [
      { baseline: 'default', evidence: { operational: null }, status: 'insufficient_evidence' },
      { baseline: 'current', evidence: { operational: null }, status: 'insufficient_evidence' },
    ] })
    const summary = await runCoordinatorTask(options, { type: 'readSummary', input: { id: job.id } })
    expect(JSON.stringify(summary?.report)).not.toContain('"readings"')
    expect(JSON.stringify(report)).toContain('"readings"')
    if (!summary) throw new Error('Missing retained report')
    const referenceTraceInput = { id: job.id, expectedContentHash: summary.contentHash,
      cohortId: prepared.manifest.splitProtocol.assignments[0].cohortId, metric: 'heart_rate' as const }
    const references = await runCoordinatorTask(options, { type: 'readReferenceTrace', input: referenceTraceInput })
    expect(references).toMatchObject({ provenance: 'frozen_dataset_reference', datasetHash: published.contentHash, items: [], totalItems: 0 })
    await expect(runCoordinatorTask(options, { type: 'readReferenceTrace', input: {
      ...referenceTraceInput, expectedContentHash: '0'.repeat(64),
    } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const numericTrace = await runCoordinatorTask(options, { type: 'readNumericTrace', input: {
      id: job.id, expectedContentHash: summary.contentHash, configuration: 'candidate', limit: 2,
    } })
    expect(numericTrace).toMatchObject({ provenance: 'retained_waveform_recomputation', side: 'left', downsampled: false })
    expect(numericTrace.totalItems).toBeGreaterThan(0)
    expect(numericTrace.items.every(row => row.side === 'left')).toBe(true)
    await expect(runCoordinatorTask(options, { type: 'readNumericTrace', input: {
      id: job.id, expectedContentHash: '0'.repeat(64), configuration: 'candidate',
    } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const wrongBuild = jobs.enqueue({ ...jobInput, evaluatorBuildHash: '0'.repeat(64), idempotencyKey: 'wrong-signal-build' })
    expect(await runCoordinatorTask(options, { type: 'execute', owner: 'wrong-build' }, { admit: async () => true })).toEqual({ state: 'stopped', jobId: wrongBuild.id })
    expect(jobs.get(wrongBuild.id).state).toBe('failed')
    expect(jobs.result(wrongBuild.id)).toBeNull()
    jobs.releaseResult(job.id, summary.contentHash)
    await expect(runCoordinatorTask(options, { type: 'readReferenceTrace', input: referenceTraceInput })).rejects.toMatchObject({ code: 'RESULT_RELEASED' })
    await expect(runCoordinatorTask(options, { type: 'readNumericTrace', input: {
      id: job.id, expectedContentHash: summary.contentHash, configuration: 'candidate',
    } })).rejects.toMatchObject({ code: 'RESULT_RELEASED' })
    expect(sqlite.prepare('SELECT heart_rate FROM vitals').all()).toEqual([{ heart_rate: 65 }])
    const reused = await publish({ ...request, idempotencyKey: 'reuse-retained' })
    expect(reused.contentHash).toBe(published.contentHash)
    expect(reused.id).not.toBe(published.id)
    datasets.release(reused.id)
    const lostReply = join(directory, 'lost-reply')
    writeFileSync(lostReply, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const input=require('node:fs').readFileSync(0);const result=spawnSync(${JSON.stringify(python)},process.argv.slice(2),{input,env:process.env});process.exit(result.status===0?42:1);`, { mode: 0o700 })
    const recovered = await runCoordinatorTask({ ...options, rawLocation: { ...options.rawLocation, pythonPath: lostReply } },
      { type: 'createWaveformDataset', input: { ...request, idempotencyKey: 'lost-reply' } }, { admit: async () => true })
    expect(recovered.status).toBe('published')
    if (recovered.status !== 'published') throw new Error('Lost committed response was not recovered')
    expect(recovered.dataset.contentHash).toBe(published.contentHash)
    datasets.release(recovered.dataset.id)
    datasets.release(published.id)
    expect(await publish()).toEqual({ ...published, available: false })
    const collected = JSON.parse(execFileSync(python, ['-B', '-c', `
import json, sqlite3, sys
from common.biometrics.raw_artifacts import RawArtifactStore
connection=sqlite3.connect(sys.argv[1])
print(json.dumps(RawArtifactStore(sys.argv[2]).collect_released(connection,now_ms=int(sys.argv[3]),minimum_age_ms=0)))
connection.close()
`, database, retained, String(now)], { env: environment, encoding: 'utf8', timeout: 20000 })) as string[]
    expect(collected).toHaveLength(2)
    expect(readdirSync(retained).filter(name => name.endsWith('.RAW.gz'))).toEqual([])
    expect(datasets.read(base.id)).toEqual(base)
    datasets.release(base.id)
    expect(await publish()).toEqual({ ...published, available: false })
    await expect(publish({ ...request, expectedContentHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  }
  finally {
    sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)
