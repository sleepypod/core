import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AlarmCard } from '../AlarmCard'
import { TonightCard } from '../TonightCard'
import { LastNightCard } from '../LastNightCard'
const mock = vi.hoisted(() => ({
  schedule: undefined as unknown, latest: undefined as unknown, vitals: undefined as unknown,
  loading: false, error: null as Error | null, mutationError: null as Error | null, mutate: vi.fn(), invalidate: vi.fn(), vitalsInput: vi.fn(),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/de' }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ schedules: { getAll: { invalidate: mock.invalidate } } }),
  schedules: { getAll: { useQuery: () => ({ data: mock.schedule, isLoading: mock.loading, error: mock.error }) }, updateAlarmSchedule: { useMutation: () => ({ mutateAsync: mock.mutate, error: mock.mutationError }) } },
  biometrics: {
    getLatestSleep: { useQuery: () => ({ data: mock.latest, isLoading: mock.loading, error: mock.error }) },
    getVitalsSummary: { useQuery: (input: unknown) => {
      mock.vitalsInput(input)
      return { data: mock.vitals, error: mock.mutationError }
    } },
  },
} }))
vi.mock('@/src/components/Schedule/AlarmEditor', () => ({ AlarmEditor: ({ open }: { open: boolean }) => (open ? <div>alarm editor</div> : null) }))
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mock, { schedule: undefined, latest: undefined, vitals: undefined, loading: false, error: null, mutationError: null })
  mock.mutate.mockResolvedValue({})
})
afterEach(() => vi.useRealTimers())

it('toggles all alarms in the chosen group and restores server state after a rejected update', async () => {
  mock.schedule = { alarm: [{ id: 1, dayOfWeek: 'monday', time: '07:00', duration: 10, enabled: true }, { id: 2, dayOfWeek: 'tuesday', time: '07:00', duration: 10, enabled: false }] }
  const { rerender } = render(<AlarmCard side="left" />)
  fireEvent.click(screen.getByRole('switch', { name: 'Alarm enabled' }))
  await waitFor(() => expect(mock.invalidate).toHaveBeenCalledOnce())
  expect(mock.mutate).toHaveBeenCalledExactlyOnceWith({ id: 1, enabled: false })
  mock.schedule = { alarm: [{ id: 1, dayOfWeek: 'monday', time: '07:00', duration: 10, enabled: false }, { id: 2, dayOfWeek: 'tuesday', time: '07:00', duration: 10, enabled: false }] }
  mock.mutate.mockRejectedValue(new Error('Offline'))
  mock.mutationError = new Error('Offline')
  rerender(<AlarmCard side="left" />)
  fireEvent.click(screen.getByRole('switch', { name: 'Alarm enabled' }))
  await waitFor(() => expect(mock.invalidate).toHaveBeenCalledTimes(2))
  expect(mock.mutate).toHaveBeenCalledWith({ id: 2, enabled: true })
  expect(screen.getByText('Could not update alarm: Offline')).toBeTruthy()
})

it('shows loading, empty and error states for each card', () => {
  mock.loading = true
  const cards = (
    <>
      <AlarmCard side="left" />
      <TonightCard side="left" unit="F" />
      <LastNightCard side="left" name="Alex" />
    </>
  )
  const { rerender } = render(cards)
  expect(screen.queryByText('No alarm set')).toBeNull()
  mock.loading = false
  rerender(<>{cards}</>)
  // Give each mocked query a fresh render after its response changes.
  rerender(<div>{cards}</div>)
  expect(screen.getByText('No alarm set')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(screen.getByText('alarm editor')).toBeTruthy()
  expect(screen.getByText('No schedule tonight')).toBeTruthy()
  expect(screen.getByText('No sleep recorded yet')).toBeTruthy()
  mock.error = new Error('Offline')
  rerender(<section>{cards}</section>)
  expect(screen.getByText('Could not load alarms: Offline')).toBeTruthy()
  expect(screen.getByText('Could not load schedule: Offline')).toBeTruthy()
  expect(screen.getByText('Could not load sleep: Offline')).toBeTruthy()
})

it('shows the next schedule point and updates its countdown', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 28, 21))
  mock.schedule = { temperature: [{ dayOfWeek: 'monday', time: '22:00', temperature: 78, enabled: true }, { dayOfWeek: 'monday', time: '07:00', temperature: 80, enabled: true }], power: [] }
  const { unmount } = render(<TonightCard side="left" unit="F" />)
  expect(screen.getByText(/Next 10:00 PM/)).toBeTruthy()
  act(() => vi.advanceTimersByTime(30000))
  expect(screen.getByText('ON')).toBeTruthy()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('links sleep details, rounds vitals and keeps open-session query keys stable', () => {
  const enteredBedAt = new Date(2026, 8, 28, 22), leftBedAt = new Date(2026, 8, 29, 6)
  mock.latest = { enteredBedAt, leftBedAt, sleepDurationSeconds: 28800, timesExitedBed: 1 }
  mock.vitals = { avgHeartRate: 55.6, avgHRV: 48.4, avgBreathingRate: null }
  const { rerender } = render(<LastNightCard side="left" name="Alex" />)
  expect(screen.getByRole('link').getAttribute('href')).toBe('/de/sleep')
  expect(screen.getByText('56')).toBeTruthy()
  expect(screen.getByText(/1 exit$/)).toBeTruthy()
  expect(mock.vitalsInput).toHaveBeenLastCalledWith({ side: 'left', startDate: enteredBedAt, endDate: leftBedAt })
  mock.latest = { enteredBedAt, leftBedAt: null, sleepDurationSeconds: null }
  mock.mutationError = new Error('No vitals')
  rerender(<LastNightCard side="left" name="Alex" />)
  expect(mock.vitalsInput).toHaveBeenLastCalledWith({ side: 'left', startDate: enteredBedAt })
  expect(screen.getByText(/now · 0 exits/)).toBeTruthy()
  expect(screen.getByText('Could not load vitals: No vitals')).toBeTruthy()
})
