import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseStatus } from '@/src/hardware/base/types'
import { BasePage } from '../BasePage'
const mock = vi.hoisted(() => ({
  status: {} as BaseStatus, pending: false, error: null as { message: string } | null,
  position: vi.fn(), stop: vi.fn(), reconnect: vi.fn(),
  failure: null as null | ((error: { message: string }) => void),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/en/base' }))
vi.mock('../BaseSchedules', () => ({ BaseSchedules: () => <div>Schedules</div> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  settings: { getAll: { useQuery: () => ({ data: { sides: { left: { name: 'Jon' }, right: { name: 'Heidi' } } } }) } },
  base: {
    getStatus: { useQuery: () => ({ data: mock.status, isLoading: false, isError: !!mock.error, error: mock.error, refetch: vi.fn() }) },
    setPosition: { useMutation: (opts: { onError: (error: { message: string }) => void }) => {
      mock.failure = opts.onError
      return { mutate: mock.position, isPending: mock.pending }
    } },
    stop: { useMutation: () => ({ mutate: mock.stop }) },
    reconnect: { useMutation: () => ({ mutate: mock.reconnect }) },
  },
} }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  localStorage.clear()
  mock.pending = false
  mock.error = null
  mock.status = { state: 'connected', splitBase: true, independentControl: true, movingBySide: { left: false, right: false }, position: { left: { head: 1, feet: 5 }, right: { head: 30, feet: 15 } }, stale: false, moving: false, lastUpdate: Date.now(), busy: false, error: null }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const left = () => within(screen.getByRole('region', { name: 'Jon base controls' }))
const right = () => within(screen.getByRole('region', { name: 'Heidi base controls' }))
const single = () => fireEvent.click(screen.getByRole('button', { name: 'Single card' }))
const instant = () => screen.getByRole('checkbox', { name: 'Move immediately when selecting a preset' })

describe('per-side base controls', () => {
  it('edits targets without movement or changing measured profiles, then moves only that side', async () => {
    render(<BasePage />)
    const measured = (await screen.findByTestId('bed-left')).innerHTML
    fireEvent.click(screen.getByRole('button', { name: 'Raise Jon head' }))
    expect(mock.position).not.toHaveBeenCalled()
    expect(screen.getByTestId('bed-left').innerHTML).toBe(measured)
    fireEvent.click(left().getByRole('button', { name: 'Move to 1° / 0°' }))
    expect(mock.position).toHaveBeenCalledWith({ head: 1, feet: 0, feedRate: 50, sides: ['left'] })
  })
  it('copies the left target when linking, edits both from either card, and preserves targets on unlink', () => {
    render(<BasePage />)
    fireEvent.click(left().getByRole('button', { name: 'read 40° / 0°' }))
    fireEvent.click(right().getByRole('button', { name: 'sleep 1° / 5°' }))
    fireEvent.click(screen.getByRole('switch'))
    expect(right().getByLabelText('Heidi head target').textContent).toBe('40°')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Heidi feet' }))
    expect(left().getByLabelText('Jon feet target').textContent).toBe('1°')
    fireEvent.click(right().getByRole('button', { name: 'Move both to 40° / 1°' }))
    expect(mock.position).toHaveBeenLastCalledWith({ head: 40, feet: 1, feedRate: 50, sides: ['left', 'right'] })
    fireEvent.click(screen.getByRole('switch'))
    expect(right().getByLabelText('Heidi feet target').textContent).toBe('1°')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Jon feet' }))
    expect(right().getByLabelText('Heidi feet target').textContent).toBe('1°')
  })
  it('persists layout, scope, link and instant-preset preferences across remounts', () => {
    const view = render(<BasePage />)
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(instant())
    single()
    fireEvent.click(screen.getByRole('button', { name: 'Heidi' }))
    view.unmount()
    render(<BasePage />)
    expect(screen.getByRole('button', { name: 'Heidi' }).getAttribute('aria-pressed')).toBe('true')
    expect((instant() as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Side cards' }))
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })
  it('applies presets without moving by default; the preference sends scoped targets and shared speed', () => {
    render(<BasePage />)
    fireEvent.click(left().getByRole('button', { name: 'relax 30° / 15°' }))
    expect(mock.position).not.toHaveBeenCalled()
    fireEvent.click(instant())
    fireEvent.click(screen.getByRole('button', { name: '75%' }))
    fireEvent.click(right().getByRole('button', { name: 'read 40° / 0°' }))
    expect(mock.position).toHaveBeenCalledWith({ head: 40, feet: 0, feedRate: 75, sides: ['right'] })
  })
  it('shows mixed targets in Both and applies an edit to both', () => {
    render(<BasePage />)
    fireEvent.click(left().getByRole('button', { name: 'relax 30° / 15°' }))
    single()
    expect(screen.getByText('Sides differ. Showing Jon; a change applies to both.')).toBeTruthy()
    expect(screen.getByLabelText('both head target').textContent).toBe('30°')
    fireEvent.click(screen.getByRole('button', { name: 'Raise both head' }))
    expect(screen.queryByText(/Sides differ/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Move both to 31° / 15°' }))
    expect(mock.position).toHaveBeenCalledWith({ head: 31, feet: 15, feedRate: 50, sides: ['left', 'right'] })
  })
  it('switches selection and labels matching presets', () => {
    render(<BasePage />)
    single()
    fireEvent.click(screen.getByRole('button', { name: 'Heidi' }))
    expect(screen.getByRole('button', { name: 'relax 30° / 15°' }).textContent).toContain('Heidi')
    fireEvent.click(screen.getByRole('button', { name: 'read 40° / 0°' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Heidi to 40° / 0°' }))
    expect(mock.position).toHaveBeenCalledWith({ head: 40, feet: 0, feedRate: 50, sides: ['right'] })
  })
  it('reads out measured angles as text under each bed view', async () => {
    render(<BasePage />)
    expect(screen.getAllByTestId('bed-readout').map(node => node.textContent)).toEqual(['Jon 1° / 5°', 'Heidi 30° / 15°'])
    single()
    expect(screen.getByTestId('bed-readout').textContent).toBe('Jon 1° / 5° · Heidi 30° / 15°')
    expect(await screen.findByTestId('bed-right')).toBeTruthy()
  })
  it('persists the mattress and simple-view preferences', () => {
    const view = render(<BasePage />)
    expect(document.querySelector('rect[rx="8"]')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show mattress' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Simple bed view' }))
    expect(document.querySelectorAll('rect[rx="8"]')).toHaveLength(2)
    view.unmount()
    render(<BasePage />)
    expect((screen.getByRole('checkbox', { name: 'Show mattress' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Simple bed view' }) as HTMLInputElement).checked).toBe(true)
  })
  it('disables move at the measured target and tracks motion independently', () => {
    mock.status.movingBySide.right = true
    render(<BasePage />)
    fireEvent.click(left().getByRole('button', { name: 'sleep 1° / 5°' }))
    expect((left().getByRole('button', { name: 'At target' }) as HTMLButtonElement).disabled).toBe(true)
    expect((right().getByRole('button', { name: 'Moving' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Stop both' }))
    expect(mock.stop).toHaveBeenCalledWith({})
  })
  it('enforces calibrated bounds and does not offer unsupported speed', () => {
    render(<BasePage />)
    expect((screen.getByRole('button', { name: 'Lower Jon head' }) as HTMLButtonElement).disabled).toBe(true)
    const head = screen.getByRole('button', { name: 'Raise Jon head' })
    const feet = screen.getByRole('button', { name: 'Raise Jon feet' })
    for (let i = 0; i < 61; i++) fireEvent.click(head)
    for (let i = 0; i < 46; i++) fireEvent.click(feet)
    expect(screen.getByLabelText('Jon head target').textContent).toBe('60°')
    expect(screen.getByLabelText('Jon feet target').textContent).toBe('45°')
    expect((screen.getByRole('button', { name: 'Raise Jon head' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Raise Jon feet' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '25%' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it.each(['unconfigured', 'disconnected'] as const)('keeps stop enabled and hides measurements when %s', (state) => {
    mock.status.state = state
    render(<BasePage />)
    expect(screen.getAllByTestId('bed-readout').map(node => node.textContent)).toEqual(['Jon — / —', 'Heidi — / —'])
    expect(document.querySelector('fieldset')?.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Stop both' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Stop both' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(mock.stop).toHaveBeenCalledOnce()
    expect(mock.reconnect).toHaveBeenCalledOnce()
  })
  it('blocks cached status after query errors and keeps stop enabled while commands are pending', () => {
    mock.error = { message: 'Connection lost' }
    mock.pending = true
    render(<BasePage />)
    expect(screen.getAllByTestId('bed-readout')[0].textContent).toBe('Jon — / —')
    fireEvent.click(screen.getByRole('button', { name: 'Stop both' }))
    expect(mock.stop).toHaveBeenCalledOnce()
    expect(screen.getByText('Connection lost')).toBeTruthy()
  })
  it('falls back to whole-bed control for synchronized hardware', () => {
    mock.status.independentControl = false
    render(<BasePage />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Selected sides' })).toBeNull()
    expect(screen.queryByTestId('bed-right')).toBeNull()
    expect(screen.getByTestId('bed-readout').textContent).toBe('Jon · Heidi 1° / 5°')
    fireEvent.click(screen.getByRole('button', { name: 'read 40° / 0°' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move both to 40° / 0°' }))
    expect(mock.position).toHaveBeenCalledWith({ head: 40, feet: 0, feedRate: 50, sides: ['left', 'right'] })
  })
  it('renders command failures', () => {
    render(<BasePage />)
    act(() => mock.failure?.({ message: 'Bluetooth write failed' }))
    expect(screen.getByRole('alert').textContent).toBe('Bluetooth write failed')
  })
})
