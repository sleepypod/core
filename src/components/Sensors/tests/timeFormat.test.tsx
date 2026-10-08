import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { CalibrationCard } from '../CalibrationCard'
import { TempTrendChart } from '../TempTrendChart'
import type { ReactNode } from 'react'
import { TimeFormatProvider } from '@/src/providers/TimeFormatProvider'

const mock = vi.hoisted(() => ({ timeFormat: '12h', history: [] as unknown[], status: {} as Record<string, unknown> }))
vi.mock('@/src/hooks/useSide', () => ({ useSide: () => ({ side: 'left' }) }))
vi.mock('@/src/hooks/useSensorStream', () => ({ useOnSensorFrame: vi.fn() }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'C', convert: (v: number | null) => v }) }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({}),
  settings: { getAll: { useQuery: () => ({ data: { device: { timeFormat: mock.timeFormat } } }) } },
  environment: { getBedTemp: { useQuery: () => ({ data: mock.history }) } },
  calibration: {
    getStatus: { useQuery: () => ({ data: mock.status }) },
    getHistory: { useQuery: () => ({}) },
    getVitalsQuality: { useQuery: () => ({}) },
    triggerCalibration: { useMutation: () => ({}) },
    triggerFullCalibration: { useMutation: () => ({}) },
  },
} }))

beforeEach(() => {
  mock.timeFormat = '12h'
  mock.history = []
  mock.status = {}
})

function renderSensor(children: ReactNode) {
  const view = render(<TimeFormatProvider>{children}</TimeFormatProvider>)
  return { ...view, setFormat: (value: '12h' | '24h') => {
    mock.timeFormat = value
    view.rerender(<TimeFormatProvider>{children}</TimeFormatProvider>)
  } }
}

it('updates temperature trend ticks across midnight without changing the readings', () => {
  mock.history = [0, 1, 2, 3].map(i => ({ timestamp: new Date(2026, 9, 7, 0, 30 - i * 30), leftCenterTemp: 25, rightCenterTemp: 26 }))
  const { container, setFormat } = renderSensor(<TempTrendChart />)
  expect(screen.getByText('11:00 PM')).toBeTruthy()
  expect(screen.getByText('12:00 AM')).toBeTruthy()
  const paths = Array.from(container.querySelectorAll('path'), p => p.getAttribute('d'))
  setFormat('24h')
  for (const label of ['23:00', '23:30', '00:00', '00:30']) expect(screen.getByText(label)).toBeTruthy()
  expect(Array.from(container.querySelectorAll('path'), p => p.getAttribute('d'))).toEqual(paths)
  setFormat('12h')
  expect(screen.getByText('12:30 AM')).toBeTruthy()
})

it('updates calibration timestamps while retaining the calendar date', () => {
  const createdAt = new Date(2026, 9, 6, 23, 5)
  mock.status = { piezo: { id: 1, side: 'left', sensorType: 'piezo', status: 'completed', qualityScore: 0.9, samplesUsed: 100, createdAt, expiresAt: null, errorMessage: null } }
  const { setFormat } = renderSensor(<CalibrationCard />)
  const date = createdAt.toLocaleDateString([], { month: 'short', day: 'numeric' })
  expect(screen.getByText(`${date} 11:05 PM`)).toBeTruthy()
  setFormat('24h')
  expect(screen.getByText(`${date} 23:05`)).toBeTruthy()
  setFormat('12h')
  expect(screen.getByText(`${date} 11:05 PM`)).toBeTruthy()
})
