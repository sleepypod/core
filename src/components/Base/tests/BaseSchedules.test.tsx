import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseSchedules } from '../BaseSchedules'
import type { RouterOutputs } from '@/src/demo/types'
const m = vi.hoisted(() => ({
  rows: [] as RouterOutputs['base']['getSchedules'],
  save: vi.fn(), remove: vi.fn(), loading: false,
  onError: undefined as ((error: { message: string }) => void) | undefined,
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  base: {
    getSchedules: { useQuery: () => ({ data: m.rows, isLoading: m.loading, refetch: vi.fn() }) },
    saveSchedule: { useMutation: (opts: { onError: (error: { message: string }) => void }) => {
      m.onError = opts.onError
      return { mutate: m.save }
    } },
    deleteSchedule: { useMutation: () => ({ mutate: m.remove }) },
  },
  settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'Europe/Berlin' } } }) } },
} }))
const names = { left: 'Jon', right: 'Heidi' }
beforeEach(() => {
  vi.clearAllMocks()
  m.rows = []
  m.loading = false
})
afterEach(cleanup)

describe('base schedule editor', () => {
  it.each([false, true])('saves recurrence, side, named preset and speed (compact=%s)', (compact) => {
    render(<BaseSchedules names={names} independent speed={75} compact={compact} />)
    expect(screen.getByText('Europe/Berlin')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: 'weekdays' } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '23:15' } })
    fireEvent.change(screen.getByLabelText('Schedule side'), { target: { value: 'right' } })
    fireEvent.change(screen.getByLabelText('Schedule preset'), { target: { value: 'read' } })
    fireEvent.click(screen.getByRole('button', { name: compact ? 'Add to schedule' : 'Add' }))
    expect(m.save).toHaveBeenCalledWith({ head: 40, feet: 0, feedRate: 75, dayOfWeek: 'weekdays', time: '23:15', side: 'right', presetName: 'Read', enabled: true })
  })
  it('displays side and recurrence, deletes only the selected row', () => {
    m.rows = [{ id: 4, dayOfWeek: 'weekdays', side: 'left', presetName: 'Relax', time: '22:00', head: 30, feet: 15, feedRate: 50, enabled: true }]
    render(<BaseSchedules names={names} independent speed={50} compact />)
    expect(screen.getByText('Weekdays · Jon')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Weekdays 22:00 Jon' }))
    expect(m.remove).toHaveBeenCalledWith({ id: 4 })
  })
  it('offers only both sides for synchronized hardware and surfaces errors', () => {
    render(<BaseSchedules names={names} independent={false} speed={50} />)
    expect(screen.queryByRole('option', { name: 'Jon' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ side: 'both' }))
    act(() => m.onError?.({ message: 'Time overlaps' }))
    expect(screen.getByRole('alert').textContent).toBe('Time overlaps')
  })
  it('blocks additions until existing schedules load', () => {
    m.loading = true
    render(<BaseSchedules names={names} independent speed={50} />)
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
