import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SleepRecordActions } from '../SleepRecordActions'

const state = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  invalidate: { records: vi.fn(), latest: vi.fn(), stages: vi.fn() },
  options: {} as Record<string, { onSuccess: () => void }>,
  updateError: null as { message: string } | null,
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({
      biometrics: {
        getSleepRecords: { invalidate: state.invalidate.records },
        getLatestSleep: { invalidate: state.invalidate.latest },
        getSleepStages: { invalidate: state.invalidate.stages },
      },
    }),
    biometrics: {
      updateSleepRecord: {
        useMutation: (opts: { onSuccess: () => void }) => {
          state.options.update = opts
          return { mutate: state.update, reset: vi.fn(), isPending: false, error: state.updateError }
        },
      },
      deleteSleepRecord: {
        useMutation: (opts: { onSuccess: () => void }) => {
          state.options.remove = opts
          return { mutate: state.remove, reset: vi.fn(), isPending: false, error: null }
        },
      },
    },
  },
}))

const bed = new Date(2026, 8, 27, 23, 20)
const wake = new Date(2026, 8, 28, 6, 52)

beforeEach(() => {
  vi.clearAllMocks()
  state.updateError = null
})
afterEach(cleanup)

describe('SleepRecordActions', () => {
  it('opens the editor prefilled and saves both times', () => {
    const done = vi.fn()
    render(<SleepRecordActions recordId={7} enteredBedAt={bed} leftBedAt={wake} onActionComplete={done} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit times' }))
    const bedInput = screen.getByLabelText('Bedtime') as HTMLInputElement
    expect(bedInput.value).toBe('2026-09-27T23:20')
    expect((screen.getByLabelText('Wake') as HTMLInputElement).value).toBe('2026-09-28T06:52')
    fireEvent.change(bedInput, { target: { value: '2026-09-27T22:50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(state.update).toHaveBeenCalledWith({ id: 7, enteredBedAt: new Date(2026, 8, 27, 22, 50), leftBedAt: wake })

    state.options.update.onSuccess()
    expect(state.invalidate.records).toHaveBeenCalled()
    expect(state.invalidate.latest).toHaveBeenCalled()
    expect(state.invalidate.stages).toHaveBeenCalled()
    expect(done).toHaveBeenCalled()
  })

  it('omits the wake time for an open session', () => {
    render(<SleepRecordActions recordId={7} enteredBedAt={bed} leftBedAt={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit times' }))
    expect((screen.getByLabelText('Wake') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(state.update).toHaveBeenCalledWith({ id: 7, enteredBedAt: bed })
  })

  it('requires a confirmation tap before deleting', () => {
    render(<SleepRecordActions recordId={9} enteredBedAt={bed} leftBedAt={wake} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit times' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(state.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect(state.remove).toHaveBeenCalledWith({ id: 9 })
  })

  it('shows mutation errors inline', () => {
    state.updateError = { message: 'leftBedAt must be after enteredBedAt' }
    render(<SleepRecordActions recordId={7} enteredBedAt={bed} leftBedAt={wake} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit times' }))
    expect(screen.getByText('leftBedAt must be after enteredBedAt')).toBeTruthy()
  })
})
