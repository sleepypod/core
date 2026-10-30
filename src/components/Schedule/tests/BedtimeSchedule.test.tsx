import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BedtimeDraft, RoutineSnapshot } from '@/src/lib/bedtimeRoutines'
import { BedtimeRoutineEditor, BedtimeSchedule } from '../BedtimeSchedule'

const mocks = vi.hoisted(() => ({
  query: { data: { canCreate: true, routines: [] as RoutineSnapshot[] }, isLoading: false, error: null as Error | null },
  mutate: vi.fn(), invalidate: vi.fn(), close: vi.fn(),
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  routines: { get: { useQuery: () => mocks.query }, replace: { useMutation: () => ({ mutateAsync: mocks.mutate, isPending: false }) } },
  useUtils: () => ({ routines: { get: { invalidate: mocks.invalidate } }, schedules: { getAll: { invalidate: mocks.invalidate }, getByDay: { invalidate: mocks.invalidate } } }),
} }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '12h' }))

const draft: BedtimeDraft = {
  power: { onTime: '22:00', offTime: '07:00', onTemperature: 75, enabled: false, endAction: 'turn_off' },
  temperatures: [], alarm: null, notes: '',
}
const saturday: RoutineSnapshot = { dayOfWeek: 'saturday', revision: 'a'.repeat(64), draft }
const monday: RoutineSnapshot = { dayOfWeek: 'monday', revision: 'b'.repeat(64), draft: { ...draft, notes: 'Another night' } }
const props = () => ({ side: 'left' as const, name: 'Luca', days: ['saturday' as const], draft, originals: [saturday], onClose: mocks.close })
beforeEach(() => {
  mocks.query = { data: { canCreate: true, routines: [] }, isLoading: false, error: null }
  mocks.mutate.mockReset().mockResolvedValue({ schedulerApplied: true })
  mocks.invalidate.mockReset().mockResolvedValue(undefined)
  mocks.close.mockReset()
})
afterEach(cleanup)

describe('bedtime routine editor', () => {
  it('edits snooze duration and taper while preserving the disabled parent routine', async () => {
    const view = render(<BedtimeRoutineEditor {...props()} />)
    fireEvent.click(view.getByRole('switch', { name: 'Wake alarm enabled' }))
    fireEvent.click(view.getByRole('button', { name: 'Increase Snooze duration' }))
    fireEvent.change(view.getByLabelText('Snooze taper'), { target: { value: '40' } })
    fireEvent.click(view.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(mocks.close).toHaveBeenCalled())
    expect(mocks.mutate.mock.calls[0][0].changes[0].replacement).toMatchObject({
      power: { enabled: false }, alarm: { enabled: true, snoozeDuration: 360, snoozeTaper: 40 },
    })
  })

  it('shows and edits power-only routines without inventing temperature phases', () => {
    mocks.query.data.routines = [saturday]
    const view = render(<BedtimeSchedule side="left" name="Luca" />)
    expect(view.getByText(/next day · Paused/)).toBeTruthy()
    expect(view.getByText('0 temperature phases · Wake alarm off')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Edit Sat' }))
    expect((view.getByLabelText('Power on') as HTMLInputElement).value).toBe('22:00')
    expect((view.getByLabelText('End time') as HTMLInputElement).value).toBe('07:00')
    expect(view.getByRole('switch', { name: 'Routine enabled' }).getAttribute('aria-checked')).toBe('false')
  })

  it('creates a paused routine and sends no writes until save', async () => {
    const view = render(<BedtimeSchedule side="left" name="Luca" />)
    fireEvent.click(view.getByRole('button', { name: 'New routine' }))
    fireEvent.click(view.getByRole('button', { name: 'saturday night' }))
    expect(mocks.mutate).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: draft }] }))
  })

  it('moves the complete night with its original revision and independent power times', async () => {
    const view = render(<BedtimeRoutineEditor {...props()} />)
    fireEvent.click(view.getByRole('button', { name: 'saturday night' }))
    fireEvent.click(view.getByRole('button', { name: 'monday night' }))
    fireEvent.click(view.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(mocks.close).toHaveBeenCalled())
    expect(mocks.mutate).toHaveBeenCalledWith({ side: 'left', changes: [
      { dayOfWeek: 'saturday', expectedRevision: saturday.revision, replacement: null },
      { dayOfWeek: 'monday', expectedRevision: null, replacement: draft },
    ] })
  })

  it('requires confirmation before replacing another selected night', async () => {
    const view = render(<BedtimeRoutineEditor {...props()} originals={[saturday, monday]} />)
    fireEvent.click(view.getByRole('button', { name: 'monday night' }))
    fireEvent.click(view.getByRole('button', { name: 'Save routine' }))
    expect(mocks.mutate).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Replace and save' }))
    await waitFor(() => expect(mocks.close).toHaveBeenCalled())
    expect(mocks.mutate.mock.calls[0][0].changes[1]).toEqual({ dayOfWeek: 'monday', expectedRevision: monday.revision, replacement: draft })
  })

  it('retains the original revision after a refetch and preserves the draft on conflict', async () => {
    mocks.mutate.mockRejectedValue(new Error('The saturday routine changed. Reload the routines before saving your draft.'))
    const view = render(<BedtimeRoutineEditor {...props()} />)
    fireEvent.change(view.getByLabelText('Notes'), { target: { value: 'My unsaved change' } })
    view.rerender(<BedtimeRoutineEditor {...props()} originals={[{ ...saturday, revision: 'c'.repeat(64) }]} />)
    fireEvent.click(view.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(view.getByText(/routine changed/)).toBeTruthy())
    expect(mocks.mutate.mock.calls[0][0].changes[0].expectedRevision).toBe(saturday.revision)
    expect((view.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('My unsaved change')
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('keeps a saved-but-unregistered result visible and prevents stale retries', async () => {
    mocks.mutate.mockResolvedValue({ schedulerApplied: false })
    const view = render(<BedtimeRoutineEditor {...props()} />)
    fireEvent.click(view.getByRole('button', { name: 'Save routine' }))
    await waitFor(() => expect(view.getByText(/scheduler registration is pending/)).toBeTruthy())
    expect((view.getByRole('button', { name: 'Save routine' }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('rejects an enabled phase outside the power window before sending', async () => {
    const invalid = { ...draft, temperatures: [{ time: '12:00', temperature: 75, enabled: true }] }
    const view = render(<BedtimeRoutineEditor {...props()} draft={invalid} />)
    fireEvent.click(view.getByRole('button', { name: 'Save routine' }))
    expect(view.getByText(/must fall between/)).toBeTruthy()
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('deletes all original nights only after confirmation', async () => {
    const view = render(<BedtimeRoutineEditor {...props()} />)
    fireEvent.click(view.getByRole('button', { name: 'Delete routine' }))
    expect(mocks.mutate).not.toHaveBeenCalled()
    fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'Delete routine' }))
    await waitFor(() => expect(mocks.close).toHaveBeenCalled())
    expect(mocks.mutate).toHaveBeenCalledWith({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: saturday.revision, replacement: null }] })
  })
})
