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
  frames: {} as Record<string, unknown>,
}))
const subscription = vi.hoisted(() => vi.fn())
vi.mock('@/src/hooks/useSensorStream', () => ({ useSensorFrame: (type: string) => mock.frames[type], useSensorSubscription: subscription }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  waterLevel: { getHistory: { useQuery: () => ({ data: mock.history, isLoading: mock.historyLoading }) } },
  device: { getStatus: { useQuery: () => ({ data: mock.status, isLoading: mock.statusLoading }) } },
} }))

beforeEach(() => {
  mock.history = undefined
  mock.historyLoading = false
  mock.status = undefined
  mock.statusLoading = false
  mock.frames = {}
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

it('keeps the header and prime state from device status without a frzWater frame', () => {
  mock.status = { isPriming: false }
  render(<WaterLevelCard onOpen={() => {}} />)
  expect(subscription).toHaveBeenCalledWith({ sensors: ['frzWater'] })
  expect(screen.queryByTestId('water-tank')).toBeNull()
  expect(screen.getByText('7 days')).toBeTruthy()
  expect((screen.getByRole('button', { name: /start prime/i }) as HTMLButtonElement).disabled).toBe(false)
})

it('shows the tank gauge from frzWater and blocks Start prime while it reports priming', () => {
  mock.status = { isPriming: false }
  mock.frames.frzWater = { type: 'frzWater', version: 1, ts: 1, isPriming: 0, hasWater: 1, capValid: 1, capLevel: 3, needsPriming: 0 }
  const { rerender } = render(<WaterLevelCard onOpen={() => {}} />)
  expect(screen.getByRole('img', { name: 'Water tank 3 of 5' })).toBeTruthy()
  expect((screen.getByRole('button', { name: /start prime/i }) as HTMLButtonElement).disabled).toBe(false)
  // Pod 3 live payload: integer flags, invalid capacitive level, priming.
  mock.frames.frzWater = { type: 'frzWater', version: 1, ts: 2, isPriming: 1, hasWater: 1, capValid: 0, capLevel: 0, needsPriming: 0 }
  rerender(<WaterLevelCard onOpen={() => {}} />)
  expect(screen.getByRole('img', { name: 'Water ok, tank level unavailable' })).toBeTruthy()
  expect(screen.getAllByText('Priming…')).toHaveLength(2)
  expect((screen.getByRole('button', { name: /start prime/i }) as HTMLButtonElement).disabled).toBe(true)
})
