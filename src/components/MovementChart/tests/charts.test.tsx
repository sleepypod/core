import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MovementChart } from '../MovementChart'
import { HumidityChart } from '@/src/components/Environment/HumidityChart'
const mock = vi.hoisted(() => ({ buckets: [] as unknown[], summary: undefined as unknown, sleep: undefined as unknown, days: 1, loading: false, error: null as Error | null, chart: vi.fn() }))
vi.mock('@/src/hooks/useBiometricsSide', () => ({ useBiometricsSide: () => ({ side: 'left' }) }))
vi.mock('@/src/hooks/useWeekNavigator', () => ({ useWeekNavigator: () => ({ weekStart: new Date(0), weekEnd: new Date(mock.days * 86400000) }) }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { biometrics: {
  getMovementBuckets: { useQuery: () => ({ data: mock.buckets, isLoading: mock.loading, error: mock.error }) },
  getMovementSummary: { useQuery: () => ({ data: mock.summary }) }, getSleepRecords: { useQuery: () => ({ data: mock.sleep }) },
} } }))
vi.mock('recharts', () => {
  const container = ({ children }: { children: ReactNode }) => <div>{children}</div>
  const chart = ({ data, children }: { data: unknown[], children: ReactNode }) => {
    mock.chart(data)
    return <div>{children}</div>
  }
  return {
    ResponsiveContainer: container, BarChart: chart, AreaChart: chart, Bar: () => null, Area: () => null, CartesianGrid: () => null, YAxis: () => null,
    XAxis: ({ tickFormatter }: { tickFormatter?: (v: string) => string }) => <span>{tickFormatter?.('2026-09-28T22:00:00Z')}</span>,
    Tooltip: ({ content, formatter, labelFormatter }: { content?: ReactNode, formatter?: (v: number) => unknown, labelFormatter?: (v: number) => unknown }) => (
      <div>
        {isValidElement(content)
          ? (
              <>
                {cloneElement(content as ReactElement<{ active: boolean, payload: unknown[] }>, { active: false, payload: [] })}
                {cloneElement(content as ReactElement<{ active: boolean, payload: unknown[] }>, { active: true, payload: [{ payload: { timestamp: 0, movement: 12 } }] })}
              </>
            )
          : (
              <>
                {String(labelFormatter?.(0))}
                {String(formatter?.(45.25))}
              </>
            )}
      </div>
    ),
  }
})
beforeEach(() => {
  Object.assign(mock, { buckets: [], summary: undefined, sleep: undefined, days: 1, loading: false, error: null })
  vi.clearAllMocks()
})
it('renders movement loading, empty and error states', () => {
  mock.loading = true
  const { rerender } = render(<MovementChart />)
  expect(screen.queryByText('No movement data this week')).toBeNull()
  mock.loading = false
  rerender(<MovementChart />)
  expect(screen.getByText('No movement data this week')).toBeTruthy()
  mock.error = new Error('Offline')
  rerender(<MovementChart />)
  expect(screen.getByText('Failed to load movement data')).toBeTruthy()
})
it.each([1, 7])('normalizes movement buckets and summarizes %s days of sleep', (days) => {
  mock.days = days
  mock.buckets = Array.from({ length: 15 }, (_, i) => ({ side: 'left', bucketStart: new Date((14 - i) * 60000), eventCount: 2, totalMovement: 10, sampleCount: 1 }))
  mock.summary = { positionChanges: 5, restlessMinutes: days === 1 ? 20 : 600, sampleCount: 15 }
  mock.sleep = Array.from({ length: days }, () => ({ sleepDurationSeconds: 8 * 3600 }))
  render(<MovementChart />)
  expect(screen.getByText(days === 1 ? 'Medium' : 'High')).toBeTruthy()
  expect(screen.getByText('12 /hr')).toBeTruthy()
  const points = mock.chart.mock.lastCall?.[0]
  expect(points[0].timestamp).toBeLessThan(points.at(-1).timestamp)
  expect(points[0].movement).toBeGreaterThan(0)
})
it('derives humidity statistics, samples dense data and formats the tooltip', () => {
  const { rerender } = render(<HumidityChart data={[]} />)
  expect(screen.getByText('No humidity data available')).toBeTruthy()
  const data = Array.from({ length: 241 }, (_, i) => ({ timestamp: new Date((241 - i) * 60000), humidity: i % 2 ? null : 45.25 }))
  rerender(<HumidityChart data={data} />)
  expect(screen.getByText('45%')).toBeTruthy()
  expect(screen.getByText(/45.3%,Humidity/)).toBeTruthy()
  expect(mock.chart.mock.lastCall?.[0]).toHaveLength(121)
})
