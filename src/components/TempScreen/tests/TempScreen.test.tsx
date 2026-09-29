/**
 * TempScreen behavior: per-side ± / power wiring, clamp, Link sides mirroring,
 * hold-duration forwarding, away / presence lines and the loading state.
 * Context cards and the phone switcher are stubbed — they have their own data.
 */

import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  setTemp: vi.fn(),
  setPower: vi.fn(),
  refetch: vi.fn(),
  toggleLink: vi.fn(),
  side: { isLinked: false, primarySide: 'left' as 'left' | 'right' },
  statusLoading: false,
  status: undefined as unknown,
  settings: undefined as unknown,
  occupancy: undefined as unknown,
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    device: {
      setTemperature: { useMutation: () => ({ mutate: m.setTemp, isPending: false }) },
      setPower: { useMutation: () => ({ mutate: m.setPower, isPending: false }) },
      resumeTemperature: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
      getStatus: { useQuery: () => ({ data: { podVersion: 'J00' } }) },
    },
    settings: { getAll: { useQuery: () => ({ data: m.settings }) } },
    biometrics: { getOccupancy: { useQuery: () => ({ data: m.occupancy }) } },
  },
}))
vi.mock('@/src/hooks/useDeviceStatus', () => ({
  useDeviceStatus: () => ({ status: m.status, isLoading: m.statusLoading, refetch: m.refetch }),
}))
vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({ ...m.side, toggleLink: m.toggleLink, selectedSide: m.side.isLinked ? 'both' : m.side.primarySide }),
}))
vi.mock('@/src/providers/PrefsProvider', () => ({ usePrefs: () => ({ control: 'dial', tempDisplay: 'degrees' }) }))
vi.mock('@/src/hooks/useSideNames', () => ({
  useSideNames: () => ({ sideName: (s: string) => (s === 'left' ? 'Jon' : 'Heidi') }),
}))
vi.mock('@/src/components/SideSelector/SideSelector', () => ({ SideSelector: () => null }))
vi.mock('@/src/components/EnvironmentInfo/EnvironmentInfoPanel', () => ({ EnvironmentInfoPanel: () => null }))
vi.mock('../TonightCard', () => ({ TonightCard: () => null }))
vi.mock('../ScheduleTimeline', () => ({ ScheduleTimeline: () => null }))
vi.mock('../LastNightCard', () => ({ LastNightCard: () => null }))
vi.mock('../AlarmCard', () => ({ AlarmCard: () => null }))
vi.mock('../AlarmBanner', () => ({ AlarmBanner: () => null }))
vi.mock('@/src/components/Autopilot/AutopilotStatusChip', () => ({ AutopilotStatusChip: () => null }))

import { TempScreen } from '../TempScreen'

const sideStatus = (target: number, level = 5) => ({
  currentTemperature: 80,
  targetTemperature: target,
  currentLevel: 0,
  targetLevel: level,
  heatingDuration: 0,
})

beforeEach(() => {
  m.setTemp.mockReset()
  m.setPower.mockReset()
  m.side = { isLinked: false, primarySide: 'left' }
  m.statusLoading = false
  m.status = {
    leftSide: sideStatus(76),
    rightSide: sideStatus(82),
    temperatureControl: {
      left: { source: 'schedule', requestId: 's', targetTemperature: 76, holdUntil: null, blocked: null },
      right: { source: 'manual', requestId: 'm', targetTemperature: 82, holdUntil: null, blocked: null },
    },
    snooze: { left: { active: false, snoozeUntil: null }, right: { active: false, snoozeUntil: null } },
  }
  m.settings = { device: { temperatureUnit: 'F' }, sides: { left: { awayMode: false }, right: { awayMode: true } } }
  m.occupancy = {
    left: { occupied: true, available: true },
    right: { occupied: false, available: false },
  }
})
afterEach(cleanup)

const card = (screen: ReturnType<typeof render>, name: string) => within(screen.getByRole('group', { name }))

