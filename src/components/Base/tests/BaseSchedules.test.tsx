import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseSchedules } from '../BaseSchedules'
import type { BasePosition } from '@/src/hardware/base/types'
const m = vi.hoisted(() => ({
  rows: [] as Array<{ id: number, head: number, feet: number, feedRate: number, enabled: boolean, dayOfWeek: 'monday', time: string }>,
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
function Editor() {
  const [target, setTarget] = useState<BasePosition>({ head: 20, feet: 10, feedRate: 60 })
  return <BaseSchedules target={target} onSelectTarget={setTarget} />
}
beforeEach(() => {
  vi.clearAllMocks()
  m.rows = []
  m.loading = false
})
afterEach(cleanup)

describe('base schedule editor', () => {
  it('saves selected targets on the selected calendar day and time', () => {
    render(<Editor />)
    expect(screen.getByText(/Europe\/Berlin/)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Day' }), { target: { value: 'tuesday' } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '23:15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add scheduled position' }))
    expect(m.save).toHaveBeenCalledWith({ id: undefined, head: 20, feet: 10, feedRate: 60, dayOfWeek: 'tuesday', time: '23:15', enabled: true })
  })
  it('edits an existing target and preserves its paused state', () => {
    m.rows = [{ id: 3, dayOfWeek: 'monday', time: '22:00', head: 30, feet: 15, feedRate: 50, enabled: false }]
    render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '23:15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save scheduled position' }))
    expect(m.save).toHaveBeenCalledWith({ ...m.rows[0], time: '23:15' })
  })
  it('pauses and deletes only the selected row', () => {
    m.rows = [{ id: 4, dayOfWeek: 'monday', time: '22:00', head: 30, feet: 15, feedRate: 50, enabled: true }]
    render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(m.save).toHaveBeenCalledWith({ ...m.rows[0], enabled: false })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(m.remove).toHaveBeenCalledWith({ id: 4 })
  })
  it('shows failed saves and disables adding until loading completes', () => {
    m.loading = true
    render(<Editor />)
    expect((screen.getByRole('button', { name: 'Add scheduled position' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => m.onError?.({ message: 'Duplicate schedule time' }))
    expect(screen.getByRole('alert').textContent).toBe('Duplicate schedule time')
  })
})
