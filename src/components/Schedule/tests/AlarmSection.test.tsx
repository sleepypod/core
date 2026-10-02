import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  query: { data: undefined as unknown, isLoading: false, error: null as Error | null },
  batch: { mutateAsync: vi.fn(), isPending: false },
  setAlarm: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null as Error | null },
  clearAlarm: { mutate: vi.fn(), isPending: false },
  invalidate: vi.fn(),
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    schedules: {
      getAll: { useQuery: () => m.query },
      batchUpdate: { useMutation: () => m.batch },
    },
    device: { setAlarm: { useMutation: () => m.setAlarm }, clearAlarm: { useMutation: () => m.clearAlarm } },
    useUtils: () => ({ schedules: { getAll: { invalidate: m.invalidate }, getByDay: { invalidate: m.invalidate } } }),
  },
}))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Jon', rightName: 'Heidi' }) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))

import { AlarmSection, groupAlarms } from '../AlarmSection'

const row = (id: number, dayOfWeek: string, over: Record<string, unknown> = {}) => ({
  id, side: 'left', dayOfWeek, time: '06:45', vibrationIntensity: 100, vibrationPattern: 'rise', duration: 10, alarmTemperature: 84, enabled: true, ...over,
})

beforeEach(() => {
  m.query = { data: undefined, isLoading: false, error: null }
  m.batch.mutateAsync.mockReset().mockResolvedValue(undefined)
  m.setAlarm.mutate.mockReset()
  m.setAlarm.error = null
  m.invalidate.mockReset()
})
afterEach(cleanup)

describe('groupAlarms', () => {
  it('merges rows that differ only by day and sorts groups by time and days Sun-first', () => {
    const groups = groupAlarms([
      row(1, 'friday'),
      row(2, 'monday'),
      row(3, 'sunday', { time: '08:00', enabled: false }),
      row(4, 'saturday', { time: '08:00', enabled: false }),
      row(5, 'tuesday', { duration: 30 }),
    ] as never)
    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ ids: [1, 2], days: ['monday', 'friday'], time: '06:45' })
    expect(groups[1]).toMatchObject({ ids: [5], duration: 30 })
    expect(groups[2]).toMatchObject({ ids: [3, 4], days: ['sunday', 'saturday'], enabled: false })
  })
})

describe('AlarmSection', () => {
  it('shows a skeleton while loading and no count', () => {
    m.query = { data: undefined, isLoading: true, error: null }
    const s = render(<AlarmSection side="left" />)
    expect(s.container.querySelector('.animate-pulse')).not.toBeNull()
    expect(s.queryByRole('button', { name: 'Add alarm' })).toBeNull()
  })

  it('shows load errors inline', () => {
    m.query = { data: undefined, isLoading: false, error: new Error('boom') }
    const s = render(<AlarmSection side="left" />)
    expect(s.getByText(/Failed to load alarms:.*boom/)).toBeTruthy()
  })

  it('renders grouped cards with real vibration details and a count', () => {
    m.query = { data: { alarm: [row(1, 'saturday', { enabled: false }), row(2, 'sunday', { enabled: false })] }, isLoading: false, error: null }
    const s = render(<AlarmSection side="left" />)
    expect(s.getByText('6:45 AM')).toBeTruthy()
    expect(s.getByText('10s buzz · rise · 84°')).toBeTruthy()
    expect(s.getByText('paused')).toBeTruthy()
    expect(s.getByText('1')).toBeTruthy()
  })

  it('tests an alarm on the listed side with its stored vibration', () => {
    m.query = { data: { alarm: [row(1, 'monday', { vibrationPattern: 'double', vibrationIntensity: 50 })] }, isLoading: false, error: null }
    const s = render(<AlarmSection side="right" />)
    fireEvent.click(s.getByRole('button', { name: 'Test Mon alarm' }))
    expect(m.setAlarm.mutate).toHaveBeenCalledWith(
      { side: 'right', vibrationIntensity: 50, vibrationPattern: 'double', duration: 10 },
      expect.objectContaining({ onSettled: expect.any(Function) }),
    )
  })

  it('opens the editor from a card and deletes through the confirmation dialog', async () => {
    m.query = { data: { alarm: [row(7, 'monday'), row(8, 'tuesday')] }, isLoading: false, error: null }
    const s = render(<AlarmSection side="left" />)
    fireEvent.click(s.getByText('6:45 AM'))
    const dialog = s.getByRole('dialog')
    expect(within(dialog).getByText('Edit alarm')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    const confirm = s.getByRole('dialog')
    expect(within(confirm).getByText('Delete alarm?')).toBeTruthy()
    expect(within(confirm).getByText(/remove the alarm for 2 days/)).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(s.queryByRole('dialog')).toBeNull())
    expect(m.batch.mutateAsync).toHaveBeenCalledWith({ deletes: { alarm: [7, 8] } })
    expect(m.invalidate).toHaveBeenCalled()
  })

  it('keeps the confirmation open with Retry when the delete fails', async () => {
    m.batch.mutateAsync.mockRejectedValue(new Error('locked'))
    m.query = { data: { alarm: [row(7, 'monday')] }, isLoading: false, error: null }
    const s = render(<AlarmSection side="left" />)
    fireEvent.click(s.getByRole('button', { name: 'Edit Mon alarm' }))
    fireEvent.click(within(s.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(s.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(s.getByText(/Couldn't delete: locked/)).toBeTruthy())
    expect(s.getByRole('button', { name: 'Retry' })).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: 'Cancel' }))
    expect(s.queryByRole('dialog')).toBeNull()
  })

  it('opens a new alarm seeded with the page side selection', () => {
    m.query = { data: { alarm: [] }, isLoading: false, error: null }
    const s = render(<AlarmSection side="left" selectedSide="both" />)
    fireEvent.click(s.getByRole('button', { name: 'Add alarm' }))
    const dialog = s.getByRole('dialog')
    expect(within(dialog).getByText('New alarm')).toBeTruthy()
    expect(within(dialog).getByRole('tab', { name: 'Both' }).getAttribute('aria-selected')).toBe('true')
  })
})
