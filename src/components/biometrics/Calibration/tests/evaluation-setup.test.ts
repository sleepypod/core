import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { chooseSessions, nightKey, nightsTouched, useEvaluationSetup, WAVEFORM_PROTOCOL } from '../evaluation-setup'

const H = 3600_000
const night = (day: number) => Date.UTC(2026, 9, day, 6) // 11 PM Pacific
interface Call { query: ReturnType<typeof vi.fn>, mutate: ReturnType<typeof vi.fn> }
const holder = vi.hoisted(() => ({ api: {} as Record<string, Call> }))
const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@/src/utils/trpc', () => ({ trpc: { useUtils: () => ({ client: { biometricTuning: holder.api }, biometricTuning: { invalidate } }) } }))

const source = (name: string, first: number, last: number, ordered = true) => ({ id: `id-${name}`, unavailableAtMs: null,
  inspection: { source_name: name, inventory: { first_event_ms: first, last_event_ms: last, ordered_waveform_available: ordered } } })
const cohort = (day: number, split: string) => ({ cohortId: `2026-10-${day}`, startMs: night(day), endMs: night(day) + 8 * H, split, nightLabels: [], sessionIds: [day] })

beforeEach(() => {
  vi.clearAllMocks()
  const q = (fn: (input: never) => unknown): Call => ({ query: vi.fn(async (input: never) => fn(input)), mutate: vi.fn() })
  const m = (fn: (input: never) => unknown): Call => ({ query: vi.fn(), mutate: vi.fn(async (input: never) => fn(input)) })
  holder.api = {
    countLegacyReferences: q(() => ({ vitals: 1597, stages: 0 })),
    linkLegacyReferences: m(() => ({ vitals: 1597, stages: 0, imports: 1 })),
    listImports: q(() => ({ items: [
      { id: 'ref', available: true, summary: { subjectId: 'legacy_unknown:left', startMs: night(9), endMs: night(14) } },
      { id: 'stale', available: false, summary: { subjectId: 'legacy_unknown:left', startMs: 0, endMs: 1 } },
    ], nextCursor: null })),
    listSessions: q(() => ({ items: [11, 12, 13].map(day => ({ id: day, startMs: night(day), endMs: night(day) + 8 * H, sleepDurationSeconds: 8 * 3600 })), nextCursor: null })),
    locateRawArchives: q(({ startMs }: { startMs: number }) => startMs < night(12) - H ? [] : [{ name: startMs < night(13) - H ? 'known' : 'fresh', afterName: 'prev.RAW.gz' }]),
    createDataset: m(() => ({ id: 'ds', contentHash: 'c'.repeat(64), manifest: { splitProtocol: { assignments: [cohort(12, 'tuning'), cohort(13, 'holdout')] } } })),
    listRawSources: q(({ startMs }: { startMs: number }) => ({ items: startMs < night(13) - H ? [source('known', night(12) - 10 * 60_000, night(12) + 9 * H)] : [], nextCursor: null })),
    inspectRawSource: m(() => ({ status: 'inspected', nextCursor: 'x', source: source('fresh', night(13) - 4 * 60_000, night(13) + 9 * H) })),
    createWaveformDataset: m(() => ({ status: 'published', dataset: { id: 'wave', manifest: { splitProtocol: { assignments: [cohort(12, 'tuning'), cohort(13, 'holdout')] } } } })),
    createExperiment: m(() => ({ id: 'exp' })),
    createProfileRevision: m(() => ({ id: 'defaults-rev' })),
    enqueueBacktest: m(() => ({ id: 'job' })),
  }
})

it('groups sessions after midnight with the evening before, in the device timezone', () => {
  expect(nightKey(Date.UTC(2026, 9, 12, 9), 'America/Los_Angeles')).toBe('2026-10-11')
  expect(nightKey(Date.UTC(2026, 9, 12, 9), 'Not/AZone')).toBe('2026-10-11')
})

