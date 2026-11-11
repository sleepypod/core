import { required } from '@/src/alarms/tests/required'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NextAlarm } from '@/src/alarms/contract'
import { AlarmCard } from '../AlarmCard'
import { TonightCard } from '../TonightCard'
import { LastNightCard } from '../LastNightCard'
const mock = vi.hoisted(() => ({
  nextAlarm: undefined as NextAlarm | undefined, refresh: vi.fn(), setAlarmData: vi.fn(),
  schedule: undefined as unknown, latest: undefined as unknown, vitals: undefined as unknown,
  loading: false, error: null as Error | null, mutationError: null as Error | null, mutate: vi.fn(), invalidate: vi.fn(), vitalsInput: vi.fn(),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/de' }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } },
  useUtils: () => ({ nextAlarm: { get: { setData: mock.setAlarmData, invalidate: mock.invalidate } }, schedules: { getAll: { invalidate: mock.invalidate } } }),
  schedules: { getAll: { useQuery: () => ({ data: mock.schedule, isLoading: mock.loading, error: mock.error }) }, updateAlarmSchedule: { useMutation: () => ({ mutateAsync: mock.mutate, error: mock.mutationError }) } },
  nextAlarm: { get: { useQuery: () => ({ data: mock.nextAlarm, dataUpdatedAt: Date.now(), isError: !!mock.error, isLoading: mock.loading, error: mock.error, refetch: mock.refresh }) }, change: { useMutation: () => ({ mutateAsync: mock.mutate, isPending: false }) } },
  biometrics: {
    getSleepStages: { useQuery: () => ({ data: mock.latest, isLoading: mock.loading, error: mock.error }) },
    getVitalsSummary: { useQuery: (input: unknown) => {
      mock.vitalsInput(input)
      return { data: mock.vitals, error: mock.mutationError }
    } },
  },
} }))
vi.mock('@/src/components/Schedule/AlarmEditor', () => ({ AlarmEditor: ({ open }: { open: boolean }) => (open ? <div>alarm editor</div> : null) }))
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mock, { nextAlarm: undefined, schedule: { alarm: [] }, latest: undefined, vitals: undefined, loading: false, error: null, mutationError: null })
  mock.mutate.mockResolvedValue({})
  mock.refresh.mockResolvedValue({ data: nextAlarm, isError: false })
})
afterEach(() => vi.useRealTimers())

const nextAlarm: NextAlarm = { apiVersion: 1, side: 'left', timeZone: 'UTC', revision: 'a'.repeat(64), state: 'scheduled',
  alarm: { scheduleIds: [1], at: '2026-10-27T07:00:00.000Z', originalAt: '2026-10-27T07:00:00.000Z', time: '07:00', source: 'routine', duration: 10, wakeWindow: 0, alarmTemperatureF: 80 },
  followingAt: null, canChange: true, reason: '', execution: null, acknowledgment: 'accepted_not_physically_verified', change: null }

it('shows an authoritative warm-up span and withdraws it when the refresh fails', () => {
  if (!nextAlarm.alarm) throw new Error('Missing alarm fixture')
  mock.nextAlarm = { ...nextAlarm, alarm: { ...nextAlarm.alarm, alarmTemperatureF: 105 }, warming: { startsAt: '2026-10-27T06:30:00Z', endsAt: '2026-10-27T07:15:10Z', earliestVibrationAt: '2026-10-27T07:00:00Z', targetF: 105 } }
  const view = render(<AlarmCard side="left" />)
  expect(screen.getByText('Warming starts 6:30 AM toward 105°F.')).toBeTruthy()
  mock.error = new Error('Offline')
  view.rerender(<AlarmCard side="left" />)
  expect(screen.queryByText('Warming starts 6:30 AM toward 105°F.')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Skip this alarm' })).toBeNull()
})

it('skips the displayed occurrence without sending weekly row updates', async () => {
  mock.nextAlarm = nextAlarm
  mock.mutate.mockResolvedValue({ ...nextAlarm, state: 'skipped', schedulerUpdated: true })
  render(<AlarmCard side="left" />)
  fireEvent.click(screen.getByRole('button', { name: 'Skip this alarm' }))
  await waitFor(() => expect(mock.setAlarmData).toHaveBeenCalledOnce())
  expect(mock.mutate).toHaveBeenCalledExactlyOnceWith({ side: 'left', action: 'skip', expectedAt: required(nextAlarm.alarm, 'alarm fixture').at, expectedRevision: nextAlarm.revision })
  expect(mock.invalidate).not.toHaveBeenCalled()
})

it('retains a time draft after a lost response, then requires review after a competing change', async () => {
  mock.nextAlarm = nextAlarm
  mock.mutate.mockRejectedValue(new Error('Offline'))
  const { rerender } = render(<AlarmCard side="left" />)
  fireEvent.click(screen.getByRole('button', { name: 'Change this time' }))
  fireEvent.change(screen.getByLabelText('One-time wake time'), { target: { value: '08:00' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save one-time alarm' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('not confirmed'))
  expect((screen.getByLabelText('One-time wake time') as HTMLInputElement).value).toBe('08:00')
  expect((screen.getByRole('button', { name: 'Save one-time alarm' }) as HTMLButtonElement).disabled).toBe(true)
  mock.nextAlarm = { ...nextAlarm, revision: 'b'.repeat(64) }
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved alarm' }))
  await waitFor(() => expect(mock.refresh).toHaveBeenCalledOnce())
  rerender(<AlarmCard side="left" />)
  expect(screen.getByText(/saved alarm changed/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Save one-time alarm' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByLabelText('One-time wake time') as HTMLInputElement).value).toBe('08:00')
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
  mock.nextAlarm = { ...nextAlarm, state: 'none', alarm: null, canChange: false }
  rerender(<>{cards}</>)
  // Give each mocked query a fresh render after its response changes.
  rerender(<div>{cards}</div>)
  expect(screen.getByText('No alarm set')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add alarm' }))
  expect(screen.getByText('alarm editor')).toBeTruthy()
  expect(screen.getByText('No schedule tonight')).toBeTruthy()
  expect(screen.getByText('No sleep recorded yet')).toBeTruthy()
  mock.error = new Error('Offline')
  rerender(<section>{cards}</section>)
  expect(screen.getByText('Alarm unavailable')).toBeTruthy()
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

it('shows complete-night recording coverage instead of the latest fragment', () => {
  const start = new Date('2026-11-06T22:00:00Z').getTime()
  mock.latest = { recording: { nightDate: '2026-11-06', recordIds: [40, 41, 42, 43], start, end: start + 9 * 3600000,
    durationMs: 8 * 3600000, gapsMs: 3600000, exits: 4 },
  epochs: [{ heartRate: 56, hrv: 35, breathingRate: 14 }, { heartRate: 60, hrv: 45, breathingRate: 16 }] }
  render(<LastNightCard side="left" name="Alex" />)
  expect(screen.getByText('8h')).toBeTruthy()
  expect(screen.getByText('58')).toBeTruthy()
  expect(screen.getByText(/4 segments. Unknown gaps are excluded/)).toBeTruthy()
  expect(screen.getByText(/4 exits$/)).toBeTruthy()
  expect(mock.vitalsInput).not.toHaveBeenCalled()
})
