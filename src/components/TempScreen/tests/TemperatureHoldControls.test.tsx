import { fireEvent, render, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TemperatureControlStatus } from '@/src/temperature/controller'

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, error: null as Error | null, onSuccess: undefined as (() => void) | undefined }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { device: { resumeTemperature: { useMutation: (options: { onSuccess: () => void }) => {
  mutation.onSuccess = options.onSuccess
  return mutation
} } } } }))
import { TemperatureHoldControls } from '../TemperatureHoldControls'

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

describe('TemperatureHoldControls', () => {
  it('shows independent ownership and resumes only the side with a hold', () => {
    const onResumed = vi.fn()
    const screen = render(<TemperatureHoldControls sides={['left', 'right']} status={status} holdMinutes={30} onDurationChange={vi.fn()} onResumed={onResumed} />)
    expect(screen.getByText('Right: Schedule')).toBeTruthy()
    expect(screen.getByText(/Left: Manual hold/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(mutation.mutate).toHaveBeenCalledExactlyOnceWith({ side: 'left' })
    mutation.onSuccess?.()
    expect(onResumed).toHaveBeenCalledOnce()
  })

  it('changes the next-adjustment duration without sending a temperature or Resume', () => {
    const onDurationChange = vi.fn()
    const screen = render(<TemperatureHoldControls sides={['right']} status={status} holdMinutes={30} onDurationChange={onDurationChange} onResumed={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Temperature hold duration' }), { target: { value: '60' } })
    expect(onDurationChange).toHaveBeenCalledWith(60)
    expect(mutation.mutate).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows safety status and a Resume error, disabling repeated requests while pending', () => {
    mutation.isPending = true
    mutation.error = new Error('connection unavailable')
    const screen = render(<TemperatureHoldControls sides={['left']} status={{ ...status, left: { ...status.left, blocked: 'safety' } }} holdMinutes={30} onDurationChange={vi.fn()} onResumed={vi.fn()} />)
    expect(screen.getByText(/Left: Safety stop/)).toBeTruthy()
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('connection unavailable')
  })
})
