import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { defaultConfig } from '@/src/biometrics/algorithms/registry-core'
import { BiometricCalibration } from '../BiometricCalibration'

const HASH = 'a4f2'.padEnd(62, '0') + '9c'
const mock = vi.hoisted(() => ({
  now: 0,
  overview: undefined as unknown,
  overviewError: null as Error | null,
  revisions: {} as Record<string, unknown>,
  status: undefined as unknown,
  history: { items: [] as unknown[], nextGeneration: null },
  jobs: [] as unknown[],
  summaries: [] as unknown[],
  datasets: [] as unknown[],
  imports: [] as unknown[],
  experiments: [] as unknown[],
  legacy: 0,
  diffData: undefined as unknown,
  traces: {} as Record<string, unknown>,
  referenceTrace: undefined as unknown,
  create: vi.fn(),
  activate: vi.fn(),
  enqueue: vi.fn(),
  diff: vi.fn(),
  reset: vi.fn(),
  rollback: vi.fn(),
  sideChange: vi.fn(),
}))
vi.mock('@/src/utils/trpc', () => {
  const query = (data: () => unknown) => ({ useQuery: () => ({ data: data(), error: null }) })
  const mutation = (fn: (input: unknown) => unknown, data: () => unknown = () => undefined) => ({ useMutation: () => ({ mutateAsync: async (input: unknown) => fn(input), mutate: fn, isPending: false, error: null, data: data() }) })
  return { trpc: {
    useUtils: () => new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate: vi.fn() }) }) }),
    useQueries: () => mock.summaries.map(data => ({ data })),
    settings: { getAll: query(() => ({ device: { timezone: 'UTC' }, sides: { left: { name: 'Alex' }, right: { name: 'Sam' } } })) },
    biometricTuning: {
      getProfileOverview: { useQuery: () => ({ data: mock.overview, error: mock.overviewError }) },
      getProfileRevision: { useQuery: ({ id }: { id: string }) => ({ data: mock.revisions[id], error: null }) },
      getActivationStatus: query(() => mock.status),
      listActivationHistory: query(() => mock.history),
      listProfileRevisions: query(() => ({ items: Object.values(mock.revisions), nextCursor: null })),
      listBacktests: query(() => ({ items: mock.jobs, nextCursor: null })),
      listDatasets: query(() => ({ items: mock.datasets, nextCursor: null })),
      listImports: query(() => ({ items: mock.imports, nextCursor: null })),
      listExperiments: query(() => ({ items: mock.experiments, nextCursor: null })),
      countLegacyReferences: query(() => ({ vitals: mock.legacy, stages: 0 })),
      getDataset: query(() => undefined),
      getBacktestNumericTrace: { useQuery: ({ configuration }: { configuration: string }) => ({ data: mock.traces[configuration], error: null }) },
      getBacktestReferenceTrace: query(() => mock.referenceTrace),
      createProfileRevision: mutation(mock.create),
      activateProfile: mutation(mock.activate),
      enqueueBacktest: mutation(mock.enqueue),
      diffProfileRevision: mutation(mock.diff, () => mock.diffData),
      resetProfile: mutation(mock.reset),
      rollbackProfile: mutation(mock.rollback),
    },
  } }
})
vi.mock('next/navigation', () => ({ usePathname: () => '/en/settings' }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '12h' }))
vi.mock('../ProfileLibrary', () => ({ ProfileLibrary: ({ side }: { side: string }) => <p>{`Revision library ${side}`}</p> }))
vi.mock('../ShadowRuns', () => ({ ShadowRuns: ({ side }: { side: string }) => <p>{`Prospective runs ${side}`}</p> }))
vi.mock('../CalibrationReferences', () => ({ CalibrationReferences: () => <p>Reference import</p> }))
vi.mock('../ReferenceLibrary', () => ({ ReferenceLibrary: () => null }))
vi.mock('../CalibrationBacktests', () => ({ CalibrationBacktests: () => <p>Dataset builder</p> }))
vi.mock('../WatchDeviationTrend', () => ({ WatchDeviationTrend: ({ side }: { side: string }) => <p>{`Watch deviation ${side}`}</p> }))

const i18n = setupI18n({ locale: 'en', messages: {} })
const view = (side: 'left' | 'right' = 'left') => <I18nProvider i18n={i18n}><BiometricCalibration side={side} onSideChange={mock.sideChange} /></I18nProvider>
const min = 60_000
const window = (mae: number) => ({ startMs: 0, endMs: 1, observationCount: 10, numeric: [{ metric: 'heart_rate', status: 'compared', metrics: { mae, medianAbsoluteError: mae, p95AbsoluteError: mae, signedBias: 0 },
  pairedCount: 10, referenceCoverage: 1, outputCoverage: 0.9, unmatchedReferences: 0, unmatchedObservations: 0, exclusions: {} }] })
