import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { changeMarkers, deviationScale, WatchDeviationTrend } from '../WatchDeviationTrend'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 18, 12)
const mock = vi.hoisted(() => ({
  data: undefined as unknown,
  error: null as Error | null,
  input: undefined as unknown,
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    biometrics: {
      compareToWatch: {
        useQuery: (input: unknown) => {
          mock.input = input
          return { data: mock.data, error: mock.error }
        },
      },
    },
  },
}))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ sideName: (side: string) => side === 'left' ? 'Alex' : 'Sam' }) }))
vi.mock('../../WatchUpload', () => ({ WatchUpload: ({ name }: { name: string }) => <button type="button">{`Upload Apple Watch data for ${name}`}</button> }))

const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><WatchDeviationTrend side="left" timezone="UTC" /></I18nProvider>

const none = { n: 0, watchSamples: 0, coverage: null, mae: null, bias: null, p90: null, r: null }
const dev = (mae: number | null, bias: number | null) => mae === null ? none : { n: 10, watchSamples: 12, coverage: 0.83, mae, bias, p90: mae + 1, r: 0.5 }
const stages = (kappa: number | null) => ({ epochs: 90, accuracy: 0.6, kappa, recall: { wake: null, light: 0.7, deep: 0.4, rem: 0.3 },
  podMinutes: { wake: 30, light: 250, deep: 80, rem: 90 }, watchMinutes: { wake: 20, light: 240, deep: 90, rem: 100 } })
