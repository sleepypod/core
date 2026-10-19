import { fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RECORDING_POLICY } from '@/src/lib/recordingPolicy'
const mock = vi.hoisted(() => ({ data: {} as Record<string, unknown>, mutate: vi.fn(), pending: false, error: null as null | Error }))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ system: { getRecordingPolicy: { setData: vi.fn() } } }),
    system: {
      getRecordingPolicy: { useQuery: () => ({ data: mock.data, isPending: false, error: null }) },
      setRecordingPolicy: { useMutation: () => ({ mutate: mock.mutate, isPending: mock.pending, error: mock.error }) },
    },
  },
}))
import { DataRecordingCard } from '../DataRecordingCard'
beforeEach(() => {
  mock.data = { ...DEFAULT_RECORDING_POLICY }
  mock.mutate.mockReset()
  mock.pending = false
  mock.error = null
})
afterEach(() => vi.useRealTimers())

describe('data recording controls', () => {
  it('changes logging and Health recording independently', () => {
    render(<DataRecordingCard />)
    fireEvent.change(screen.getByRole('combobox', { name: 'App logging mode' }), { target: { value: 'off' } })
    expect(mock.mutate).toHaveBeenLastCalledWith({ loggingMode: 'off' })
    fireEvent.click(screen.getByRole('switch', { name: 'Record Health timeline' }))
    expect(mock.mutate).toHaveBeenLastCalledWith({ healthHistory: false })
    expect(screen.getByText(/Biometric history stays enabled/)).toBeTruthy()
  })

  it('requires confirmation before discarding pending raw waveforms', () => {
    render(<DataRecordingCard />)
    fireEvent.click(screen.getByRole('switch', { name: 'Record raw waveform archive' }))
    expect(mock.mutate).not.toHaveBeenCalled()
    expect(screen.getByText(/Pending, unsaved waveforms/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop archiving' }))
    expect(mock.mutate).toHaveBeenCalledWith({ rawArchive: false })
  })

  it('starts a bounded debug session and reflects expiry without saving again', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    mock.data = { ...DEFAULT_RECORDING_POLICY, loggingMode: 'off', debugUntil: 2000 }
    render(<DataRecordingCard />)
    expect(screen.getByText(/returns to Off in 1 min/)).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('Logging: Off')).toBeTruthy()
    expect(mock.mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Debug for 15 minutes' }))
    expect(mock.mutate).toHaveBeenCalledWith({ debug: true })
  })

  it('disables conflicting changes while saving and reports errors without claiming success', () => {
    mock.pending = true
    mock.error = new Error('Read-only filesystem')
    render(<DataRecordingCard />)
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText('Read-only filesystem')).toBeTruthy()
  })
})