const night = (cohortId: string, previous: number, saved: number) => ({ cohortId, evaluations: [
  { label: 'current', configHash: 'h-current', windows: [window(previous)] },
  { label: 'candidate', configHash: 'h-saved', windows: [window(saved)] },
] })

beforeEach(() => {
  vi.clearAllMocks()
  mock.now = Date.now()
  mock.experiments = []
  mock.legacy = 0
  const saved = structuredClone(defaultConfig)
  saved.heart_rate.trackingToleranceBpm = 12
  mock.overviewError = null
  mock.overview = { desired: { binding: { side: 'left', generation: 3, desiredRevisionId: 'saved-id', previousRevisionId: null, updatedAtMs: mock.now - 14 * min },
    resolved: saved, hash: HASH, isDefault: false, warning: null }, runtimeStatus: 'receipts_available', sensorCalibration: [] }
  mock.revisions = { 'saved-id': { id: 'saved-id', side: 'left', origin: 'agent', requester: 'tuner', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 12 }],
    resolved: saved, resolvedHash: 'h-saved', createdAtMs: mock.now - 16 * min } }
  const event = { id: 'event', side: 'left', generation: 3, action: 'activate', previousRevisionId: null, nextRevisionId: 'saved-id', previousHash: 'h-default', nextHash: 'h-saved',
    requester: 'tuner', state: 'pending_boundary', reason: null, createdAtMs: mock.now - 14 * min, updatedAtMs: mock.now - 14 * min }
  mock.status = { desiredGeneration: 3, isCurrent: true, event, observedState: 'pending_boundary' }
  mock.history = { items: [event], nextGeneration: null }
  const configurations = [{ label: 'default', revisionId: null, hash: 'h-default' }, { label: 'current', revisionId: null, hash: 'h-current' }, { label: 'candidate', revisionId: 'saved-id', hash: 'h-saved' }]
  mock.jobs = [
    { id: 'b42a-tuning', experimentId: 'exp', datasetId: 'ds', split: 'tuning', state: 'succeeded', createdAtMs: mock.now - 15 * min, updatedAtMs: mock.now - 15 * min + 38_000, configurations, evaluationScope: 'original_readings_comparison', error: null },
    { id: 'b42b-holdout', experimentId: 'exp', datasetId: 'ds', split: 'holdout', state: 'succeeded', createdAtMs: mock.now - 15 * min, updatedAtMs: mock.now - 15 * min + 30_000, configurations, evaluationScope: 'original_readings_comparison', error: null },
  ]
  mock.summaries = [
    { contentHash: 'c1', available: true, report: { nights: [night('2026-10-10', 3.1, 2.4), night('2026-10-11', 2.9, 2.2)] } },
    { contentHash: 'c2', available: true, report: { nights: [night('2026-10-12', 3.4, 2.6)] } },
  ]
  mock.datasets = [{ id: 'ds', side: 'left', available: true, createdAtMs: Date.UTC(2026, 9, 12), byteLength: 2.1 * 1024 * 1024, manifest: { splitProtocol: { assignments: [
    { cohortId: '2026-10-10', split: 'tuning', startMs: 1, endMs: 2, nightLabels: [], sessionIds: [1] },
    { cohortId: '2026-10-11', split: 'tuning', startMs: 3, endMs: 4, nightLabels: [], sessionIds: [2] },
    { cohortId: '2026-10-12', split: 'holdout', startMs: 5, endMs: 6, nightLabels: [], sessionIds: [3] },
  ] } } }]
  mock.imports = [{ id: 'imp', available: true, createdAtMs: mock.now - 2 * 86_400_000, summary: { source: 'watch', startMs: 0, endMs: 10, accepted: 120 } }]
  mock.create.mockResolvedValue({ id: 'new-id', resolvedHash: 'n'.repeat(64) })
  mock.activate.mockResolvedValue({ id: 'event-2', generation: 4 })
  mock.diff.mockImplementation(() => undefined)
  mock.diffData = undefined
  mock.traces = {}
  mock.referenceTrace = undefined
})

