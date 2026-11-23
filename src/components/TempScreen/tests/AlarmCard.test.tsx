/**
 * The home screen's alarm card with the real editor: the editor stays on the
 * alarm it was opened on while its own saves refetch, and Delete goes through
 * the same confirmation as the Schedule page.
 */

import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

interface Row {
  id: number
  side: 'left' | 'right'
  dayOfWeek: string
  time: string
  vibrationIntensity: number
  vibrationPattern: 'rise' | 'double'
  duration: number
  alarmTemperature: number
  wakeWindow: number
  snoozeDuration: number
  snoozeTaper: number
  enabled: boolean
}

const m = vi.hoisted(() => ({
  rows: [] as Row[],
  nextId: 100,
  batch: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ schedules: { getAll: { invalidate: m.invalidate }, getByDay: { invalidate: m.invalidate } } }),
    schedules: {
      getAll: { useQuery: ({ side }: { side: string }) => ({ data: { alarm: m.rows.filter(r => r.side === side) }, isLoading: false, error: null }) },
      updateAlarmSchedule: { useMutation: () => ({ mutateAsync: vi.fn(), error: null, isPending: false }) },
      batchUpdate: { useMutation: () => ({ mutateAsync: m.batch, isPending: false }) },
    },
    device: {
      setAlarm: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }) },
      clearAlarm: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Jon', rightName: 'Heidi' }) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
vi.mock('@/src/providers/SideProvider', () => ({ useSingleSleeperSide: () => null }))
// Monday 5:00, before both alarms.
vi.mock('../TonightCard', () => ({ useNow: () => new Date(2026, 10, 16, 5, 0) }))

import { AlarmCard } from '../AlarmCard'

const alarm = (id: number, time: string, over: Partial<Row> = {}): Row => ({
  id, side: 'left', dayOfWeek: 'monday', time, vibrationIntensity: 100, vibrationPattern: 'rise', duration: 10, alarmTemperature: 84, wakeWindow: 0, snoozeDuration: 300, snoozeTaper: 0, enabled: true, ...over,
})

// A fake batchUpdate: delete-then-create on the rows, returning the created ids.
const serve = (input: { deletes?: { alarm?: number[] }, creates?: { alarm?: Omit<Row, 'id'>[] } }) => {
  const deletes = input.deletes?.alarm ?? []
  m.rows = m.rows.filter(r => !deletes.includes(r.id))
  const created = (input.creates?.alarm ?? []).map(c => ({ ...c, id: m.nextId++ }))
  m.rows.push(...created)
  return Promise.resolve({ success: true, created: { temperature: [], power: [], alarm: created.map(r => r.id) } })
}

beforeEach(() => {
  m.rows = [alarm(1, '07:00'), alarm(2, '08:00')]
  m.nextId = 100
  m.batch.mockReset().mockImplementation(serve)
  m.invalidate.mockReset()
})
afterEach(cleanup)

it('keeps editing the opened alarm after its save makes another alarm the next one', async () => {
  const s = render(<AlarmCard side="left" />)
  fireEvent.click(s.getByRole('button', { name: 'Edit 7:00 AM alarm' }))
  const dialog = s.getByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Wake at'), { target: { value: '09:30' } })
  await waitFor(() => expect(m.batch).toHaveBeenCalledTimes(1))
  expect(m.batch.mock.calls[0][0].deletes).toEqual({ alarm: [1] })

  // The refetch: 8:00 is now the next alarm.
  s.rerender(<AlarmCard side="left" />)
  expect(s.getByRole('button', { name: 'Edit 8:00 AM alarm' })).toBeTruthy()
  expect(within(dialog).getByText('9:30')).toBeTruthy()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Increase bed temperature at wake' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(s.queryByRole('dialog')).toBeNull())
  expect(m.batch).toHaveBeenCalledTimes(2)
  expect(m.batch.mock.calls[1][0].deletes).toEqual({ alarm: [100] })
  expect(m.rows).toEqual([
    alarm(2, '08:00'),
    alarm(101, '09:30', { duration: 10, alarmTemperature: 85 }),
  ])
})

it('a "Both sides" save does not reload the editor, and the next save replaces both sides', async () => {
  const s = render(<AlarmCard side="left" />)
  fireEvent.click(s.getByRole('button', { name: 'Edit 7:00 AM alarm' }))
  const dialog = s.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Both' }))
  await waitFor(() => expect(m.batch).toHaveBeenCalledTimes(1))
  // The left side's refetch holds only its half of the new rows.
  s.rerender(<AlarmCard side="left" />)
  expect(within(dialog).getByRole('tab', { name: 'Both' }).getAttribute('aria-selected')).toBe('true')

  fireEvent.click(within(dialog).getByRole('button', { name: 'Increase bed temperature at wake' }))
  await waitFor(() => expect(m.batch).toHaveBeenCalledTimes(2))
  expect(m.batch.mock.calls[1][0].deletes).toEqual({ alarm: [100, 101] })
  expect(m.rows.filter(r => r.time === '07:00').map(r => [r.side, r.alarmTemperature])).toEqual([['left', 85], ['right', 85]])
})

it('offers Delete, through the confirmation, so an alarm with every day cleared can be closed', async () => {
  const s = render(<AlarmCard side="left" />)
  fireEvent.click(s.getByRole('button', { name: 'Edit 7:00 AM alarm' }))
  const dialog = s.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Mon' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
  await within(dialog).findByText('Pick at least one day, or delete the alarm.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

  await s.findByText('Delete alarm?')
  const confirm = s.getByRole('dialog')
  expect(within(confirm).getByText(/remove the alarm for 1 day\./)).toBeTruthy()
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(s.queryByRole('dialog')).toBeNull())
  expect(m.batch).toHaveBeenCalledExactlyOnceWith({ deletes: { alarm: [1] } })
  expect(m.invalidate).toHaveBeenCalled()
  expect(m.rows).toEqual([alarm(2, '08:00')])
})

it('keeps the delete confirmation open with Retry when the delete fails, until cancelled', async () => {
  m.batch.mockRejectedValue(new Error('locked'))
  const s = render(<AlarmCard side="left" />)
  fireEvent.click(s.getByRole('button', { name: 'Edit 7:00 AM alarm' }))
  fireEvent.click(within(s.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
  await s.findByText('Delete alarm?')
  fireEvent.click(within(s.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(s.getByText(/Couldn't delete: locked/)).toBeTruthy())
  expect(s.getByRole('button', { name: 'Retry' })).toBeTruthy()
  fireEvent.click(s.getByRole('button', { name: 'Cancel' }))
  expect(s.queryByRole('dialog')).toBeNull()
  expect(m.rows).toHaveLength(2)
})
