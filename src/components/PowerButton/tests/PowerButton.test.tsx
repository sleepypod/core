import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PowerButton } from '../PowerButton'

const state = vi.hoisted(() => ({
  activeSides: ['left'] as Array<'left' | 'right'>,
  primarySide: 'left' as 'left' | 'right',
  status: null as { leftSide: { targetLevel: number }, rightSide: { targetLevel: number } } | null,
  pending: false,
  mutate: vi.fn<(input: { side: string, powered: boolean, temperature?: number }) => Promise<void>>(),
  invalidate: vi.fn(),
  onSuccess: () => {},
}))
vi.mock('@/src/providers/SideProvider', () => ({ useSide: () => state }))
vi.mock('@/src/hooks/useDeviceStatus', () => ({ useDeviceStatus: () => ({ status: state.status }) }))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ device: { getStatus: { invalidate: state.invalidate } } }),
    device: { setPower: { useMutation: (options: { onSuccess: () => void }) => {
      state.onSuccess = options.onSuccess
      return { isPending: state.pending, mutateAsync: state.mutate }
    } } },
  },
}))

function status() {
  if (!state.status) throw new Error('Status fixture is absent')
  return state.status
}

beforeEach(() => {
  vi.useFakeTimers()
  state.activeSides = ['left']
  state.primarySide = 'left'
  state.status = { leftSide: { targetLevel: 0 }, rightSide: { targetLevel: 0 } }
  state.pending = false
  state.invalidate.mockReset()
  state.mutate.mockReset().mockImplementation(async () => {
    state.onSuccess()
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function click(name: 'Turn on' | 'Turn off') {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

describe('PowerButton', () => {
  it('turns on a selected side at the neutral setpoint and holds optimism across stale frames', async () => {
    const { rerender } = render(<PowerButton />)
    await click('Turn on')
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith({ side: 'left', powered: true, temperature: 75 })
    expect(state.invalidate).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    rerender(<PowerButton />)
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(5999))
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  })

  it('follows subsequent server changes once power has been acknowledged', async () => {
    const { rerender } = render(<PowerButton />)
    await click('Turn on')
    status().leftSide.targetLevel = 1
    rerender(<PowerButton />)
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    status().leftSide.targetLevel = 0
    rerender(<PowerButton />)
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  })

  it('uses the right primary side and powers it off without sending a temperature', async () => {
    state.primarySide = 'right'
    state.activeSides = ['right']
    status().rightSide.targetLevel = -10
    render(<PowerButton />)
    await click('Turn off')
    expect(state.mutate.mock.calls).toEqual([[{ side: 'right', powered: false }]])
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  })

  it.each([true, false])('sends linked power=%s to both sides', async (powered) => {
    state.activeSides = ['left', 'right']
    status().leftSide.targetLevel = powered ? 0 : 10
    render(<PowerButton />)
    await click(powered ? 'Turn on' : 'Turn off')
    expect(state.mutate.mock.calls).toEqual(powered
      ? [[{ side: 'left', powered: true, temperature: 75 }], [{ side: 'right', powered: true, temperature: 75 }]]
      : [[{ side: 'left', powered: false }], [{ side: 'right', powered: false }]])
  })

  it('reverts optimism and refetches after one linked-side mutation fails', async () => {
    state.activeSides = ['left', 'right']
    state.mutate.mockImplementation(async ({ side }) => {
      if (side === 'right') throw new Error('right DAC rejected write')
      state.onSuccess()
    })
    render(<PowerButton />)
    await click('Turn on')
    expect(state.mutate).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
    expect(state.invalidate).toHaveBeenCalledTimes(2) // success + recovery refetch
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows optimism while a mutation is unresolved and disables further clicks while pending', async () => {
    let resolve!: () => void
    state.mutate.mockImplementation(() => new Promise<void>((done) => {
      resolve = done
    }))
    const { rerender } = render(<PowerButton />)
    await click('Turn on')
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
    state.pending = true
    rerender(<PowerButton />)
    const button = screen.getByRole('button', { name: 'Turn off' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(state.mutate).toHaveBeenCalledOnce()
    await act(async () => {
      resolve()
    })
  })

  it('starts off before the first status frame arrives', () => {
    state.status = null
    render(<PowerButton />)
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
  })
})