it('chooses one session per noon-to-noon night, newest nights first and the main sleep over a nap', () => {
  const tz = 'America/Los_Angeles'
  const sessions = [
    { id: 1, startMs: night(10), endMs: night(10) + 8 * H, sleepDurationSeconds: 28800 },
    { id: 2, startMs: night(11), endMs: night(11) + 8 * H, sleepDurationSeconds: 28800 },
    { id: 3, startMs: night(11) + 9 * H, endMs: night(11) + 10 * H, sleepDurationSeconds: 3600 },
    { id: 4, startMs: night(12), endMs: night(12) + 1 * H, sleepDurationSeconds: 600 },
    { id: 5, startMs: night(13), endMs: night(13) + 8 * H, sleepDurationSeconds: 28800 },
  ]
  expect(chooseSessions(sessions, [{ startMs: night(11), endMs: night(14) }], 2, tz).map(s => s.id)).toEqual([2, 5])
  expect(chooseSessions(sessions, [], 2, 'UTC')).toEqual([])
  // Sleeping past noon touches the next night, which then belongs to that session alone.
  const late = [
    { id: 6, startMs: night(10), endMs: night(10) + 14 * H, sleepDurationSeconds: 50400 },
    { id: 7, startMs: night(11), endMs: night(11) + 8 * H, sleepDurationSeconds: 28800 },
    { id: 8, startMs: night(12), endMs: night(12) + 16 * H, sleepDurationSeconds: 57600 },
  ]
  expect([...nightsTouched(night(10), night(10) + 14 * H, tz)]).toEqual(['2026-10-09', '2026-10-10'])
  expect(chooseSessions(late, [{ startMs: 0, endMs: night(14) }], 7, tz).map(s => s.id)).toEqual([7])
})

it('links, freezes referenced nights with archives, inspects only new archives, retains, and queues every split', async () => {
  const { result } = renderHook(() => useEvaluationSetup({ side: 'left', timezone: 'America/Los_Angeles', savedRevisionId: null, generation: 0 }))
  act(() => result.current.run())
  await waitFor(() => expect(result.current.progress.step).toBe('done'))
  expect(holder.api.linkLegacyReferences.mutate).toHaveBeenCalledWith({ side: 'left' })
  const dataset = holder.api.createDataset.mutate.mock.calls[0][0]
  expect(dataset).toMatchObject({ side: 'left', subjectId: 'legacy_unknown:left', sessionIds: [12, 13], referenceImportIds: ['ref'] })
  expect(holder.api.inspectRawSource.mutate).toHaveBeenCalledTimes(1)
  expect(holder.api.createWaveformDataset.mutate.mock.calls[0][0]).toMatchObject({ parentDatasetId: 'ds',
    cohorts: [{ cohortId: '2026-10-12', sourceIds: ['id-known'] }, { cohortId: '2026-10-13', sourceIds: ['id-fresh'] }] })
  expect(holder.api.createExperiment.mutate.mock.calls[0][0]).toMatchObject({ datasetId: 'wave', protocol: WAVEFORM_PROTOCOL })
  expect(holder.api.createProfileRevision.mutate.mock.calls[0][0]).toMatchObject({ side: 'left', overrides: [] })
  expect(holder.api.enqueueBacktest.mutate.mock.calls.map(([input]) => [input.split, input.candidateRevisionId, input.expectedBindingGeneration]))
    .toEqual([['tuning', 'defaults-rev', 0], ['holdout', 'defaults-rev', 0]])
  expect(invalidate).toHaveBeenCalled()
})

it('waits out deferred archive work and reports what is missing instead of half-freezing', async () => {
  let calls = 0
  holder.api.inspectRawSource.mutate = vi.fn(async () => (++calls === 1 ? { status: 'deferred', nextCursor: null } : { status: 'source_unavailable', nextCursor: 'x' }))
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const { result } = renderHook(() => useEvaluationSetup({ side: 'left', timezone: 'UTC', savedRevisionId: 'saved', generation: 3 }))
  act(() => result.current.run())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000)
  })
  vi.useRealTimers()
  await waitFor(() => expect(result.current.progress.step).toBe('failed'))
  expect(calls).toBe(2)
  expect(result.current.progress.error).toMatch(/no readable RAW archive/)
  expect(holder.api.createWaveformDataset.mutate).not.toHaveBeenCalled()

  holder.api.listImports.query = vi.fn(async () => ({ items: [], nextCursor: null }))
  act(() => result.current.run())
  await waitFor(() => expect(result.current.progress.error).toBe('Import a reference for this side first.'))
})
