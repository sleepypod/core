import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseStatus } from '@/src/hardware/base/types'
import { BasePage } from '../BasePage'
const mock = vi.hoisted(() => ({
  status: {} as BaseStatus, pending: false, error: null as { message: string } | null,
  position: vi.fn(), preset: vi.fn(), stop: vi.fn(), reconnect: vi.fn(),
  failure: null as null | ((error: { message: string }) => void),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/en/base' }))
vi.mock('../BaseSchedules', () => ({ BaseSchedules: () => <div>Schedules</div> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { base: {
  getStatus: { useQuery: () => ({ data: mock.status, isLoading: false, isError: !!mock.error, error: mock.error, refetch: vi.fn() }) },
  setPosition: { useMutation: (opts: { onError: (error: { message: string }) => void }) => {
    mock.failure = opts.onError
    return { mutate: mock.position, isPending: mock.pending }
  } },
  setPreset: { useMutation: () => ({ mutate: mock.preset }) },
  stop: { useMutation: () => ({ mutate: mock.stop }) },
  reconnect: { useMutation: () => ({ mutate: mock.reconnect }) },
} } }))
beforeEach(() => {
  vi.clearAllMocks()
  mock.pending = false
  mock.error = null
  mock.status = { state: 'connected', splitBase: true, position: { left: { head: 1, feet: 5 }, right: { head: 30, feet: 15 } }, stale: false, moving: false, lastUpdate: Date.now(), busy: false, error: null }
})
afterEach(cleanup)

describe('Base controls', () => {
  it('requires explicit Apply and keeps measured angles separate from target edits', () => {
    render(<BasePage />)
    fireEvent.change(screen.getByRole('slider', { name: /Head angle/ }), { target: { value: '20' } })
    expect(mock.position).not.toHaveBeenCalled()
    expect(screen.getByText('1° head · 5° feet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Apply position' }))
    expect(mock.position).toHaveBeenCalledWith({ head: 20, feet: 0, feedRate: 50 })
  })
  it('sends exact presets and shows the real relax values', () => {
    render(<BasePage />)
    fireEvent.click(screen.getByRole('button', { name: /relax 30° \/ 15°/i }))
    expect(mock.preset).toHaveBeenCalledWith({ preset: 'relax' })
  })
  it('keeps Stop available while movement is pending', () => {
    mock.pending = true
    render(<BasePage />)
    expect((screen.getByRole('button', { name: 'Sending position…' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Stop movement' }))
    expect(mock.stop).toHaveBeenCalledWith({})
  })
  it('blocks moves on stale telemetry but still permits stop', () => {
    mock.status.stale = true
    render(<BasePage />)
    expect((screen.getByRole('button', { name: 'Apply position' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('1° head · 5° feet')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop movement' }))
    expect(mock.stop).toHaveBeenCalledOnce()
  })
  it('explains absent configuration and supports reconnect', () => {
    mock.status.state = 'unconfigured'
    render(<BasePage />)
    expect(screen.getByText(/Complete the base setup/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Stop movement' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(mock.reconnect).toHaveBeenCalledOnce()
  })
  it('does not enable movement using cached status after a query error', () => {
    mock.error = { message: 'Connection lost' }
    render(<BasePage />)
    expect((screen.getByRole('button', { name: 'Apply position' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Connection lost')).toBeTruthy()
  })
})
