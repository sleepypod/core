import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ config: undefined as unknown }))
vi.mock('@/src/utils/trpc', async () => {
  const { editConfig, emptyConfig } = await import('@/src/remote/model')
  mocks.config = emptyConfig()
  const endpoint = (data: unknown) => ({ useQuery: () => ({ data, isLoading: false }), useMutation: () => ({ mutate: vi.fn(), isPending: false }) })
  const cache = { invalidate: vi.fn() }
  return { trpc: {
    remote: {
      mapping: { useQuery: () => ({ data: mocks.config, isLoading: false, refetch: vi.fn() }) },
      update: { useMutation: () => ({ isPending: false, mutate: (input: { side: 'left' | 'right', edit: Parameters<typeof editConfig>[2] }, callbacks: { onSuccess: () => void }) => {
        mocks.config = editConfig(mocks.config as ReturnType<typeof emptyConfig>, input.side, input.edit)
        callbacks.onSuccess()
      } }) },
    },
    automations: {
      list: endpoint([]), status: endpoint({ rules: [], globalEnabled: true }), runs: endpoint([]),
      create: endpoint(null), update: endpoint(null), setEnabled: endpoint(null), setDryRun: endpoint(null), setKillSwitch: endpoint(null),
    },
    useUtils: () => ({ remote: { mapping: { setData: vi.fn() } }, automations: { list: cache, status: cache, runs: cache, getKillSwitch: cache } }),
  } }
})
import { RemoteConsole as RemotePage } from '../RemoteConsole'
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
describe('Remote panel navigation', () => {
  it('opens the mapping panel and preserves the selected remote and saved mapping across screens', async () => {
    vi.useFakeTimers()
    render(<RemotePage />)
    expect(screen.getByRole('heading', { name: 'Remote' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Right remote' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Top · single action' }), { target: { value: 'power.off' } })
    await act(() => vi.advanceTimersByTimeAsync(250))
    expect(screen.getByText('1 remapped')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Live capture' }))
    expect(screen.getByText('Remote capture')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mapping' }))
    expect(screen.getByLabelText('right cover remote')).toBeTruthy()
    expect((screen.getByRole('combobox', { name: 'Top · single action' }) as HTMLSelectElement).value).toBe('power.off')
    expect(screen.queryByRole('button', { name: /Automations/ })).toBeNull()
  })
})
