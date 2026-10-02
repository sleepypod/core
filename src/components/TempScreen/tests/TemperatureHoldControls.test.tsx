import { fireEvent, render, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TemperatureControlStatus } from '@/src/temperature/controller'

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, error: null as Error | null, onSuccess: undefined as (() => void) | undefined }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { device: { resumeTemperature: { useMutation: (options: { onSuccess: () => void }) => {
  mutation.onSuccess = options.onSuccess
  return mutation
} } } } }))
import { HoldDurationRow, HoldStatus, ownershipLabel } from '../TemperatureHoldControls'

const base: TemperatureControlStatus = { source: null, requestId: null, targetTemperature: null, holdUntil: null, blocked: null }
const status: Record<'left' | 'right', TemperatureControlStatus> = {
  left: { source: 'manual', requestId: 'manual', targetTemperature: 76, holdUntil: 1_800_000, blocked: null },
  right: { source: 'schedule', requestId: 'schedule:1', targetTemperature: 70, holdUntil: null, blocked: null },
}
beforeEach(() => {
  mutation.mutate.mockReset()
  mutation.isPending = false
  mutation.error = null
})
afterEach(cleanup)

describe('ownershipLabel', () => {
  it('maps every ownership source and block state', () => {
    expect(ownershipLabel({ ...base, source: 'schedule' }).text).toBe('On schedule')
    expect(ownershipLabel({ ...base, source: 'autopilot' }).text).toBe('Autopilot')
    expect(ownershipLabel({ ...base, source: 'run-once' }).text).toBe('Run-once session')
    expect(ownershipLabel({ ...base, source: 'manual' }).text).toBe('Manual hold')
    expect(ownershipLabel({ ...base, source: 'manual', holdUntil: 1_800_000 }).text).toMatch(/^Manual hold · until /)
    expect(ownershipLabel(base).text).toBe('Manual')
    expect(ownershipLabel({ ...base, source: 'schedule', blocked: 'off' }).text).toBe('Off')
    const safety = ownershipLabel({ ...base, source: 'schedule', blocked: 'safety' })
    expect(safety.text).toBe('Safety stop')
    expect(safety.danger).toBe(true)
  })
})

describe('HoldStatus', () => {
  it('resumes only the side with an active hold', () => {
    const onResumed = vi.fn()
    const screen = render(<HoldStatus side="left" control={status.left} onResumed={onResumed} />)
    expect(screen.getByText(/Manual hold · until/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(mutation.mutate).toHaveBeenCalledExactlyOnceWith({ side: 'left' })
    mutation.onSuccess?.()
    expect(onResumed).toHaveBeenCalledOnce()
  })

  it('shows schedule ownership without a Resume button', () => {
    const screen = render(<HoldStatus side="right" control={status.right} prefix={<span>Right · In bed</span>} onResumed={vi.fn()} />)
    expect(screen.getByText('On schedule')).toBeTruthy()
    expect(screen.getByText('Right · In bed')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders no ownership claim when the controller status is unknown', () => {
    const screen = render(<HoldStatus side="left" control={undefined} onResumed={vi.fn()} />)
    expect(screen.queryByText(/schedule|manual/i)).toBeNull()
  })

  it('shows safety status and a Resume error, disabling repeated requests while pending', () => {
    mutation.isPending = true
    mutation.error = new Error('connection unavailable')
    const screen = render(<HoldStatus side="left" control={{ ...status.left, blocked: 'safety' }} onResumed={vi.fn()} />)
    expect(screen.getByText('Safety stop')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('connection unavailable')
  })
})

describe('HoldDurationRow', () => {
  it('changes the next-adjustment duration without sending a temperature or Resume', () => {
    const onDurationChange = vi.fn()
    const screen = render(<HoldDurationRow holdMinutes={30} onDurationChange={onDurationChange} />)
    const select = screen.getByRole('combobox', { name: 'Temperature hold duration' }) as HTMLSelectElement
    expect(select.value).toBe('30')
    fireEvent.change(select, { target: { value: '60' } })
    expect(onDurationChange).toHaveBeenCalledWith(60)
    expect(mutation.mutate).not.toHaveBeenCalled()
  })
})