/** A night entered `daysAgo` days before NOW at 23:00 UTC the evening before. */
function night(id: number, daysAgo: number, hr: [number | null, number | null], kappa: number | null = 0.4) {
  const enteredBedAt = new Date(NOW - daysAgo * DAY - 13 * 60 * 60 * 1000)
  return { sleepRecordId: id, enteredBedAt, leftBedAt: new Date(enteredBedAt.getTime() + 8 * 3_600_000), hours: 8,
    heartRate: dev(...hr), breathingRate: dev(1.2, 0.8), hrv: dev(18, -12), stages: kappa === null ? null : stages(kappa) }
}
function report(nights: ReturnType<typeof night>[], configChanges: Array<{ generation: number, atMs: number }> = []) {
  return { side: 'left', startDate: new Date(NOW - 31 * DAY), endDate: new Date(NOW), minHours: 3,
    classifier: { isDefault: true, source: 'default', generation: null, stageHash: 'h' },
    hrvNote: 'HRV deviation is not like-for-like yet: SDNN vs an IBI index.', nights, summary: {}, configChanges }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  mock.data = undefined
  mock.error = null
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('asks for the last 31 days and renders nothing while they load', () => {
  const { container } = render(view())
  expect(container.textContent).toBe('')
  expect(mock.input).toEqual({ side: 'left', startDate: new Date(NOW - 31 * DAY), endDate: new Date(NOW) })
})

it('shows only an upload hint when no night pairs with the Watch', () => {
  const unpaired = { ...night(1, 2, [null, null], null), breathingRate: none, hrv: none }
  mock.data = report([unpaired])
  render(view())
  expect(screen.queryByText('Deviation from Apple Watch')).toBeNull()
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByText(/Upload Apple Watch data to see how far/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Upload Apple Watch data for Alex' })).toBeTruthy()

  cleanup()
  mock.data = report([])
  render(view())
  expect(screen.queryByText('Deviation from Apple Watch')).toBeNull()
  expect(screen.getByRole('button', { name: 'Upload Apple Watch data for Alex' })).toBeTruthy()
})

it('shows a chart per metric with MAE, bias, a zero line and the HRV caveat', () => {
  mock.data = report([night(1, 3, [4, 3.5]), night(2, 2, [3, 2]), night(3, 1, [1.5, -0.5], 0.62)])
  render(view())
  expect(screen.getByText('Deviation from Apple Watch')).toBeTruthy()
  const charts = screen.getAllByRole('img')
  expect(charts.map(c => c.getAttribute('aria-label')?.split(':')[0])).toEqual(['Heart rate', 'Breathing rate', 'HRV', 'Sleep stages'])
  const hr = screen.getByRole('region', { name: 'Heart rate' })
  expect(within(hr).getByText('latest MAE 1.5, bias −0.5 bpm')).toBeTruthy()
  // MAE and bias as two lines, plus dots, over guides with zero drawn strong.
  const lines = [...hr.querySelectorAll('path')].filter(p => p.getAttribute('stroke-width') === '2')
  expect(lines.map(p => p.getAttribute('stroke'))).toEqual(['var(--chart-1)', 'var(--chart-2)'])
  const zero = [...hr.querySelectorAll('line')].filter(l => l.getAttribute('stroke') === 'var(--text-3)')
  expect(zero).toHaveLength(1)
  expect(within(screen.getByRole('region', { name: 'HRV' })).getByText(/not like-for-like yet/)).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Sleep stages' })).getByText('latest 0.62')).toBeTruthy()
  expect(screen.getByText('Oct 15')).toBeTruthy()
})

it('leaves a gap for a night without data instead of drawing zero', () => {
  mock.data = report([night(1, 4, [4, 3]), night(2, 3, [3, 2]), night(3, 2, [null, null]), night(4, 1, [2, 1])])
  render(view())
  const hr = screen.getByRole('region', { name: 'Heart rate' })
  const mae = [...hr.querySelectorAll('path')].find(p => p.getAttribute('stroke') === 'var(--chart-1)' && p.getAttribute('stroke-width') === '2')
  // Two runs (nights 1–2 and night 4), each starting with a move; night 3 is skipped, not drawn at 0.
  expect(mae?.getAttribute('d')?.match(/M/g)).toHaveLength(2)
  expect(mae?.getAttribute('d')?.match(/L/g)).toHaveLength(1)
  // The lone point after the gap still shows as a dot.
  const dots = within(hr).getAllByTestId('chart-dots')[0]
  expect(dots.getAttribute('d')?.match(/h0/g)).toHaveLength(3)
  fireEvent.click(screen.getByText('Nights as a table'))
  const row = screen.getAllByRole('row')[3]
  expect(within(row).getAllByRole('cell')[0].textContent).toBe('— / —')
})

it('marks profile changes between the nights they fall between', () => {
  const nights = [night(1, 4, [4, 3]), night(2, 3, [3, 2]), night(3, 2, [2, 1]), night(4, 1, [1, 0.5])]
  const between = (a: number, b: number) => (nights[a].enteredBedAt.getTime() + nights[b].enteredBedAt.getTime()) / 2
  mock.data = report(nights, [
    { generation: 1, atMs: nights[0].enteredBedAt.getTime() - DAY },
    { generation: 2, atMs: between(0, 1) },
    { generation: 3, atMs: between(2, 3) },
    { generation: 4, atMs: between(2, 3) + 1000 },
  ])
  render(view())
  const hr = screen.getByRole('region', { name: 'Heart rate' })
  expect(within(hr).getAllByTestId('chart-marker').map(m => m.textContent)).toEqual(['gen 2', 'gen 3, 4'])
  expect(screen.getAllByTestId('chart-marker')).toHaveLength(8)
})

it('narrows to the chosen window and says so when it has no Watch pairs', () => {
  const paired = night(1, 20, [4, 3])
  const unpaired = { ...night(2, 1, [null, null], null), breathingRate: none, hrv: none }
  mock.data = report([paired, unpaired])
  render(view())
  expect(screen.getByText('No night in the last 14 days pairs with Watch data. Pick a longer window.')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '31 d' }))
  expect(screen.getAllByRole('img')).toHaveLength(4)
})

it('scales to include zero in about three steps', () => {
  expect(deviationScale([1.2, 3.8, -0.4])).toMatchObject({ min: -2, max: 4 })
  expect(deviationScale([Number.NaN, 0])).toMatchObject({ min: 0, max: 1 })
  expect(deviationScale([12, 26]).guides.map(g => [g.value, g.strong])).toEqual([[0, true], [10, false], [20, false], [30, false]])
})

it('drops changes before the first or after the last night', () => {
  const nights = [{ enteredBedAt: new Date(1000) }, { enteredBedAt: new Date(2000) }]
  expect(changeMarkers(nights, [{ generation: 1, atMs: 500 }, { generation: 2, atMs: 1500 }, { generation: 3, atMs: 2500 }])).toEqual([{ at: 0.5, label: 'gen 2' }])
})
