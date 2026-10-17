import { execFile } from 'node:child_process'
import { copyFile, link, mkdir, readdir, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { configHash, dataHash } from '@/src/biometrics/algorithms/canonical'
import { defaultConfig, manifestHash, resolveConfig, type BiometricConfig, type Override } from '@/src/biometrics/algorithms/registry'
import { experimentProtocolSchema } from '@/src/biometrics/backtest/contracts'
import { evaluateBacktest } from '@/src/biometrics/backtest/evaluator'
import { waveformPythonBuildSchema } from '@/src/biometrics/backtest/waveform-build'
import { runWaveformChild } from '@/src/biometrics/backtest/waveform-child'
import type { waveformEvaluationSchema } from '@/src/biometrics/backtest/waveform-output'
import type { VerifiedBundle } from './bundle'
import { summarizeLocalReport, type LocalFitReport } from './report'

export const LOCAL_SPLITS = ['tuning', 'validation'] as const
export type LocalSplit = typeof LOCAL_SPLITS[number] | 'holdout'
/** Matches the protocol of the pod experiment the frozen nights were scored with. */
export const DEFAULT_PROTOCOL = { version: 'descriptive-evaluation-v1', mode: 'signal_replay', assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 } as const
const LOCAL_EXPERIMENT_ID = '00000000-0000-4000-8000-000000000000'
const REPO = resolve(import.meta.dirname, '../..')

/** Names the runner itself writes inside OUTPUT_DIR; a candidate directory must not shadow them. */
export const RESERVED_CANDIDATE_IDS = new Set(['bundle', 'work', 'readings', 'ranking.json', 'ranking.md', 'run.json', 'parity.json'])
export const candidateIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/, 'Candidate ids start with a letter or digit and use only letters, digits, _ . -')
  .refine(id => !RESERVED_CANDIDATE_IDS.has(id), 'Candidate id collides with a runner output name')
export const candidateSchema = z.object({ id: candidateIdSchema,
  overrides: z.array(z.object({ path: z.string().min(1).max(200), value: z.unknown() }).strict()).max(64) }).strict()
export const candidateFileSchema = z.array(candidateSchema).min(1).max(500)
  .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'Candidate ids must be unique')
export type Candidate = z.infer<typeof candidateSchema>

export interface PythonLocation { pythonPath: string, modulesPath: string, script: string }
export function defaultPythonLocation(pythonPath?: string): PythonLocation {
  return { pythonPath: pythonPath ?? join(REPO, 'modules/piezo-processor/.venv/bin/python'), modulesPath: join(REPO, 'modules'),
    script: join(REPO, 'scripts/biometrics-local-fit/local_replay.py') }
}

export async function describeLocalBuild(location: PythonLocation) {
  const { stdout } = await promisify(execFile)(location.pythonPath, ['-B', location.script, '--describe-build', '-'], {
    cwd: tmpdir(), env: { NODE_ENV: 'production', PYTHONPATH: location.modulesPath, LANG: 'C.UTF-8', TZ: 'UTC' }, encoding: 'utf8', maxBuffer: 65536, timeout: 30000,
  }).catch(() => {
    throw new Error(`Cannot run ${location.pythonPath}; create it with: (cd modules/piezo-processor && uv sync --frozen)`)
  })
  const build = waveformPythonBuildSchema.parse(JSON.parse(stdout))
  if (configHash(build.identity) !== build.hash) throw new Error('Local Python build identity integrity mismatch')
  return { ...build, sourcesHash: configHash(build.identity.sources) }
}

/** The read-only artifact store serializes readers on its directory lock, so
 * each worker slot gets a private directory of hard links (copies across devices). */
