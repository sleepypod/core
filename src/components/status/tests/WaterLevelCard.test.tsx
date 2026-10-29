/**
 * Tests for WaterLevelCard — skeletons while the 7-day history and device
 * status load, then the day strip and prime line once data arrives.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { WaterLevelCard } from '../WaterLevelCard'

const mock = vi.hoisted(() => ({
  history: undefined as unknown,
  historyLoading: false,
  status: undefined as unknown,
  statusLoading: false,
  frzWater: undefined as unknown,
}))
vi.mock('@/src/hooks/useSensorStream', () => ({
  useSensorFrame: (type: string) => (type === 'frzWater' ? mock.frzWater : undefined),
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  waterLevel: { getHistory: { useQuery: () => ({ data: mock.history, isLoading: mock.historyLoading }) } },
  device: { getStatus: { useQuery: () => ({ data: mock.status, isLoading: mock.statusLoading }) } },
} }))

beforeEach(() => {
  mock.history = undefined
  mock.historyLoading = false
  mock.status = undefined
  mock.statusLoading = false
  mock.frzWater = undefined
})

it('holds the day strip and prime line with skeletons while queries load', () => {
  mock.historyLoading = true
  mock.statusLoading = true
  const { rerender } = render(<WaterLevelCard onOpen={() => {}} />)
  expect(screen.getByTestId('water-history-loading')).toBeTruthy()
  expect(screen.getByTestId('water-status-loading')).toBeTruthy()
  expect(screen.queryByText('No recent prime')).toBeNull()
  expect((screen.getByRole('button', { name: /start prime/i }) as HTMLButtonElement).disabled).toBe(true)

  mock.historyLoading = false
  mock.statusLoading = false
  mock.history = [{ timestamp: new Date(), level: 'low' }]
  mock.status = { isPriming: false }
  rerender(<WaterLevelCard onOpen={() => {}} />)
  expect(screen.queryByTestId('water-history-loading')).toBeNull()
  expect(screen.queryByTestId('water-status-loading')).toBeNull()
  expect(screen.getByText('No recent prime')).toBeTruthy()
  expect(screen.getAllByLabelText(/: low$/)).toHaveLength(1)
  expect(screen.getAllByLabelText(/: no data$/)).toHaveLength(6)
})

it('opens the prime dialog and disables the button while priming', () => {
  const onOpen = vi.fn()
  mock.status = { isPriming: false }
  const { rerender } = render(<WaterLevelCard onOpen={onOpen} />)
  fireEvent.click(screen.getByRole('button', { name: /start prime/i }))
  expect(onOpen).toHaveBeenCalledTimes(1)
  mock.status = { isPriming: true }
  rerender(<WaterLevelCard onOpen={onOpen} />)
  expect(screen.getByText('Priming…')).toBeTruthy()
  expect((screen.getByRole('button', { name: /start prime/i }) as HTMLButtonElement).disabled).toBe(true)
})

it('renders capacitive gauge and needs priming state when frzWater is present', () => {
  mock.frzWater = { capLevel: 3, capValid: true, hasWater: true, isPriming: false, needsPriming: true }
  mock.status = { isPriming: false, waterLevel: 'ok' }
  const { rerender } = render(<WaterLevelCard onOpen={() => {}} />)
  expect(screen.getByTestId('water-tank-gauge')).toBeTruthy()
  expect(screen.getByText('3/5')).toBeTruthy()
  expect(screen.getByText('Needs priming')).toBeTruthy()

  // When frzWater indicates priming is in progress
  mock.frzWater = { capLevel: 3, capValid: true, hasWater: true, isPriming: true, needsPriming: false }
  mock.status = { isPriming: false }
  rerender(<WaterLevelCard onOpen={() => {}} />)
  expect(screen.getByText('Priming…')).toBeTruthy()
  expect((screen.getByRole('button', { name: /start prime/i }) as HTMLButtonElement).disabled).toBe(true)

  // When frzWater is absent, falls back to binary state without gauge
  mock.frzWater = undefined
  mock.status = { isPriming: false, primeCompletedNotification: { timestamp: new Date(2026, 9, 20).toISOString() } }
  rerender(<WaterLevelCard onOpen={() => {}} />)
  expect(screen.queryByTestId('water-tank-gauge')).toBeNull()
  expect(screen.getByText(/Last primed/)).toBeTruthy()
})
