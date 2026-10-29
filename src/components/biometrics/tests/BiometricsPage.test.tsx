import { I18nProvider } from '@lingui/react'
import { i18n } from '@lingui/core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BiometricsPage } from '../BiometricsPage'

const NOW = new Date(2026, 8, 28, 19, 1).getTime()
const LAST_VITAL = new Date(2026, 8, 28, 15, 5).getTime()

i18n.load('en', {})
i18n.activate('en')

const state = vi.hoisted(() => ({
  occupied: true,
  dataPath: undefined as unknown,
  recalibrate: vi.fn(),
  vitals: vi.fn(),
  latest: [] as Array<{ timestamp: Date }>,
  latestPending: false,
  timeFormat: '12h' as '12h' | '24h',
  shown: ['left', 'right'] as Array<'left' | 'right'>,
  reference: [] as Array<{ timestamp: Date, heartRate: number }>,
  referenceHrv: [] as Array<{ timestamp: Date, value: number }>,
  referenceOpts: undefined as Record<string, unknown> | undefined,
}))

vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => state.timeFormat }))
vi.mock('@/src/components/Schedule/CurveChart', () => ({ useNowMinute: () => Math.floor(NOW / 60_000) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/en/sleep' }))
vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({ selectedSide: 'left', primarySide: 'left', activeSides: ['left', 'right'], singleSleeperSide: null, selectSide: vi.fn() }),
  useShownSides: () => state.shown,
}))
vi.mock('@/src/components/biometrics/RawDataButton', () => ({ RawDataButton: () => <button type="button">Raw data</button> }))

