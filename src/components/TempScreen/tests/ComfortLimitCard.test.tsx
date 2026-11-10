import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ComfortLimitCard } from '../ComfortLimitCard'
const state = vi.hoisted(() => ({ query: { data: { apiVersion: 1, side: 'left', sourceSide: 'left', revision: 0,
  config: { enabled: false, minF: 68, maxF: 72 }, wake: { startsAt: Date.parse('2026-11-11T06:30Z'), alarmAt: Date.parse('2026-11-11T07:00Z'), targetF: 105, timeZone: 'UTC' }, wakeAvailable: true }, isError: false, refetch: vi.fn() },
mutation: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null } }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { comfortLimit: { get: { useQuery: () => state.query }, configure: { useMutation: () => state.mutation } } } }))
beforeEach(() => {
  state.query.isError = false
  state.query.data.revision = 0
  state.query.data.sourceSide = 'left'
  state.mutation.error = null
  state.mutation.isPending = false
  vi.clearAllMocks()
  state.query.refetch.mockResolvedValue({ isError: false })
})
afterEach(cleanup)
it('explains wake exception and saves only an explicitly reviewed range with its original revision', () => {
  const screen = render(<ComfortLimitCard side="left" />)
  expect(screen.getByText(/6:30.*105°F/)).toBeTruthy()
  expect(state.mutation.mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Edit comfort range' }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Save comfort range' }))
  expect(state.mutation.mutate).toHaveBeenCalledWith({ side: 'left', expectedSourceSide: 'left', expectedRevision: 0, config: { enabled: true, minF: 68, maxF: 72 } })
})
it('rejects blank, reversed or excessively wide ranges', () => {
  const screen = render(<ComfortLimitCard side="left" />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit comfort range' }))
  const minimum = screen.getByLabelText('Minimum (°F)')
  for (const value of ['', '90', '55']) {
    fireEvent.change(minimum, { target: { value } })
    expect(screen.getByRole('button', { name: 'Save comfort range' }).hasAttribute('disabled')).toBe(true)
  }
})
it('prevents overwriting a newer revision and cancels without saving', () => {
  const screen = render(<ComfortLimitCard side="left" />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit comfort range' }))
  state.query.data.revision = 1
  screen.rerender(<ComfortLimitCard side="left" />)
  expect(screen.getByRole('alert').textContent).toContain('changed')
  expect(screen.getByRole('button', { name: 'Save comfort range' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(state.mutation.mutate).not.toHaveBeenCalled()
})
it('withdraws stale controls and blocks a draft when its network query fails', () => {
  const screen = render(<ComfortLimitCard side="left" />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit comfort range' }))
  state.query.isError = true
  screen.rerender(<ComfortLimitCard side="left" />)
  expect(screen.queryByText('No automatic range enabled')).toBeNull()
  expect(screen.getByRole('button', { name: 'Save comfort range' }).hasAttribute('disabled')).toBe(true)
})
it('labels linked solo zones and does not carry a draft to another side', () => {
  state.query.data.sourceSide = 'right'
  const screen = render(<ComfortLimitCard side="left" />)
  expect(screen.getByText(/follows the right sleeper/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit comfort range' }))
  screen.rerender(<ComfortLimitCard side="right" />)
  expect(screen.queryByRole('checkbox')).toBeNull()
})

it('requires a successful fresh read after an ambiguous save without replaying the mutation', async () => {
  state.mutation.error = new Error('response lost')
  const screen = render(<ComfortLimitCard side="left" />)
  expect(screen.queryByText('No automatic range enabled')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('No retry was queued')
  expect(screen.queryByRole('button', { name: 'Edit comfort range' })).toBeNull()
  state.query.refetch.mockResolvedValueOnce({ isError: true })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved limit' }))
  await waitFor(() => expect(state.query.refetch).toHaveBeenCalledTimes(1))
  expect(state.mutation.reset).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved limit' }))
  await waitFor(() => expect(state.mutation.reset).toHaveBeenCalledOnce())
  expect(state.mutation.mutate).not.toHaveBeenCalled()
})