export async function prepareWorkerSlots(rawDirectory: string, workDirectory: string, count: number) {
  const names = (await readdir(rawDirectory)).filter(name => /^[a-f0-9]{64}\.RAW\.gz$/.test(name))
  const slots: string[] = []
  for (let index = 0; index < count; index++) {
    const slot = join(workDirectory, `slot-${index}`)
    await mkdir(slot, { recursive: true, mode: 0o700 })
    for (const name of names) {
      await link(join(rawDirectory, name), join(slot, name)).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return
        if (error.code !== 'EXDEV') throw error
        await copyFile(join(rawDirectory, name), join(slot, name))
      })
    }
    await writeFile(join(slot, '.lock'), '', { mode: 0o600 })
    slots.push(slot)
  }
  return slots
}

/** Run items across slots; the first failure aborts every replay still running. */
async function runPool<T>(items: T[], slots: string[], work: (item: T, slot: string, signal: AbortSignal) => Promise<void>) {
  let next = 0
  const controller = new AbortController()
  await Promise.all(slots.map(async (slot) => {
    while (!controller.signal.aborted && next < items.length) {
      try {
        await work(items[next++], slot, controller.signal)
      }
      catch (error) {
        controller.abort()
        throw error
      }
    }
  }))
}

export interface ResolvedCandidate extends Candidate { resolved: BiometricConfig, resolvedHash: string }
export function resolveCandidates(candidates: Candidate[]): ResolvedCandidate[] {
  const rows = candidates.some(candidate => candidate.id === 'defaults') ? candidates : [{ id: 'defaults', overrides: [] }, ...candidates]
  return rows.map((candidate) => {
    const { resolved, hash } = resolveConfig(candidate.overrides as Override[])
    return { ...candidate, resolved: resolved as BiometricConfig, resolvedHash: hash }
  })
}

export interface FitOptions {
  bundle: VerifiedBundle
  candidates: Candidate[]
  outputDirectory: string
  splits?: readonly LocalSplit[]
  /** Score holdout nights too, once, for a candidate that is already chosen. */
  includeHoldout?: boolean
  /** Also write each replay's derived readings here, one JSON file per night and configuration. */
  readingsDirectory?: string
  jobs?: number
  protocol?: z.input<typeof experimentProtocolSchema>
  python?: PythonLocation
  onProgress?: (done: number, total: number, item: { cohortId: string, candidateIds: string[], wallMs: number }) => void
}

/** Replay each selected night once per distinct resolved configuration, then
 * score each candidate and split with the pod's own evaluator. Holdout nights
 * are replayed only with includeHoldout. */
