// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configHash, dataHash } from '@/src/biometrics/algorithms/canonical'
import { defaultConfig, manifestHash, resolveConfig } from '@/src/biometrics/algorithms/registry'
import { evaluateBacktest } from '@/src/biometrics/backtest/evaluator'
import { exportableWaveformDataset, exportNights } from '@/src/biometrics/backtest/tests/fixtures/export'
import { candidateFileSchema, DEFAULT_PROTOCOL, fitCandidates } from './fit'
import { runLocalFitCli } from './cli'
import { DEFAULT_GRID, expandGrid } from './grid'
import { compareWithPod, parseLocalReport, rankCandidates, rankingMarkdown, summarizeLocalReport } from './report'

const pythonBuildHash = 'b'.repeat(64)
let directory: string
let fixture: ReturnType<typeof exportableWaveformDataset>
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'local-fit-report-'))
  fixture = exportableWaveformDataset(directory)
})
afterAll(() => {
  fixture.sqlite.close()
  rmSync(directory, { recursive: true, force: true })
})

/** Score a candidate with fixed synthetic readings (references are 62 bpm). */
function localReport(id: string, overrides: Array<{ path: string, value: unknown }>, split: 'tuning' | 'validation' | 'holdout', heartRates: { default: number, candidate: number }) {
  const defaults = { manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig }
  const candidate = resolveConfig(overrides as never)
  const configs = [{ label: 'default' as const, revisionId: null, ...defaults },
    { label: 'candidate' as const, revisionId: null, manifestHash, resolvedHash: candidate.hash, resolved: candidate.resolved }]
  const night = exportNights.find(row => row.split === split) ?? exportNights[0]
  const artifact = fixture.snapshot.version === 'waveform-dataset-v1' ? fixture.snapshot.waveformInputs.find(row => row.cohortId === night.cohortId)?.input.artifacts[0].artifact.sha256 ?? '' : ''
  const outputs = [...new Map(configs.map(config => [config.resolvedHash, config])).values()].map((config) => {
    const heartRate = config.label === 'default' ? heartRates.default : heartRates.candidate
    const readings = Array.from({ length: 10 }, (_, index) => ({ side: 'left' as const, timestampMs: night.startMs + index * 60000, heartRate, hrvIndex: 30,
      hrvMetric: 'window_ibi_variability_v1' as const, breathingRate: 14, qualityScore: 1, flags: null, hrRaw: heartRate, sourceSide: 'left' as const,
      configHash: config.resolvedHash, limitations: [] }))
    return { cohortId: night.cohortId, configHash: config.resolvedHash, readings, run: { version: 'retained-waveform-run-v1' as const, build_hash: pythonBuildHash,
      decoded_records: 10, raw_records: 10, counts: { records: 10, accepted_frames: 10, empty_channel_frames: 0, pump_gated_frames: 0, preroll_outputs: 0, scored_outputs: readings.length },
      limitations: [], config_hashes: { left: config.resolvedHash, right: defaults.resolvedHash }, artifact_hashes: [artifact] } }
  })
  const protocol = { ...DEFAULT_PROTOCOL }
  const job = { version: 'backtest-job-v1' as const, experimentId: '00000000-0000-4000-8000-000000000000', idempotencyKey: `local:${id}:${split}`, evaluatorBuildHash: 'e'.repeat(64),
    split, configs, waveform: { pythonBuildHash, otherSide: defaults }, datasetId: fixture.id, datasetHash: fixture.contentHash,
    protocol, protocolHash: configHash(protocol), holdoutUse: 0, evidence: 'descriptive_only' as const }
  const report = evaluateBacktest({ job, dataset: { manifest: fixture.manifest, snapshot: fixture.snapshot }, waveform: { hash: dataHash(outputs), outputs } })
  return summarizeLocalReport({ candidate: { id, overrides, resolvedHash: candidate.hash }, split, report, dataset: { id: fixture.id, contentHash: fixture.contentHash },
    build: { pythonBuildHash, pythonSourcesHash: 'c'.repeat(64), evaluatorBuildHash: 'e'.repeat(64) }, protocol })
}

