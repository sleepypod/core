import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig } from '@/src/remote/model'

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  mutate: vi.fn(), refetch: vi.fn(), setData: vi.fn(),
  onSuccess: undefined as ((data: unknown) => void) | undefined,
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  remote: {
    mapping: { useQuery: () => ({ data: mocks.data, isLoading: false, error: null, refetch: mocks.refetch }) },
    update: { useMutation: (options: { onSuccess: (data: unknown) => void }) => {
      mocks.onSuccess = options.onSuccess
      return { mutate: mocks.mutate, isPending: false }
    } },
  },
  useUtils: () => ({ remote: { mapping: { setData: mocks.setData } } }),
} }))
import { useRemoteMapping } from '../RemotePanel'

describe('device mapping save lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.data = { ...emptyConfig(), revision: 7 }
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })
  it('debounces a versioned edit and prevents overlapping writes', () => {
    const { result } = renderHook(useRemoteMapping)
    act(() => result.current.save('left', { kind: 'set', input: 'top.single', binding: { action: 'none' } }))
    expect(result.current.busy).toBe(true)
    act(() => result.current.save('right', { kind: 'resetSide' }))
    act(() => vi.advanceTimersByTime(249))
    expect(mocks.mutate).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({ side: 'left', revision: 7, edit: { kind: 'set', input: 'top.single', binding: { action: 'none' } } }, expect.any(Object))
    const saved = { ...emptyConfig(), revision: 8 }
    act(() => {
      mocks.onSuccess?.(saved)
      mocks.mutate.mock.calls[0][1].onSuccess()
    })
    expect(mocks.setData).toHaveBeenCalledWith({}, saved)
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toBeUndefined()
  })
  it('surfaces save conflicts and reloads before allowing a new edit', () => {
    const { result } = renderHook(useRemoteMapping)
    act(() => result.current.save('right', { kind: 'copy' }))
    act(() => vi.advanceTimersByTime(250))
    act(() => mocks.mutate.mock.calls[0][1].onError(new Error('Mapping changed elsewhere')))
    expect(result.current.error).toBe('Mapping changed elsewhere')
    expect(mocks.refetch).toHaveBeenCalledTimes(1)
    expect(result.current.busy).toBe(false)
    act(() => result.current.reload())
    expect(result.current.error).toBeUndefined()
  })
  it('flushes an unsent edit when navigating out of Autopilot', () => {
    const { result, unmount } = renderHook(useRemoteMapping)
    act(() => result.current.save('left', { kind: 'add', input: 'top.double' }))
    unmount()
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(1000))
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
  })
})