function session(start: number, minutes: number) {
  return Array.from({ length: minutes }, (_, i) => ({ side: 'left', timestamp: new Date(start + i * 60_000), heartRate: 60 + (i % 5), hrv: 40, breathingRate: 16 }))
}

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    biometrics: {
      getVitals: {
        useQuery: (input: { limit: number }) => (input.limit === 1
          ? { data: state.latestPending ? undefined : state.latest, isLoading: state.latestPending, isSuccess: !state.latestPending }
          : state.vitals(input)),
      },
      getVitalsSummary: { useQuery: () => ({ data: { avgHeartRate: 61, minHeartRate: 40, maxHeartRate: 84, avgHRV: 43, avgBreathingRate: 17.8, recordCount: 585 }, isLoading: false }) },
      getOccupancy: {
        useQuery: () => ({
          data: {
            left: { occupied: state.occupied, available: true, movement: { active: false, peakScore: 0 }, level: { deviation: 6.4 } },
            right: { occupied: false, available: true, movement: { active: false, peakScore: 0 }, level: { deviation: 4.9 } },
          },
        }),
      },
      getFileCount: { useQuery: () => ({ data: { rawFiles: { left: 4, right: 4 }, totalSizeMB: 8.45 } }) },
      getMovementBuckets: { useQuery: () => ({ data: [{ bucketStart: new Date(2026, 8, 27, 5), eventCount: 3 }] }) },
      getReferenceSamples: { useQuery: (input: { metric: string }) => ({ data: input.metric === 'hrv_sdnn' ? state.referenceHrv : [] }) },
      getReferenceVitals: {
        useQuery: (_input: unknown, opts: Record<string, unknown>) => {
          state.referenceOpts = opts
          return { data: state.reference }
        },
      },
    },
    settings: { getAll: { useQuery: () => ({ data: { sides: { left: { name: 'Jon' }, right: { name: 'Heidi' } } } }) } },
    health: {
      dataPath: { useQuery: () => ({ data: state.dataPath }) },
      restartService: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false, data: undefined, error: null }) },
    },
    calibration: { triggerCalibration: { useMutation: () => ({ mutateAsync: state.recalibrate, isPending: false, isSuccess: false, error: null }) } },
    useUtils: () => ({}),
  },
}))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  state.referenceHrv = []
  state.occupied = true
  state.timeFormat = '12h'
  state.dataPath = { occupancy: { left: 'occupied', right: 'empty' } }
  state.latest = [{ timestamp: new Date(LAST_VITAL) }]
  state.latestPending = false
  state.vitals.mockReturnValue({
    data: [...session(new Date(2026, 8, 27, 4, 5).getTime(), 258), ...session(new Date(2026, 8, 28, 12, 52).getTime(), 134)],
    isLoading: false,
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('BiometricsPage', () => {
  it('warns when the side is occupied but vitals stalled, with the gap as hours and minutes', () => {
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    const banner = screen.getByTestId('stale-banner')
    expect(banner.textContent).toContain('Jon’s side is occupied, but the last vital arrived 3h 56m ago. The pipeline may be stalled.')
    expect(within(banner).getByRole('link', { name: /Health/ }).getAttribute('href')).toBe('/en/system?tab=health&node=piezo-processor')
  })

  it('asks whether anyone is there instead of blaming the pipeline when the side looks empty', async () => {
    state.dataPath = { occupancy: { left: 'suspect', right: 'empty' } }
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    expect(screen.queryByTestId('stale-banner')).toBeNull()
    const banner = screen.getByTestId('suspect-banner')
    expect(banner.textContent).toContain('Jon’s side reads occupied, but the last vital arrived 3h 56m ago and nobody has moved since.')
    fireEvent.click(within(banner).getByRole('button', { name: 'No — recalibrate empty bed' }))
    await waitFor(() => expect(state.recalibrate).toHaveBeenCalledWith({ side: 'left', sensorType: 'capacitance' }))
  })

  it('does not call the pipeline stalled while the latest vital is still loading', () => {
    state.latestPending = true
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    expect(screen.queryByTestId('stale-banner')).toBeNull()
    cleanup()
    state.dataPath = { occupancy: { left: 'suspect', right: 'empty' } }
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    expect(screen.queryByTestId('suspect-banner')).toBeNull()
  })

  it('hides the banner when the side is empty', () => {
    state.occupied = false
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    expect(screen.queryByTestId('stale-banner')).toBeNull()
  })

  it('shows the four summary cells without records or RAW files', () => {
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    const summary = screen.getByTestId('biometrics-summary')
    expect(summary.textContent).toContain('Avg heart rate')
    expect(summary.textContent).toContain('40–84')
    expect(summary.textContent).toContain('17.8')
    expect(summary.textContent).not.toContain('Records')
  })

  it('lists sessions newest first, marks the ongoing stalled one, and moves counts to the footer', () => {
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    const rows = screen.getAllByTestId('session-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Mon Sep 28')
    expect(rows[0].textContent).toContain('12:52 PM → now')
    expect(rows[0].textContent).toContain('in bed 6h 09m · no vitals since 3:05 PM')
    expect(rows[1].textContent).toContain('4h 17m · 3 movements')
    expect(screen.getByTestId('sessions-card').textContent).toContain('585 records · 4+4 raw files · 8.45 MB')
  })

  it('zooms the chart to the complete session when its row is clicked', () => {
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    fireEvent.click(screen.getAllByTestId('session-row')[1])
    const last = state.vitals.mock.calls.at(-1)?.[0] as { startDate: Date, endDate: Date }
    expect(last.startDate).toEqual(new Date(2026, 8, 27, 4, 5))
    expect(last.endDate).toEqual(new Date(2026, 8, 27, 8, 22))
    for (const tab of screen.getAllByRole('tab', { name: 'Night' })) expect(tab.getAttribute('aria-selected')).toBe('true')
  })

  it.each([
    ['12h', ['Sep 27', 'Sep 28'], 'in bed 6h 09m · no vitals since 3:05 PM'],
    ['24h', ['Sep 27', 'Sep 28'], 'in bed 6h 09m · no vitals since 15:05'],
  ] as const)('labels the vitals axis and session times in the %s clock', (format, ticks, since) => {
    state.timeFormat = format
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 300, right: 900, bottom: 300, toJSON: () => ({}) })
    const { container } = render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    const labels = [...container.querySelectorAll('svg text')].map(t => t.textContent)
    for (const tick of ticks) expect(labels).toContain(tick)
    expect(screen.getAllByTestId('session-row')[0].textContent).toContain(since)
  })

  it('overlays imported Watch heart rate on the chart and names it in the legend', () => {
    state.reference = [
      { timestamp: new Date(2026, 8, 27, 4, 10), heartRate: 58 },
      { timestamp: new Date(2026, 8, 27, 4, 20), heartRate: 57 },
    ]
    try {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 300, right: 900, bottom: 300, toJSON: () => ({}) })
      render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
      expect(screen.getAllByTestId('vitals-reference')).toHaveLength(1)
      expect(screen.getByText('Apple Watch heart rate')).toBeTruthy()
    }
    finally {
      state.reference = []
    }
  })

  it('does not carry the previous side’s Watch samples across a side switch', () => {
    // The pod line may keep its placeholder while the new side loads, but the
    // Watch overlay must not: that would compare one person to the other.
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    expect(state.referenceOpts).not.toHaveProperty('placeholderData')
  })

  it('drops the Occupied field from the sides card', () => {
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    const sides = screen.getByTestId('sides-card')
    expect(sides.textContent).toContain('In bed')
    expect(sides.textContent).toContain('Empty')
    expect(sides.textContent).not.toContain('Occupied')
  })

  it('lists only the sleeper\'s side in the sides card when the other is away', () => {
    state.shown = ['left']
    try {
      render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
      const sides = screen.getByTestId('sides-card')
      expect(sides.textContent).toContain('left')
      expect(sides.textContent).not.toContain('right')
    }
    finally {
      state.shown = ['left', 'right']
    }
  })
})

