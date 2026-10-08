import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BedTempChart } from '../BedTempChart'
import { HumidityChart } from '../HumidityChart'
import { TimeFormatProvider } from '@/src/providers/TimeFormatProvider'

const chart = vi.hoisted(() => ({ timestamp: 0, data: vi.fn(), timeFormat: '12h' }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: () => ({ data: { device: { timeFormat: chart.timeFormat } } }) } } } }))

// Exercise the callbacks Recharts invokes for axes and tooltips without relying
// on jsdom layout measurements. Keep the components and preference hook real.
vi.mock('recharts', () => {
  const container = ({ children }: { children: ReactNode }) => <div>{children}</div>
  const plot = ({ data, children }: { data: unknown[], children: ReactNode }) => {
    chart.data(data)
    return <div>{children}</div>
  }
  return {
    ResponsiveContainer: container, LineChart: plot, AreaChart: plot,
    Line: () => null, Area: () => null, CartesianGrid: () => null, YAxis: () => null,
    XAxis: ({ tickFormatter }: { tickFormatter?: (value: number) => string }) => <output aria-label="Time axis">{tickFormatter?.(chart.timestamp)}</output>,
    Tooltip: ({ labelFormatter }: { labelFormatter: (value: number) => string }) => <output aria-label="Tooltip time">{labelFormatter(chart.timestamp)}</output>,
  }
})

beforeEach(() => {
  chart.timeFormat = '12h'
  chart.timestamp = new Date(2026, 9, 6, 23, 5, 9).getTime()
  vi.clearAllMocks()
})

function renderChart(children: ReactNode) {
  const view = render(<TimeFormatProvider>{children}</TimeFormatProvider>)
  return (value: '12h' | '24h') => {
    chart.timeFormat = value
    view.rerender(<TimeFormatProvider>{children}</TimeFormatProvider>)
  }
}

it('updates bed-temperature axis, tooltip and memoized labels in both clock formats', () => {
  const data = [{ timestamp: new Date(chart.timestamp), leftCenterTemp: 25, rightCenterTemp: 26, ambientTemp: 20 }]
  const setFormat = renderChart(<BedTempChart data={data} unit="C" />)
  expect(screen.getByLabelText('Time axis').textContent).toBe('11:05 PM')
  expect(screen.getByLabelText('Tooltip time').textContent).toBe('11:05:09 PM')
  expect(chart.data.mock.lastCall?.[0][0].timeLabel).toBe('11:05 PM')
  setFormat('24h')
  expect(screen.getByLabelText('Time axis').textContent).toBe('23:05')
  expect(screen.getByLabelText('Tooltip time').textContent).toBe('23:05:09')
  expect(chart.data.mock.lastCall?.[0][0]).toMatchObject({ time: chart.timestamp, timeLabel: '23:05', left: 25, right: 26 })
  setFormat('12h')
  expect(screen.getByLabelText('Time axis').textContent).toBe('11:05 PM')
})

it('formats midnight as 00 in bed-temperature ticks and tooltips', () => {
  chart.timestamp = new Date(2026, 9, 7, 0, 0, 0).getTime()
  chart.timeFormat = '24h'
  renderChart(<BedTempChart data={[{ timestamp: new Date(chart.timestamp).toISOString(), leftCenterTemp: 25, rightCenterTemp: null, ambientTemp: null }]} unit="C" />)
  expect(screen.getByLabelText('Time axis').textContent).toBe('00:00')
  expect(screen.getByLabelText('Tooltip time').textContent).toBe('00:00:00')
})

it('updates humidity tooltip times when the preference changes with unchanged data', () => {
  const setFormat = renderChart(<HumidityChart data={[{ timestamp: new Date(chart.timestamp), humidity: 45 }]} />)
  expect(screen.getByLabelText('Tooltip time').textContent).toBe('11:05 PM')
  setFormat('24h')
  expect(screen.getByLabelText('Tooltip time').textContent).toBe('23:05')
  setFormat('12h')
  expect(screen.getByLabelText('Tooltip time').textContent).toBe('11:05 PM')
})