it('shows who saved what, that it is still waiting, and what the processor runs', () => {
  render(view())
  const strip = screen.getByRole('group', { name: 'Profile lifecycle' })
  expect(within(strip).getByText('by tuner · 16 min ago')).toBeTruthy()
  expect(within(strip).getByText('waiting 14 min')).toBeTruthy()
  expect(within(strip).getByText('running system defaults')).toBeTruthy()
  expect(screen.getByText('trackingToleranceBpm · previous: 15 · range 5–30')).toBeTruthy()
  expect(screen.getByText(/window IBI variability, not clinical RMSSD/)).toBeTruthy()
  expect(screen.getByText('Measured sensor calibration for this side:', { exact: false })).toBeTruthy()
  expect(screen.getByText('Watch deviation left')).toBeTruthy()
  expect(screen.getByText('a4f2…9c')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Keep saved profile' }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByText('Nothing changes until you move a control or restore.')).toBeTruthy()
})

it('reads the backtest per night and per split, with holdout the one to trust', () => {
  render(view())
  expect(screen.getByText('done · 38 s')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Mon 12: previous 3.4, saved 2.6 bpm' })).toBeTruthy()
  expect(screen.getByText('HR error · holdout')).toBeTruthy()
  expect(screen.getAllByText('3.4').length).toBeGreaterThan(0)
  expect(screen.getByText('frozen Oct 12 · 2.1 MB')).toBeTruthy()
  expect(screen.getAllByText('watch').length).toBe(3)
  expect(screen.getByText('holdout −0.8 bpm · covered 90%')).toBeTruthy()
  expect(screen.getAllByText('unchanged').length).toBe(4)
  const nights = screen.getByRole('listbox', { name: 'Dataset nights' })
  fireEvent.click(within(nights).getByRole('option', { name: /Sat 10/ }))
  expect(within(nights).getByRole('option', { name: /Sat 10/ }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByText(/compared stored readings/)).toBeTruthy()
})

it('lists agent and pod activity newest first', () => {
  render(view())
  const activity = screen.getByText('Activity').closest('div')?.parentElement as HTMLElement
  const items = within(activity).getAllByRole('listitem').map(li => li.textContent)
  expect(items[0]).toContain('Requested activation · generation 3')
  expect(items.some(text => text?.includes('tuner Saved the profile') && text.includes('trackingToleranceBpm 15 → 12'))).toBe(true)
  expect(items.some(text => text?.includes('Finished a backtest on holdout nights') && text.includes('holdout HR error 3.4 → 2.6 bpm'))).toBe(true)
})

it('saves a moved control as a new revision, requests it, and re-runs every split in the dataset', async () => {
  render(view())
  fireEvent.change(screen.getByLabelText('Minimum IBI windows'), { target: { value: '14' } })
  expect(screen.getByText('tested on save')).toBeTruthy()
  expect(screen.getByText('Overwrites the saved profile and requests it; the current one becomes previous.')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save and request' }))
  })
  expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({ side: 'left', parentRevisionId: 'saved-id', origin: 'manual', requester: 'web-calibration',
    overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 12 }, { path: 'hrv_index.minimumWindows', value: 14 }] }))
  expect(mock.activate).toHaveBeenCalledWith(expect.objectContaining({ revisionId: 'new-id', expectedGeneration: 3, expectedResolvedHash: 'n'.repeat(64), boundary: 'next_session', allowUnvalidated: true }))
  expect(mock.enqueue.mock.calls.map(([input]) => [input.split, input.experimentId, input.expectedBindingGeneration, input.candidateRevisionId])).toEqual([['tuning', 'exp', 4, 'new-id'], ['holdout', 'exp', 4, 'new-id']])
})

it('uses a replay set up on the dataset when no job has run yet, and says what is missing otherwise', async () => {
  mock.jobs = []
  mock.summaries = []
  const result = render(view())
  expect(screen.getByText(/This dataset has no waveform replay/)).toBeTruthy()
  mock.experiments = [{ id: 'exp-stored', datasetId: 'other', protocol: { mode: 'signal_replay' } }, { id: 'exp-cmp', datasetId: 'ds', protocol: { mode: 'comparison' } },
    { id: 'exp-wave', datasetId: 'ds', protocol: { mode: 'signal_replay' } }]
  result.rerender(view())
  expect(screen.getByText(/replays the frozen dataset on its tuning, validation and holdout nights/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Minimum IBI windows'), { target: { value: '14' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save and request' }))
  })
  expect(mock.enqueue.mock.calls.map(([input]) => [input.split, input.experimentId])).toEqual([['tuning', 'exp-wave'], ['holdout', 'exp-wave']])
})

