import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BiometricsPage } from '../BiometricsPage'

const NOW = new Date(2026, 8, 28, 19, 1).getTime()
const LAST_VITAL = new Date(2026, 8, 28, 15, 5).getTime()

const state = vi.hoisted(() => ({
  occupied: true,
  dataPath: undefined as unknown,
  recalibrate: vi.fn(),
  vitals: vi.fn(),
  latest: [] as Array<{ timestamp: Date }>,
  shown: ['left', 'right'] as Array<'left' | 'right'>,
}))

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
          ? { data: state.latest, isLoading: false }
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
  state.occupied = true
  state.dataPath = { occupancy: { left: 'occupied', right: 'empty' } }
  state.latest = [{ timestamp: new Date(LAST_VITAL) }]
  state.vitals.mockReturnValue({
    data: [...session(new Date(2026, 8, 27, 4, 5).getTime(), 258), ...session(new Date(2026, 8, 28, 12, 52).getTime(), 134)],
    isLoading: false,
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BiometricsPage', () => {
  it('warns when the side is occupied but vitals stalled, with the gap as hours and minutes', () => {
    render(<BiometricsPage />)
    const banner = screen.getByTestId('stale-banner')
    expect(banner.textContent).toContain('Jon’s side is occupied, but the last vital arrived 3h 56m ago. The pipeline may be stalled.')
    expect(within(banner).getByRole('link', { name: /Health/ }).getAttribute('href')).toBe('/en/system?tab=health&node=piezo-processor')
  })

  it('asks whether anyone is there instead of blaming the pipeline when the side looks empty', async () => {
    state.dataPath = { occupancy: { left: 'suspect', right: 'empty' } }
    render(<BiometricsPage />)
    expect(screen.queryByTestId('stale-banner')).toBeNull()
    const banner = screen.getByTestId('suspect-banner')
    expect(banner.textContent).toContain('Jon’s side reads occupied, but the last vital arrived 3h 56m ago and nobody has moved since.')
    fireEvent.click(within(banner).getByRole('button', { name: 'No — recalibrate empty bed' }))
    await waitFor(() => expect(state.recalibrate).toHaveBeenCalledWith({ side: 'left', sensorType: 'capacitance' }))
  })

  it('hides the banner when the side is empty', () => {
    state.occupied = false
    render(<BiometricsPage />)
    expect(screen.queryByTestId('stale-banner')).toBeNull()
  })

  it('shows the four summary cells without records or RAW files', () => {
    render(<BiometricsPage />)
    const summary = screen.getByTestId('biometrics-summary')
    expect(summary.textContent).toContain('Avg heart rate')
    expect(summary.textContent).toContain('40–84')
    expect(summary.textContent).toContain('17.8')
    expect(summary.textContent).not.toContain('Records')
  })

  it('lists sessions newest first, marks the ongoing stalled one, and moves counts to the footer', () => {
    render(<BiometricsPage />)
    const rows = screen.getAllByTestId('session-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Mon Sep 28')
    expect(rows[0].textContent).toContain('12:52 PM → now')
    expect(rows[0].textContent).toContain('in bed 6h 09m · no vitals since 3:05 PM')
    expect(rows[1].textContent).toContain('4h 17m · 3 movements')
    expect(screen.getByTestId('sessions-card').textContent).toContain('585 records · 4+4 raw files · 8.45 MB')
  })

  it('zooms the chart to a session’s night when its row is clicked', () => {
    render(<BiometricsPage />)
    fireEvent.click(screen.getAllByTestId('session-row')[1])
    const last = state.vitals.mock.calls.at(-1)?.[0] as { startDate: Date, endDate: Date }
    expect(last.startDate).toEqual(new Date(2026, 8, 26, 12))
    expect(last.endDate).toEqual(new Date(2026, 8, 27, 12))
    for (const tab of screen.getAllByRole('tab', { name: 'Night' })) expect(tab.getAttribute('aria-selected')).toBe('true')
  })

  it('drops the Occupied field from the sides card', () => {
    render(<BiometricsPage />)
    const sides = screen.getByTestId('sides-card')
    expect(sides.textContent).toContain('In bed')
    expect(sides.textContent).toContain('Empty')
    expect(sides.textContent).not.toContain('Occupied')
  })

  it('lists only the sleeper\'s side in the sides card when the other is away', () => {
    state.shown = ['left']
    try {
      render(<BiometricsPage />)
      const sides = screen.getByTestId('sides-card')
      expect(sides.textContent).toContain('left')
      expect(sides.textContent).not.toContain('right')
    }
    finally {
      state.shown = ['left', 'right']
    }
  })
})