describe('biometrics date navigation', () => {
  it('selects an older night, steps through nights, and returns to the latest range', () => {
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    fireEvent.click(screen.getAllByRole('tab', { name: 'Night' })[0])
    fireEvent.change(screen.getByLabelText('Biometrics date'), { target: { value: '2026-09-10' } })
    expect(state.vitals.mock.calls.at(-1)?.[0].startDate).toEqual(new Date(2026, 8, 10, 12))
    fireEvent.click(screen.getByRole('button', { name: 'Previous night' }))
    expect(state.vitals.mock.calls.at(-1)?.[0].startDate).toEqual(new Date(2026, 8, 9, 12))
    fireEvent.click(screen.getByRole('button', { name: 'Next night' }))
    expect(state.vitals.mock.calls.at(-1)?.[0].startDate).toEqual(new Date(2026, 8, 10, 12))
    fireEvent.click(screen.getByRole('button', { name: 'Latest' }))
    expect(state.vitals.mock.calls.at(-1)?.[0].startDate).toEqual(new Date(2026, 8, 28, 12))
  })

  it('focuses session detail and restores the original week', () => {
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    fireEvent.click(screen.getAllByTestId('session-row')[1])
    expect(document.activeElement).toBe(screen.getByLabelText('Vitals detail'))
    fireEvent.click(screen.getByRole('button', { name: 'Back to range' }))
    expect(state.vitals.mock.calls.at(-1)?.[0].startDate).toEqual(new Date(2026, 8, 22))
    expect(screen.getAllByRole('tab', { name: 'Week' })[0].getAttribute('aria-selected')).toBe('true')
  })

  it('shows Watch summaries only for sessions with matching data', () => {
    state.reference = [{ timestamp: new Date(2026, 8, 27, 5), heartRate: 58 }]
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    const rows = screen.getAllByTestId('session-row')
    expect(rows[0].textContent).not.toContain('Watch')
    expect(rows[1].textContent).toContain('Watch 58 bpm')
    state.reference = []
  })

  it('requests a complete month including dense 30-second readings', () => {
    render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
    fireEvent.click(screen.getAllByRole('tab', { name: 'Month' })[0])
    const input = state.vitals.mock.calls.at(-1)?.[0]
    expect(input.startDate).toEqual(new Date(2026, 7, 30))
    expect(input.endDate).toEqual(new Date(2026, 8, 29))
    expect(input.limit).toBeGreaterThanOrEqual(30 * 24 * 120)
  })
})

it('keeps the whole selected session when it crosses noon', () => {
  state.vitals.mockReturnValue({ data: session(new Date(2026, 8, 27, 11).getTime(), 181), isLoading: false })
  render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
  fireEvent.click(screen.getByTestId('session-row'))
  const input = state.vitals.mock.calls.at(-1)?.[0]
  expect(input.startDate).toEqual(new Date(2026, 8, 27, 11))
  expect(input.endDate).toEqual(new Date(2026, 8, 27, 14))
})

it.each([
  ['Week', 'Previous week', new Date(2026, 8, 15), new Date(2026, 8, 22)],
  ['Week', 'Next week', new Date(2026, 8, 29), new Date(2026, 9, 6)],
  ['Month', 'Previous month', new Date(2026, 6, 31), new Date(2026, 7, 30)],
  ['Month', 'Next month', new Date(2026, 8, 29), new Date(2026, 9, 29)],
])('steps %s using %s across calendar boundaries', (range, button, startDate, endDate) => {
  render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
  fireEvent.click(screen.getAllByRole('tab', { name: range as string })[0])
  fireEvent.click(screen.getByRole('button', { name: button as string }))
  expect(state.vitals.mock.calls.at(-1)?.[0]).toMatchObject({ startDate, endDate })
})

it.each([
  ['Previous night', new Date(2026, 8, 25, 12)],
  ['Next night', new Date(2026, 8, 27, 12)],
])('uses the focused session night as the anchor for %s', (button, startDate) => {
  render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
  fireEvent.click(screen.getAllByTestId('session-row')[1])
  fireEvent.click(screen.getByRole('button', { name: button as string }))
  expect(state.vitals.mock.calls.at(-1)?.[0].startDate).toEqual(startDate)
  expect(screen.queryByRole('button', { name: 'Back to range' })).toBeNull()
})

it('clears session focus when switching people and ignores clearing the date field', () => {
  render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
  fireEvent.click(screen.getAllByTestId('session-row')[1])
  fireEvent.click(screen.getByRole('tab', { name: 'Heidi' }))
  expect(screen.queryByRole('button', { name: 'Back to range' })).toBeNull()
  const input = state.vitals.mock.calls.at(-1)?.[0]
  fireEvent.change(screen.getByLabelText('Biometrics date'), { target: { value: '' } })
  expect(state.vitals.mock.calls.at(-1)?.[0]).toEqual(input)
})

it('explains SDNN comparability only when Watch HRV is overlaid', () => {
  const view = render(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
  expect(screen.queryByText(/Watch SDNN and sleepypod/)).toBeNull()
  state.referenceHrv = [{ timestamp: new Date(LAST_VITAL), value: 30 }]
  view.rerender(<I18nProvider i18n={i18n}><BiometricsPage /></I18nProvider>)
  expect(screen.getByText(/Watch SDNN and sleepypod/)).toBeTruthy()
})