it('reviews a restore before requesting system defaults', async () => {
  const result = render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Restore… ▾' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'System defaults' }))
  expect(mock.diff).toHaveBeenCalledWith({ side: 'left', revisionId: null, againstRevisionId: 'saved-id' })
  expect(screen.getByRole('dialog', { name: 'Restore system defaults' })).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Restore and request' }) as HTMLButtonElement).disabled).toBe(true)
  result.unmount()
})

it('opens workbench views from the page and returns', () => {
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Import reference' }))
  expect(screen.getByText('Reference import')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Backtests' }))
  expect(screen.getByText('Dataset builder')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Observations' }))
  expect(screen.getByText('Prospective runs left')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Profiles' }))
  expect(screen.getByText('Revision library left')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Calibration' }))
  expect(screen.getByRole('group', { name: 'Profile lifecycle' })).toBeTruthy()
})

it('shows loading or errors without substituting a healthy state', () => {
  mock.overview = undefined
  const result = render(view())
  expect(screen.queryByRole('group', { name: 'Profile lifecycle' })).toBeNull()
  mock.overviewError = new Error('Processor data unavailable')
  result.rerender(view())
  expect(screen.getByText('Processor data unavailable')).toBeTruthy()
})

it('confirms a reviewed restore of the previous profile with the reviewed hash', async () => {
  mock.overview = { ...(mock.overview as object), desired: { ...(mock.overview as { desired: object }).desired,
    binding: { side: 'left', generation: 3, desiredRevisionId: 'saved-id', previousRevisionId: 'saved-id', updatedAtMs: mock.now } } }
  mock.diffData = { afterHash: 'p'.repeat(64), changes: [{ path: 'heart_rate.trackingToleranceBpm', before: 12, after: 15 }, { path: 'sleep_stages.ruleset.fallback', before: 'deep', after: 'light' }] }
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Restore previous' }))
  const dialog = screen.getByRole('dialog', { name: 'Restore the previous profile' })
  expect(within(dialog).getByText('heart_rate.trackingToleranceBpm')).toBeTruthy()
  expect(within(dialog).getByText('12 → 15')).toBeTruthy()
  expect(within(dialog).getByText('1 sleep-stage values')).toBeTruthy()
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore and request' }))
  })
  expect(mock.rollback).toHaveBeenCalledWith(expect.objectContaining({ side: 'left', revisionId: 'saved-id', expectedGeneration: 3,
    expectedResolvedHash: 'p'.repeat(64), boundary: 'next_session', allowUnvalidated: true }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('restores defaults from the menu and says when nothing would change', async () => {
  mock.diffData = { afterHash: 'd'.repeat(64), changes: [] }
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Restore… ▾' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Restore… ▾' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'System defaults' }))
  expect(screen.getByText('Identical to the saved profile; restoring only re-requests it.')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Restore and request' }))
  })
  expect(mock.reset).toHaveBeenCalledWith(expect.objectContaining({ expectedResolvedHash: 'd'.repeat(64), expectedGeneration: 3 }))
  fireEvent.click(screen.getByRole('button', { name: 'Restore… ▾' }))
  fireEvent.mouseDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
})

it('draws the selected night from recomputed and reference traces', () => {
  for (const job of mock.jobs as Array<{ evaluationScope: string }>) job.evaluationScope = 'retained_waveform_replay'
  const at = (minutes: number) => Date.UTC(2026, 9, 12, 7) + minutes * min
  const readings = (bpm: number) => ({ items: [0, 1, 2, 30].map(m => ({ timestampMs: at(m), heartRate: bpm, side: 'left', qualityScore: 0.84 })), nextCursor: null })
  mock.traces = { candidate: readings(62), current: readings(66) }
  mock.referenceTrace = { items: [{ startMs: at(0), value: 61, compatibility: null }, { startMs: at(1), value: null, compatibility: 'unscorable' }], nextCursor: { offset: 500 } }
  const assignments = (mock.datasets[0] as { manifest: { splitProtocol: { assignments: Array<{ startMs: number, endMs: number }> } } }).manifest.splitProtocol.assignments
  for (const a of assignments) Object.assign(a, { startMs: at(-45), endMs: at(8 * 60) })
  ;(mock.imports[0] as { summary: object }).summary = { source: 'watch', startMs: at(-60), endMs: at(9 * 60), accepted: 1 }
  const { container } = render(view())
  expect(screen.getByText('Heart rate · Mon 12')).toBeTruthy()
  expect(screen.getByText('watch · quality 0.84')).toBeTruthy()
  expect(screen.getByText('first 500 readings')).toBeTruthy()
  const paths = [...container.querySelectorAll('svg[aria-label="Heart-rate trace"] path')].map(p => p.getAttribute('d'))
  expect(paths.every(d => d && d.startsWith('M'))).toBe(true)
  expect(screen.getByText('6:15a')).toBeTruthy()
})

it('explains missing evidence instead of drawing empty charts', () => {
  mock.jobs = []
  mock.summaries = []
  mock.datasets = []
  mock.imports = []
  mock.history = { items: [], nextGeneration: null }
  mock.revisions = {}
  mock.overview = { ...(mock.overview as object), desired: { ...(mock.overview as { desired: object }).desired,
    binding: { side: 'left', generation: 0, desiredRevisionId: null, previousRevisionId: null, updatedAtMs: 0 } }, runtimeStatus: 'unreported',
  sensorCalibration: [{ id: 1, sensorType: 'piezo', status: 'completed', freshness: 'expired' }] }
  mock.status = { desiredGeneration: 0, isCurrent: false, event: null, observedState: 'unreported' }
  const result = render(view())
  expect(screen.getByText(/No backtest yet. Import a reference for this side/)).toBeTruthy()
  expect(screen.getByText('not run')).toBeTruthy()
  expect(screen.getByText(/with no overrides/)).toBeTruthy()
  expect(screen.getByText(/No dataset is frozen for this side yet/)).toBeTruthy()
  expect(screen.getByText('Nothing has happened on this side yet.')).toBeTruthy()
  expect(screen.getByText('piezo expired')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Restore previous' }) as HTMLButtonElement).disabled).toBe(true)
  const strip = screen.getByRole('group', { name: 'Profile lifecycle' })
  expect(within(strip).getByText('not reported')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'show' }))
  expect(screen.getByText(HASH)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'hide' }))
  expect(screen.getByText('a4f2…9c')).toBeTruthy()
  mock.legacy = 1597
  result.rerender(view())
  expect(screen.getByText(/No backtest yet. Freeze a new dataset below/)).toBeTruthy()
})