describe('local fit reports', () => {
  it('labels every report exploratory-local and scores HR, breathing and HRV per night', () => {
    const report = localReport('tighter', [{ path: 'heart_rate.trackingToleranceBpm', value: 10 }], 'tuning', { default: 60, candidate: 61 })
    expect(report).toMatchObject({ version: 'biometrics-local-fit-report-v1', label: 'exploratory-local', evidence: 'not_activation_evidence', split: 'tuning',
      candidate: { id: 'tighter', resolvedHash: resolveConfig([{ path: 'heart_rate.trackingToleranceBpm', value: 10 }]).hash } })
    expect(report.notice).toContain('Only a backtest run on the pod')
    expect(report.summary.heart_rate).toMatchObject({ status: 'scored', totalNights: 1, scoredNights: 1, coverageReducedNights: 0,
      equalNightMeanMae: { default: 2, candidate: 1 }, equalNightMeanMaeDifference: -1 })
    expect(report.summary.heart_rate.nights).toEqual([{ cohortId: 'night-a', pairedCount: 5, defaultMae: 2, candidateMae: 1, maeDifference: -1, coverageReduced: false, lostObservationTimestamps: 0 }])
    // The fixture has no breathing or HRV reference, which must read as unscored, never zero error.
    expect(report.summary.breathing_rate).toMatchObject({ status: 'no_paired_reference', scoredNights: 0, equalNightMeanMaeDifference: null })
    expect(report.summary.window_ibi_variability_v1.status).toBe('no_paired_reference')
    expect(report.report.status).toBe('insufficient_evidence')
    expect(parseLocalReport(JSON.parse(JSON.stringify(report))).label).toBe('exploratory-local')
    expect(() => parseLocalReport({ ...report, label: 'pod' })).toThrow()
  })

  it('ranks by tuning HR error difference and keeps validation alongside', () => {
    const better = [{ path: 'heart_rate.trackingToleranceBpm', value: 10 }], worse = [{ path: 'heart_rate.trackingToleranceBpm', value: 25 }]
    const reports = [
      localReport('worse', worse, 'tuning', { default: 60, candidate: 58 }), localReport('worse', worse, 'validation', { default: 60, candidate: 59 }),
      localReport('better', better, 'tuning', { default: 60, candidate: 61.5 }), localReport('better', better, 'validation', { default: 60, candidate: 60 }),
      localReport('defaults', [], 'tuning', { default: 60, candidate: 60 }), localReport('defaults', [], 'validation', { default: 60, candidate: 60 }),
    ]
    const ranking = rankCandidates(reports)
    expect(ranking).toMatchObject({ label: 'exploratory-local', evidence: 'not_activation_evidence' })
    expect(ranking.rows.map(row => [row.rank, row.id])).toEqual([[1, 'better'], [2, 'defaults'], [3, 'worse']])
    expect(ranking.rows[0].heartRate).toEqual({ tuning: { maeDifference: -1.5, mae: 0.5, scoredNights: 1, coverageReducedNights: 0 },
      validation: { maeDifference: 0, mae: 2, scoredNights: 1, coverageReducedNights: 0 } })
    const tied = rankCandidates([localReport('b-two', [...better, { path: 'heart_rate.trackingHistoryLength', value: 8 }], 'tuning', { default: 60, candidate: 61 }),
      localReport('a-one', [...better, { path: 'hrv_index.minimumWindows', value: 10 }], 'tuning', { default: 60, candidate: 61 })])
    expect(tied.rows.map(row => [row.id, row.changedDefaults])).toEqual([['a-one', 1], ['b-two', 2]])
    expect(rankingMarkdown(ranking)).toContain('| 1 | better | 0.500 | -1.500 | 2.000 | 0.000 | 0/0 | n/a | n/a |')
  })

  it('shows holdout error alongside only when holdout nights were scored', () => {
    const overrides = [{ path: 'heart_rate.trackingToleranceBpm', value: 10 }]
    const without = rankingMarkdown(rankCandidates([localReport('tol10', overrides, 'tuning', { default: 60, candidate: 61 })]))
    expect(without).not.toContain('holdout')
    const ranking = rankCandidates([localReport('tol10', overrides, 'tuning', { default: 60, candidate: 61 }), localReport('tol10', overrides, 'holdout', { default: 60, candidate: 62 })])
    expect(ranking.rows[0].heartRate.holdout).toEqual({ maeDifference: -2, mae: 0, scoredNights: 1, coverageReducedNights: 0 })
    expect(rankingMarkdown(ranking)).toContain('| 1 | tol10 | 1.000 | -1.000 | n/a | n/a | 0.000 | -2.000 |')
  })

  it('compares local default HR error with pod results within 0.1 bpm', () => {
    const defaults = [localReport('defaults', [], 'tuning', { default: 60, candidate: 60 }), localReport('defaults', [], 'validation', { default: 60, candidate: 60 })]
    const pod = (split: string, mae: number) => ({ report: { split, datasetHash: fixture.contentHash, numericNightSummary: [{ metric: 'heart_rate', baseline: 'default', candidate: 'current',
      baselineHash: configHash(defaultConfig), candidateHash: configHash(defaultConfig),
      nights: [{ cohortId: split === 'tuning' ? 'night-a' : 'night-b', commonSupport: { baseline: { pairedCount: 5, mae } } }] }] } })
    const close = compareWithPod(defaults, [pod('tuning', 2.05), pod('validation', 2)])
    expect(close.allWithinTolerance).toBe(true)
    expect(close.rows.map(row => [row.cohortId, row.localMae, row.podMae])).toEqual([['night-a', 2, 2.05], ['night-b', 2, 2]])
    expect(compareWithPod(defaults, [pod('tuning', 2.2)]).allWithinTolerance).toBe(false)
    expect(() => compareWithPod(defaults, [pod('holdout', 2)])).toThrow('holdout is never replayed locally')
    expect(() => compareWithPod(defaults, [{ report: { ...pod('tuning', 2).report, datasetHash: 'f'.repeat(64) } }])).toThrow('different dataset')
  })
})

