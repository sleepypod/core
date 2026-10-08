import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { WaterModal } from '../WaterModal'
import { TimeFormatProvider } from '@/src/providers/TimeFormatProvider'

const mock = vi.hoisted(() => ({ timeFormat: '12h', timestamp: new Date(), update: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({}),
  waterLevel: {
    getLatest: { useQuery: () => ({ data: { level: 'ok', timestamp: mock.timestamp } }) },
    getTrend: { useQuery: () => ({ data: { trend: 'stable' } }) },
    getHistory: { useQuery: () => ({ data: [] }) },
    getAlerts: { useQuery: () => ({ data: [] }) },
    dismissAlert: { useMutation: () => ({}) },
  },
  device: {
    getStatus: { useQuery: () => ({ data: { isPriming: false } }) },
    startPriming: { useMutation: () => ({}) },
  },
  settings: {
    getAll: { useQuery: () => ({ data: { device: { timeFormat: mock.timeFormat, primePodDaily: true, primePodTime: '14:30' } } }) },
    updateDevice: { useMutation: () => ({ mutate: mock.update }) },
  },
} }))

beforeEach(() => {
  mock.timeFormat = '12h'
  mock.timestamp = new Date(2026, 9, 6, 23, 5)
  vi.clearAllMocks()
})

it('updates water reading timestamps and preserves HH:mm when editing daily priming', () => {
  const onClose = vi.fn()
  const { rerender } = render(<TimeFormatProvider><WaterModal open onClose={onClose} /></TimeFormatProvider>)
  expect(screen.getByText('Stable · read 11:05 PM')).toBeTruthy()
  expect((screen.getByLabelText('Daily prime time') as HTMLInputElement).value).toBe('14:30')
  mock.timeFormat = '24h'
  rerender(<TimeFormatProvider><WaterModal open onClose={onClose} /></TimeFormatProvider>)
  expect(screen.getByText('Stable · read 23:05')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Daily prime time hours' }), { target: { value: '00' } })
  expect(mock.update).toHaveBeenLastCalledWith({ primePodTime: '00:30' })
  mock.timeFormat = '12h'
  rerender(<TimeFormatProvider><WaterModal open onClose={onClose} /></TimeFormatProvider>)
  expect(screen.getByText('Stable · read 11:05 PM')).toBeTruthy()
  expect((screen.getByLabelText('Daily prime time') as HTMLInputElement).value).toBe('14:30')
})
