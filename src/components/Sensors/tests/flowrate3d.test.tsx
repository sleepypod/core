import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Chart3DData } from '@/src/components/Chart3D/chart3dScene'
import { FlowrateChart } from '../FlowrateChart'

const mock = vi.hoisted(() => ({ data: undefined as unknown, loading: false, error: false, chart3d: vi.fn(), refetch: vi.fn() }))
vi.mock('@/src/hooks/useSensorStream', () => ({ useSensorFrame: () => undefined }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { waterLevel: { getFlowReadings: { useQuery: () => ({
  data: mock.data, isLoading: mock.loading, isError: mock.error, refetch: mock.refetch,
}) } } } }))
vi.mock('@/src/components/Chart3D/chart3dData', async importOriginal => ({
  ...await importOriginal<object>(),
  useChartStyle: () => ['3d', vi.fn()],
}))
vi.mock('@/src/components/Chart3D/Chart3D', () => ({ Chart3D: (props: { state: string, label: string, onRetry?: () => void }) => {
  mock.chart3d(props)
  return <button type="button" onClick={props.onRetry}>{`${props.state} ${props.label}`}</button>
} }))

beforeEach(() => {
  Object.assign(mock, { data: undefined, loading: false, error: false })
  vi.clearAllMocks()
})

const data3d = () => mock.chart3d.mock.lastCall?.[0].data as Chart3DData | null

it('draws flow and rpm history as two ribbons on one range from zero', () => {
  mock.loading = true
  const { rerender } = render(<FlowrateChart />)
  expect(screen.getByRole('button').textContent).toBe('loading Flow rate history')
  mock.loading = false
  mock.data = [{ timestamp: new Date(0), leftFlowrateCd: 100, rightFlowrateCd: null, leftPumpRpm: 2000, rightPumpRpm: 1000 }]
  rerender(<FlowrateChart />)
  // One reading is not a history.
  expect(screen.getByRole('button').textContent).toBe('empty Flow rate history')
  mock.data = [
    { timestamp: new Date(0), leftFlowrateCd: 100, rightFlowrateCd: 200, leftPumpRpm: 2000, rightPumpRpm: 1000 },
    { timestamp: new Date(60_000), leftFlowrateCd: 300, rightFlowrateCd: null, leftPumpRpm: 3000, rightPumpRpm: 1500 },
  ]
  rerender(<FlowrateChart />)
  const flow = data3d()
  expect(flow?.series.map(s => s.points.map(p => p.y))).toEqual([[1 / 3.3, 3 / 3.3], [2 / 3.3, null]].map(r => r.map(v => (v == null ? null : expect.closeTo(v, 6)))))
  fireEvent.click(screen.getByRole('tab', { name: 'RPM' }))
  expect(screen.getByRole('button').textContent).toBe('ready Pump rpm history')
  expect(data3d()?.series[0].points.at(-1)?.y).toBeCloseTo(1 / 1.1)
  mock.data = [
    { timestamp: new Date(0), leftFlowrateCd: null, rightFlowrateCd: null, leftPumpRpm: null, rightPumpRpm: null },
    { timestamp: new Date(1), leftFlowrateCd: null, rightFlowrateCd: null, leftPumpRpm: null, rightPumpRpm: null },
  ]
  rerender(<FlowrateChart />)
  expect(data3d()).toBeNull()
  mock.error = true
  rerender(<FlowrateChart />)
  fireEvent.click(screen.getByRole('button'))
  expect(mock.refetch).toHaveBeenCalledOnce()
})