export async function fitCandidates(options: FitOptions) {
  const { bundle } = options
  if (bundle.snapshot.version !== 'waveform-dataset-v1') throw new Error('Local fitting needs a retained waveform dataset')
  const snapshot = bundle.snapshot
  const splits = options.splits ?? LOCAL_SPLITS
  if (splits.some(split => split === 'holdout') && !options.includeHoldout) throw new Error('Holdout nights are held back: pass --include-holdout only to score an already-chosen candidate, once')
  if (splits.some(split => split !== 'holdout' && !(LOCAL_SPLITS as readonly string[]).includes(split))) throw new Error('Unknown split')
  const protocol = experimentProtocolSchema.parse(options.protocol ?? DEFAULT_PROTOCOL)
  if (protocol.mode !== 'signal_replay') throw new Error('Local fitting scores waveform replay; use a signal_replay protocol')
  const python = options.python ?? defaultPythonLocation()
  const build = await describeLocalBuild(python)
  const candidates = resolveCandidates(options.candidates)
  const defaults = { manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig as BiometricConfig }
  const configs = new Map([[defaults.resolvedHash, defaults.resolved], ...candidates.map(row => [row.resolvedHash, row.resolved] as const)])
  const assignments = bundle.manifest.splitProtocol.assignments.filter(row => (splits as readonly string[]).includes(row.split))
  const inputs = new Map(snapshot.waveformInputs.map(row => [row.cohortId, row.input]))
  const items = assignments.flatMap(assignment => [...configs.keys()].map(hash => ({ cohortId: assignment.cohortId, hash })))
  const length = (cohortId: string) => {
    const input = inputs.get(cohortId)
    if (!input) throw new Error(`Bundle has no retained input for ${cohortId}`)
    return input.score_end_ms - input.retained_start_ms
  }
  // Longest nights first keeps every slot busy until the end.
  items.sort((a, b) => length(b.cohortId) - length(a.cohortId))
  const jobs = Math.max(1, Math.min(options.jobs ?? availableParallelism(), items.length))
  const work = join(options.outputDirectory, 'work')
  const slots = await prepareWorkerSlots(bundle.rawDirectory, work, jobs)
  const outputs = new Map<string, z.infer<typeof waveformEvaluationSchema>['outputs'][number]>()
  const otherSideSide = snapshot.side === 'left' ? 'right' : 'left'
  const started = performance.now()
  let done = 0
  await runPool(items, slots, async (item, slot, signal) => {
    const input = inputs.get(item.cohortId)
    const resolved = configs.get(item.hash)
    if (!input || !resolved) throw new Error('Missing replay input')
    const itemStarted = performance.now()
    const output = await runWaveformChild({ ...python, retainedDirectory: slot },
      { version: 'retained-waveform-work-v1', input, configs: { [snapshot.side]: resolved, [otherSideSide]: defaults.resolved } },
      { signal, timeoutMs: 3600000, expectedBuildHash: build.hash })
    outputs.set(`${item.cohortId}:${item.hash}`, { cohortId: item.cohortId, configHash: item.hash, ...output })
    if (options.readingsDirectory) {
      await mkdir(options.readingsDirectory, { recursive: true })
      await writeFile(join(options.readingsDirectory, `${item.cohortId}-${item.hash.slice(0, 12)}.json`),
        `${JSON.stringify({ cohortId: item.cohortId, configHash: item.hash, side: snapshot.side, readings: output.readings })}\n`)
    }
    options.onProgress?.(++done, items.length, { cohortId: item.cohortId,
      candidateIds: candidates.filter(row => row.resolvedHash === item.hash).map(row => row.id), wallMs: performance.now() - itemStarted })
  })
  const replayWallMs = performance.now() - started
  const evaluatorBuildHash = configHash({ version: 'biometrics-local-fit-evaluator-v1', pythonBuildHash: build.hash, node: process.version })
  const reports: LocalFitReport[] = []
  for (const candidate of candidates) {
    for (const split of splits) {
      const cohorts = assignments.filter(row => row.split === split).map(row => row.cohortId)
      if (!cohorts.length) continue
      const jobConfigs = [{ label: 'default' as const, revisionId: null, ...defaults },
        { label: 'candidate' as const, revisionId: null, manifestHash, resolvedHash: candidate.resolvedHash, resolved: candidate.resolved }]
      const runOutputs = cohorts.flatMap(cohortId => [...new Set(jobConfigs.map(config => config.resolvedHash))].map((hash) => {
        const output = outputs.get(`${cohortId}:${hash}`)
        if (!output) throw new Error(`Missing replay output for ${cohortId}`)
        return output
      }))
      const job = { version: 'backtest-job-v1' as const, experimentId: LOCAL_EXPERIMENT_ID, idempotencyKey: `local:${candidate.id}:${split}`,
        evaluatorBuildHash, split, configs: jobConfigs, waveform: { pythonBuildHash: build.hash, otherSide: defaults },
        datasetId: bundle.index.dataset.id, datasetHash: bundle.index.dataset.contentHash, protocol, protocolHash: configHash(protocol),
        holdoutUse: 0, evidence: 'descriptive_only' as const }
      const report = evaluateBacktest({ job, dataset: { manifest: bundle.manifest, snapshot }, waveform: { hash: dataHash(runOutputs), outputs: runOutputs } })
      reports.push(summarizeLocalReport({ candidate, split, report, dataset: bundle.index.dataset,
        build: { pythonBuildHash: build.hash, pythonSourcesHash: build.sourcesHash, evaluatorBuildHash }, protocol }))
    }
  }
  return { reports, build, replayWallMs, workItems: items.length, jobs }
}