describe('local fit inputs', () => {
  it('replays holdout nights only when explicitly included', async () => {
    const bundle = { index: { dataset: { id: fixture.id, contentHash: fixture.contentHash } }, manifest: fixture.manifest, snapshot: fixture.snapshot, rawDirectory: fixture.rawDirectory }
    await expect(fitCandidates({ bundle: bundle as never, candidates: [{ id: 'x', overrides: [] }], outputDirectory: directory, splits: ['holdout' as never] }))
      .rejects.toThrow('Holdout nights are held back')
  })

  it('expands grids, including jointly varied axes', () => {
    const candidates = expandGrid(DEFAULT_GRID)
    expect(candidates).toHaveLength(18)
    expect(new Set(candidates.map(row => row.id)).size).toBe(18)
    expect(candidates[0]).toEqual({ id: 'tol10-hist3-brlo0.5-brhi1.5-mw10', overrides: [
      { path: 'heart_rate.trackingToleranceBpm', value: 10 }, { path: 'heart_rate.trackingHistoryLength', value: 3 },
      { path: 'breathing_rate.intervalLowerRatio', value: 0.5 }, { path: 'breathing_rate.intervalUpperRatio', value: 1.5 }, { path: 'hrv_index.minimumWindows', value: 10 }] })
    for (const candidate of candidates) expect(() => resolveConfig(candidate.overrides as never)).not.toThrow()
    expect(() => expandGrid({ 'a,b': [[1]] })).toThrow('needs 2 values')
  })

  it('keeps grid ids distinct and valid for signed, repeated and long values', () => {
    const ids = expandGrid({ 'heart_rate.trackingToleranceBpm': [-1, 1], 'a/b.c d': ['x y'] }).map(row => row.id)
    expect(ids).toEqual(['tolm1-c_dx_y', 'tol1-c_dx_y'])
    const long = expandGrid({ 'heart_rate.trackingToleranceBpm': ['a'.repeat(90), `${'a'.repeat(90)}b`] }).map(row => row.id)
    expect(new Set(long).size).toBe(2)
    expect(long.every(id => id.length <= 80)).toBe(true)
  })

  it('rejects candidate ids that would collide with runner output paths', () => {
    for (const id of ['.', '..', 'work', 'bundle', 'readings', 'ranking.json', 'run.json', '-x']) {
      expect(() => candidateFileSchema.parse([{ id, overrides: [] }]), id).toThrow()
    }
    expect(candidateFileSchema.parse([{ id: 'tol10.v2', overrides: [] }])).toHaveLength(1)
  })

  it('refuses a bundle stored where the runner extracts it', async () => {
    const out = join(directory, 'self')
    mkdirSync(out)
    writeFileSync(join(out, 'bundle'), 'not a tar')
    writeFileSync(join(out, 'candidates.json'), JSON.stringify([{ id: 'x', overrides: [] }]))
    await expect(runLocalFitCli(['fit', join(out, 'bundle'), join(out, 'candidates.json'), out])).rejects.toThrow('cannot live inside')
  })
})
