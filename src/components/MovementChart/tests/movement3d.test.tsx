import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Chart3DData } from '@/src/components/Chart3D/chart3dScene'
import { MovementChart } from '../MovementChart'

const mock = vi.hoisted(() => ({
  buckets: [] as unknown[], summary: undefined as unknown, sleep: undefined as unknown, watch: [] as unknown[], days: 1,
  loading: false, error: null as Error | null, chart3d: vi.fn(), refetch: vi.fn(),
}))
vi.mock('@/src/hooks/useBiometricsSide', () => ({ useBiometricsSide: () => ({ side: 'left' }) }))
vi.mock('@/src/hooks/useWeekNavigator', () => ({ useWeekNavigator: () => ({ weekStart: new Date(0), weekEnd: new Date(mock.days * 86400000) }) }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometrics: {
  getMovementBuckets: { useQuery: () => ({ data: mock.buckets, isLoading: mock.loading, error: mock.error, refetch: mock.refetch }) },
  getMovementSummary: { useQuery: () => ({ data: mock.summary, refetch: mock.refetch }) },
  getSleepRecords: { useQuery: () => ({ data: mock.sleep }) },
  getWatchMotionSeries: { useQuery: () => ({ data: mock.watch }) },
} } }))
vi.mock('@/src/components/Chart3D/chart3dData', async importOriginal => ({
  ...await importOriginal<object>(),
  useChartStyle: () => ['3d', vi.fn()],
}))
vi.mock('@/src/components/Chart3D/Chart3D', () => ({ Chart3D: (props: { state: string, message?: string, onRetry?: () => void }) => {
  mock.chart3d(props)
  return (
    <div data-testid="chart3d">
      {props.state}
      {props.message}
      <button type="button" onClick={props.onRetry}>Retry</button>
    </div>
  )
} }))
vi.mock('recharts', () => {
  const pass = ({ children }: { children?: unknown }) => <div>{children as never}</div>
  return { ResponsiveContainer: pass, BarChart: pass, ComposedChart: pass, Bar: () => null, Line: () => null, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null }
})

beforeEach(() => {
  Object.assign(mock, { buckets: [], summary: undefined, sleep: undefined, watch: [], days: 1, loading: false, error: null })
  vi.clearAllMocks()
})

const data3d = () => mock.chart3d.mock.lastCall?.[0].data as Chart3DData | null

it('draws movement as 3D bars with stat placeholders while loading, and retries both queries', () => {
  mock.loading = true
  const { rerender } = render(<MovementChart />)
  expect(screen.getByTestId('chart3d').textContent).toContain('loading')
  expect(screen.queryByText('Position changes')?.nextElementSibling?.className).toContain('animate-pulse')
  mock.loading = false
  rerender(<MovementChart />)
  expect(screen.getByTestId('chart3d').textContent).toContain('No movement data this week')
  mock.error = new Error('Offline')
  rerender(<MovementChart />)
  expect(screen.getByTestId('chart3d').textContent).toContain('error')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(mock.refetch).toHaveBeenCalledTimes(2)
})

it.each([1, 7])('normalises %s days of buckets over the busiest one, with ticks and /hr gridlines', (days) => {
  mock.days = days
  mock.buckets = Array.from({ length: 12 }, (_, i) => ({ side: 'left', bucketStart: new Date(i * 3 * 3_600_000), eventCount: i, totalMovement: 1, sampleCount: 1 }))
  render(<MovementChart />)
  const out = data3d()
  const ys = out?.series[0].points.map(p => p.y) ?? []
  expect(Math.max(...(ys as number[]))).toBe(1)
  expect(ys[0]).toBe(0)
  // Bars sit at (i + ½) / n so ticks line up with them.
  expect(out?.series[0].points[0].x).toBeCloseTo(0.5 / 12)
  expect(out?.xTicks?.length).toBeGreaterThan(0)
  expect(out?.yTicks?.at(-1)?.label).toMatch(/\/hr$/)
})

it('keeps the flat chart when the week has Apple Watch movement to overlay', () => {
  const M = 60_000
  mock.buckets = [{ side: 'left', bucketStart: new Date(10 * M), eventCount: 2, totalMovement: 10, sampleCount: 1 }]
  mock.sleep = [{ sleepDurationSeconds: 3600, enteredBedAt: new Date(5 * M), leftBedAt: new Date(60 * M) }]
  mock.watch = [{ timestamp: new Date(11 * M), movingSamples: 4 }]
  render(<MovementChart />)
  expect(screen.queryByTestId('chart3d')).toBeNull()
  expect(screen.getByTestId('movement-watch-legend')).toBeTruthy()
})