it('reports in-flight and failed runs and pages through long activity', () => {
  ;(mock.jobs[0] as { state: string }).state = 'running'
  const extra = Array.from({ length: 6 }, (_, i) => ({ id: `ds-${i}`, side: 'left', available: true, createdAtMs: mock.now - (i + 2) * 86_400_000, byteLength: 10,
    manifest: { splitProtocol: { assignments: [] } } }))
  mock.datasets = [...mock.datasets, ...extra]
  const result = render(view())
  expect(screen.getByText('running')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Show all \d+/ }))
  expect(screen.getByRole('button', { name: 'Show recent' })).toBeTruthy()
  ;(mock.jobs[0] as { state: string }).state = 'failed'
  ;(mock.jobs[0] as { error: string }).error = 'Worker exited'
  result.rerender(view())
  expect(screen.getAllByText('failed').length).toBeGreaterThan(0)
  expect(screen.getByText('Worker exited')).toBeTruthy()
  ;(mock.jobs[0] as { state: string }).state = 'queued'
  result.rerender(view())
  expect(screen.getByText('queued')).toBeTruthy()
})

it('surfaces a failed save without losing the edit', async () => {
  mock.create.mockRejectedValue(new Error('STALE_BINDING: inspect the current profile'))
  render(view())
  fireEvent.change(screen.getByLabelText('Tracking history length'), { target: { value: '7' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save and request' }))
  })
  expect(screen.getByText('STALE_BINDING: inspect the current profile')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save and request' })).toBeTruthy()
  expect(mock.activate).not.toHaveBeenCalled()
})

it('edits both breathing cut-offs on one axis, each kept inside its own range', () => {
  render(view())
  const shortest = screen.getByLabelText('Shortest breathing interval (× median)') as HTMLInputElement
  const longest = screen.getByLabelText('Longest breathing interval (× median)') as HTMLInputElement
  expect([shortest.min, shortest.max, longest.min, longest.max]).toEqual(['0.25', '2', '0.25', '2'])
  fireEvent.change(shortest, { target: { value: '1.4' } })
  fireEvent.change(longest, { target: { value: '0.6' } })
  expect(screen.getByText('0.9×')).toBeTruthy()
  expect(screen.getByText('1.1×')).toBeTruthy()
  expect(screen.getByText('1×')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save and request' })).toBeTruthy()
})
