import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/src/hooks/useSide', () => ({ useSide: () => ({ side: 'left' }) }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Left', rightName: 'Right' }) }))
vi.mock('@/src/utils/trpc', () => {
  // Resolve mutations synchronously so onSuccess runs inside the click.
  const mutation = (opts?: { onSuccess?: (data: unknown, vars: unknown) => void }) => ({
    mutate: (vars: unknown) => opts?.onSuccess?.({}, vars),
    isPending: false,
    error: null,
  })
  return { trpc: { device: { setAlarm: { useMutation: mutation }, clearAlarm: { useMutation: mutation } } } }
})

import { HapticsTestCard } from '../HapticsTestCard'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('HapticsTestCard', () => {
  it('restarts the timer when the same pattern is played again mid-play', () => {
    render(<HapticsTestCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(8_000))
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    // The first play's 10 s would have ended here; the replay runs to 18 s.
    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(7_100))
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('previews the selected vibration pattern', () => {
    render(<HapticsTestCard />)
    expect(screen.getByText('Test vibration')).toBeTruthy()
    expect(screen.getByTestId('vibration-preview').textContent).toContain('10s of 60s')
    fireEvent.click(screen.getByRole('tab', { name: 'Long' }))
    expect(screen.getByTestId('vibration-preview').textContent).toContain('60s of 60s')
  })
})
