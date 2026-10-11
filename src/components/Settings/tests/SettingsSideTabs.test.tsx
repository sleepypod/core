/**
 * Settings per-side tabs: every per-side card carries its own Left/Right tab
 * strip, all bound to one selection; device-wide cards carry none.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsScreen } from '../SettingsScreen'

const mock = vi.hoisted(() => ({ query: '', data: undefined as unknown }))
vi.mock('next/navigation', () => ({ usePathname: () => '/en/settings', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(mock.query) }))
vi.mock('@/src/utils/trpc', () => {
  const mutation = { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) }
  return { trpc: {
    useUtils: () => ({ settings: { getAll: { invalidate: vi.fn() } } }),
    settings: {
      getAll: { useQuery: () => ({ data: mock.data, isLoading: false, error: null }) },
      updateSide: mutation, updateDevice: mutation, setGesture: mutation, deleteGesture: mutation,
    },
    biometrics: { getOccupancy: { useQuery: () => ({ data: { left: { available: true }, right: { available: false } } }) } },
  } }
})

const side = (s: 'left' | 'right', name: string, extra: Record<string, unknown>) => ({
  side: s, name, awayMode: false, alwaysOn: false, autoOffEnabled: false, autoOffMinutes: 30, ...extra,
})

const gesture = (s: 'left' | 'right', extra: Record<string, unknown>) => ({
  id: s === 'left' ? 1 : 2, side: s, tapType: 'doubleTap', actionType: 'temperature', temperatureChange: 'increment',
  temperatureAmount: 2, alarmBehavior: null, alarmSnoozeDuration: null, alarmInactiveBehavior: null, ...extra,
})

beforeEach(() => {
  mock.data = {
    device: { temperatureUnit: 'F', bedMode: 'two', unusedZoneMode: 'off' },
    sides: {
      left: side('left', 'Alex', { awayMode: true, autoOffEnabled: true, autoOffMinutes: 15 }),
      right: side('right', 'Sam', { autoOffMinutes: 60 }),
    },
    gestures: {
      left: [gesture('left', {})],
      right: [gesture('right', { actionType: 'alarm', temperatureChange: null, temperatureAmount: null, alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' })],
    },
  }
})

const selected = (tablist: HTMLElement) => within(tablist).getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')?.textContent

describe('Settings per-side tabs', () => {
  it('switching the tab on one Sides card switches every per-side card to that side’s values', () => {
    mock.query = 'section=sides'
    render(<SettingsScreen />)

    expect(screen.queryByRole('tablist', { name: 'Person' })).toBeNull()
    const names = ['Profile side', 'Away mode side', 'Auto-off side']
    // Bed setup is device-wide: only the three per-side cards get tabs.
    expect(screen.getAllByRole('tablist').map(t => t.getAttribute('aria-label'))).toEqual(names)
    for (const n of names) expect(selected(screen.getByRole('tablist', { name: n }))).toBe('Alex')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alex')
    expect(screen.getByLabelText('Toggle away mode for Left side').getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText('Auto-off after') as HTMLSelectElement).value).toBe('15')

    fireEvent.click(within(screen.getByRole('tablist', { name: 'Auto-off side' })).getByRole('tab', { name: 'Sam' }))

    for (const n of names) expect(selected(screen.getByRole('tablist', { name: n }))).toBe('Sam')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Sam')
    expect(screen.getByLabelText('Toggle away mode for Right side').getAttribute('aria-checked')).toBe('false')
    expect((screen.getByLabelText('Auto-off after') as HTMLSelectElement).value).toBe('60')
    expect(screen.getByText('Presence unavailable')).toBeTruthy()
  })

  it('switching the tab on one gesture card switches the other and shows that side’s gestures', () => {
    mock.query = 'section=gestures'
    render(<SettingsScreen />)

    const idle = screen.getByRole('tablist', { name: 'Tap gestures side' })
    const ringing = screen.getByRole('tablist', { name: 'While an alarm is ringing side' })
    expect(screen.getAllByRole('tablist')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Double tap: Temperature +2°' })).toBeTruthy()

    fireEvent.click(within(ringing).getByRole('tab', { name: 'Sam' }))

    expect(selected(idle)).toBe('Sam')
    expect(selected(ringing)).toBe('Sam')
    expect(screen.getByRole('button', { name: 'Double tap: Power on / off' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Double tap while ringing: Stop alarm' })).toBeTruthy()

    fireEvent.click(within(idle).getByRole('tab', { name: 'Alex' }))
    expect(selected(ringing)).toBe('Alex')
    expect(screen.getByRole('button', { name: 'Double tap: Temperature +2°' })).toBeTruthy()
  })
})