describe('TempScreen', () => {
  it('renders both side cards with their targets and ownership', () => {
    const screen = render(<TempScreen />)
    const left = card(screen, 'Jon (left)')
    const right = card(screen, 'Heidi (right)')
    expect(left.getByRole('slider').getAttribute('aria-valuenow')).toBe('76')
    expect(right.getByRole('slider').getAttribute('aria-valuenow')).toBe('82')
    expect(left.getAllByText('On schedule').length).toBeGreaterThan(0)
    expect(right.getAllByText('Manual hold').length).toBeGreaterThan(0)
  })

  it('shows in-bed only when sensed, and away instead of presence', () => {
    const screen = render(<TempScreen />)
    expect(card(screen, 'Jon (left)').getAllByText('Left · In bed').length).toBeGreaterThan(0)
    expect(card(screen, 'Heidi (right)').getAllByText('Right · Away').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Out of bed/)).toBeNull()
  })

  it('+ and − step one degree on only that side when unlinked', () => {
    const screen = render(<TempScreen />)
    fireEvent.click(card(screen, 'Heidi (right)').getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp).toHaveBeenCalledExactlyOnceWith({ side: 'right', temperature: 83 }, expect.anything())
    expect(card(screen, 'Heidi (right)').getByRole('slider').getAttribute('aria-valuenow')).toBe('83')
    expect(card(screen, 'Jon (left)').getByRole('slider').getAttribute('aria-valuenow')).toBe('76')

    m.setTemp.mockReset()
    fireEvent.click(card(screen, 'Jon (left)').getByRole('button', { name: 'Cooler' }))
    expect(m.setTemp).toHaveBeenCalledExactlyOnceWith({ side: 'left', temperature: 75 }, expect.anything())
  })

  it('clamps at 110°F', () => {
    m.status = { ...(m.status as object), rightSide: sideStatus(110) }
    const screen = render(<TempScreen />)
    fireEvent.click(card(screen, 'Heidi (right)').getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'right', temperature: 110 }, expect.anything())
  })

  it('Link sides mirrors a change to both sides', () => {
    m.side = { isLinked: true, primarySide: 'left' }
    const screen = render(<TempScreen />)
    fireEvent.click(card(screen, 'Jon (left)').getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp).toHaveBeenCalledTimes(2)
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'left', temperature: 77 }, expect.anything())
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'right', temperature: 77 }, expect.anything())
    expect(card(screen, 'Heidi (right)').getByRole('slider').getAttribute('aria-valuenow')).toBe('77')
  })

  it('Link sides mirrors power to both sides', () => {
    m.side = { isLinked: true, primarySide: 'left' }
    const screen = render(<TempScreen />)
    fireEvent.click(card(screen, 'Heidi (right)').getByRole('button', { name: 'Turn off' }))
    expect(m.setPower).toHaveBeenCalledTimes(2)
    expect(m.setPower).toHaveBeenCalledWith({ side: 'left', powered: false }, expect.anything())
    expect(m.setPower).toHaveBeenCalledWith({ side: 'right', powered: false }, expect.anything())
  })

  it('the header button toggles link', () => {
    const screen = render(<TempScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Link sides' }))
    expect(m.toggleLink).toHaveBeenCalledOnce()
  })

  it('All off powers down only the sides that are on', () => {
    m.status = { ...(m.status as object), rightSide: sideStatus(82, 0) }
    const screen = render(<TempScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'All off' }))
    expect(m.setPower).toHaveBeenCalledExactlyOnceWith({ side: 'left', powered: false }, expect.anything())
  })

  it('All off is disabled when both sides are already off', () => {
    m.status = { ...(m.status as object), leftSide: sideStatus(76, 0), rightSide: sideStatus(82, 0) }
    const screen = render(<TempScreen />)
    expect((screen.getByRole('button', { name: 'All off' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('power toggles one side and a powered-off side disables ±', () => {
    m.status = { ...(m.status as object), leftSide: sideStatus(76, 0) }
    const screen = render(<TempScreen />)
    const left = card(screen, 'Jon (left)')
    expect((left.getByRole('button', { name: 'Warmer' }) as HTMLButtonElement).disabled).toBe(true)
    expect((left.getByRole('button', { name: 'Cooler' }) as HTMLButtonElement).disabled).toBe(true)
    expect(left.getByText('OFF')).toBeTruthy()
    fireEvent.click(left.getByRole('button', { name: 'Turn on' }))
    expect(m.setPower).toHaveBeenCalledExactlyOnceWith({ side: 'left', powered: true }, expect.anything())
  })

  it('sends a non-default hold duration with the next adjustment', () => {
    const screen = render(<TempScreen />)
    const left = card(screen, 'Jon (left)')
    fireEvent.change(left.getByRole('combobox', { name: 'Temperature hold duration' }), { target: { value: '120' } })
    // Shared across both cards
    expect((card(screen, 'Heidi (right)').getByRole('combobox', { name: 'Temperature hold duration' }) as HTMLSelectElement).value).toBe('120')
    fireEvent.click(left.getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'left', temperature: 77, holdMinutes: 120 }, expect.anything())
  })

  it('reverts the optimistic target when the mutation fails', () => {
    const screen = render(<TempScreen />)
    fireEvent.click(card(screen, 'Jon (left)').getByRole('button', { name: 'Warmer' }))
    const [, opts] = m.setTemp.mock.calls[0] as [unknown, { onError: () => void }]
    expect(card(screen, 'Jon (left)').getByRole('slider').getAttribute('aria-valuenow')).toBe('77')
    act(() => opts.onError())
    expect(card(screen, 'Jon (left)').getByRole('slider').getAttribute('aria-valuenow')).toBe('76')
  })

  it('shows Connecting… while status loads', () => {
    m.statusLoading = true
    const screen = render(<TempScreen />)
    expect(screen.getByText('Connecting…')).toBeTruthy()
    expect(screen.queryByRole('slider')).toBeNull()
  })
})
