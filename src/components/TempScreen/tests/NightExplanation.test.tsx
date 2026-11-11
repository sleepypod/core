import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { NightExplanation } from '../NightExplanation'
import type { NightExplanation as NightReport } from '@/src/night/contract'

const mock = vi.hoisted(() => ({ now: Date.parse('2026-11-10T20:00Z'), page: {} as NightReport, failed: false, fetching: false, refresh: vi.fn(), query: vi.fn() }))
vi.mock('../TonightCard', () => ({ useNow: () => new Date(mock.now) }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { device: { nightExplanation: { useQuery: (input: unknown, options: unknown) => {
  mock.query(input, options)
  return { data: mock.page, isError: mock.failed, isFetching: mock.fetching, refetch: mock.refresh }
} } } } }))
beforeEach(() => {
  vi.clearAllMocks()
  mock.failed = false
  mock.fetching = false
  mock.page = { apiVersion: 1, generatedAt: mock.now, side: 'left', wakeDate: '2026-11-10', timeZone: 'UTC',
    start: Date.parse('2026-11-09T12:00Z'), end: Date.parse('2026-11-10T12:00Z'), observedThrough: Date.parse('2026-11-10T12:00Z'),
    attribution: 'physical_zone_only', eventsTruncated: false, thermal: [], room: [], roomSampleIntervalMs: 300_000, roomTruncated: false,
    sources: (['applications', 'decisions', 'rules', 'thermal', 'room'] as const).map(key => ({ key, status: 'empty', rowsRead: 0, discarded: 0, truncated: false, note: 'Synthetic empty source.' })),
    events: [{ id: 'decision:1', source: 'decisions', at: Date.parse('2026-11-10T01:00Z'), through: Date.parse('2026-11-10T01:01Z'), count: 2,
      scope: 'left', kind: 'withheld', title: 'Personal adaptation held back', detail: 'Manual hold takes priority.', targetF: 68, reportedF: 70, owner: 'manual', evidence: 'policy_evaluation' }],
  }
})
afterEach(cleanup)
it('explains retained policy evidence without turning it into a physical action', () => {
  const view = render(<NightExplanation side="left" unit="F" />)
  expect(view.getByText(/Personal adaptation held back/)).toBeTruthy()
  expect(view.getByText('Manual hold takes priority.')).toBeTruthy()
  expect(view.getByText(/matching recorded evaluations/).textContent).toContain('not continuous')
  expect(view.getByText(/A zone does not identify a sleeper/)).toBeTruthy()
  fireEvent.change(view.getByLabelText('Event source'), { target: { value: 'applications' } })
  expect(view.queryByText('Manual hold takes priority.')).toBeNull()
  expect(view.getByText(/No retained events/)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Refresh night', hidden: true }))
  expect(mock.refresh).toHaveBeenCalledTimes(1)
})
it.each(['failed', 'future', 'expired', 'wrong-side', 'wrong-date', 'invalid'] as const)('withholds %s evidence instead of mislabelling a different snapshot', (condition) => {
  if (condition === 'failed') mock.failed = true
  if (condition === 'future') mock.page.generatedAt += 1
  if (condition === 'expired') mock.page.generatedAt -= 300_000
  if (condition === 'wrong-side') mock.page.side = 'right'
  if (condition === 'invalid') mock.page.attribution = 'person' as NightReport['attribution']
  const view = render(<NightExplanation side="left" unit="C" />)
  if (condition === 'wrong-date') fireEvent.change(view.getByLabelText('Wake date'), { target: { value: '2026-11-09' } })
  expect(view.queryByText('Manual hold takes priority.')).toBeNull()
  expect(view.getByText(/Night evidence is unavailable or out of date/)).toBeTruthy()
})
it('does not invent a new measurement clock for cached room reports', () => {
  mock.page.room = [{ id: 1, sourceId: 'room', revision: 1, label: 'Bedside HomePod', metric: 'temperature', value: 68, unit: '°F',
    receivedAt: mock.page.start + 10_000, observedAt: mock.page.start + 9000, measuredAt: null, timeBasis: 'cached' }]
  const view = render(<NightExplanation side="left" unit="C" />)
  expect(view.getByText(/Bedside HomePod: 20°C/)).toBeTruthy()
  expect(view.getByText(/measurement time not supplied/).textContent).toContain('cached')
})

it('draws temperature lines without filling across their recorded samples', () => {
  mock.page.thermal = [
    { id: 1, at: mock.page.start, powered: true, targetF: 70, reportedF: 72 },
    { id: 2, at: mock.page.start + 60_000, powered: true, targetF: 70, reportedF: 71 },
  ]
  const view = render(<NightExplanation side="left" unit="F" />)
  const lines = view.container.querySelectorAll('polyline')
  expect(lines).toHaveLength(2)
  for (const line of lines) {
    expect(line.getAttribute('fill')).toBe('none')
    expect(line.getAttribute('class')).not.toContain('fill-current')
  }
})
