import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TonightOverview } from '../TonightOverview'
import type { ComfortStatus } from '@/src/comfort/contract'
import type { NextAlarm } from '@/src/alarms/contract'
import type { readComfortLimit } from '@/src/temperature/limitInstance'
type Limit = ReturnType<typeof readComfortLimit>
interface Query<Value> { data: Value, dataUpdatedAt: number, isError: boolean, isFetching: boolean, refetch: ReturnType<typeof vi.fn> }
const mock = vi.hoisted(() => ({ now: Date.parse('2026-11-10T22:00Z'), comfort: {} as Query<ComfortStatus>, alarm: {} as Query<NextAlarm>, limit: {} as Query<Limit> }))
vi.mock('../TonightCard', () => ({ useNow: () => new Date(mock.now) }))
vi.mock('../LastNightCard', () => ({ LastNightCard: () => <div>Latest actual night</div> }))
vi.mock('next/navigation', () => ({ usePathname: () => '/en' }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  comfort: { get: { useQuery: () => mock.comfort } }, nextAlarm: { get: { useQuery: () => mock.alarm } }, comfortLimit: { get: { useQuery: () => mock.limit } },
} }))
beforeEach(() => {
  mock.now = Date.parse('2026-11-10T22:00Z')
  const query = <Value,>(data: Value) => ({ data, dataUpdatedAt: mock.now, isError: false, isFetching: false, refetch: vi.fn() })
  mock.comfort = query({ side: 'left', generatedAt: mock.now, state: { config: { mode: 'preview' } } } as ComfortStatus)
  mock.alarm = query({ side: 'left', state: 'scheduled', timeZone: 'UTC', alarm: { at: '2026-11-11T07:00Z', duration: 20, alarmTemperatureF: 105 } } as NextAlarm)
  mock.limit = query({ side: 'left', config: { enabled: true, minF: 68, maxF: 72 }, wake: { startsAt: Date.parse('2026-11-11T06:30Z'), alarmAt: Date.parse('2026-11-11T07:00Z'), targetF: 105, timeZone: 'UTC' } } as Limit)
})
afterEach(cleanup)
it('puts Preview, range and the same actual wake occurrence together with direct review links', () => {
  const view = render(<TonightOverview side="left" name="Luca" timeZone="UTC" />)
  expect(view.getByText('Preview · no adjustments')).toBeTruthy()
  expect(view.getByText('68–72°F automatic range')).toBeTruthy()
  expect(view.getByText(/7:00.*20s vibration/)).toBeTruthy()
  expect(view.getByText(/Warming from.*6:30.*105°F/)).toBeTruthy()
  expect(view.getByRole('link', { name: 'Review Autopilot' }).getAttribute('href')).toContain('side=left')
  fireEvent.click(view.getByRole('button', { name: 'Refresh tonight’s plan' }))
  expect(mock.comfort.refetch).toHaveBeenCalledOnce()
  expect(mock.alarm.refetch).toHaveBeenCalledOnce()
  expect(mock.limit.refetch).toHaveBeenCalledOnce()
})
it('withdraws failed configuration and does not combine different alarm revisions', () => {
  mock.comfort.isError = true
  if (mock.limit.data.wake) mock.limit.data.wake.alarmAt += 60_000
  const view = render(<TonightOverview side="left" name="Luca" />)
  expect(view.queryByText('Preview · no adjustments')).toBeNull()
  expect(view.queryByText(/Warming from/)).toBeNull()
  expect(view.getByText('Warming not confirmed · refresh the plan.')).toBeTruthy()
})
it('does not present another side or a past alarm as current', () => {
  mock.now = Date.parse('2026-11-11T07:01Z')
  mock.alarm.dataUpdatedAt = mock.now
  const view = render(<TonightOverview side="left" name="Luca" />)
  expect(view.getByText(/Alarm time passed/)).toBeTruthy()
  view.rerender(<TonightOverview side="right" name="Marissa" />)
  expect(view.queryByText(/Alarm time passed/)).toBeNull()
  expect(view.queryByText(/20s vibration/)).toBeNull()
})
it('leads with a morning review in the Pod timezone', () => {
  mock.now = Date.parse('2026-11-11T16:00Z')
  const view = render(<TonightOverview side="left" name="Luca" timeZone="America/Los_Angeles" />)
  expect(view.getByRole('heading', { name: 'Your morning review' })).toBeTruthy()
  expect(view.getByText('Latest actual night')).toBeTruthy()
})
