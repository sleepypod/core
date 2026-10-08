/**
 * TempScreen behavior: per-side ± / power wiring, clamp, Link sides mirroring,
 * hold-duration forwarding, away / presence lines, the loading state and the
 * Now / Night / Dawn stepper variant, and the device notices that pause a side.
 * Context cards and the phone switcher are stubbed — they have their own data.
 */

import type * as PrefsModule from '@/src/providers/PrefsProvider'
import type { Notice } from '@/src/components/ds'
import type * as NoticesModule from '../useTempNotices'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { Droplets } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  setTemp: vi.fn(),
  setPower: vi.fn(),
  tempPending: false,
  refetch: vi.fn(),
  toggleLink: vi.fn(),
  side: { isLinked: false, primarySide: 'left' as 'left' | 'right', singleSleeperSide: null as 'left' | 'right' | null },
  timelineSides: undefined as unknown,
  statusLoading: false,
  status: undefined as unknown,
  settings: undefined as unknown,
  occupancy: undefined as unknown,
  control: 'dial' as 'dial' | 'slider' | 'stepper',
  display: 'degrees' as 'degrees' | 'offset' | 'level',
  nudge: { left: vi.fn(), right: vi.fn() },
  notices: [] as Notice[],
  noticesEnabled: [] as boolean[],
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    device: {
      setTemperature: { useMutation: () => ({ mutate: m.setTemp, isPending: m.tempPending }) },
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
  useShownSides: () => (m.side.singleSleeperSide ? [m.side.singleSleeperSide] : ['left', 'right']),
}))
vi.mock('@/src/providers/PrefsProvider', async importOriginal => ({
  ...await importOriginal<typeof PrefsModule>(),
  usePrefs: () => ({ control: m.control, tempDisplay: m.display }),
}))
vi.mock('@/src/hooks/useSideNames', () => ({
  useSideNames: () => ({ sideName: (s: string) => (s === 'left' ? 'Jon' : 'Heidi') }),
}))
vi.mock('@/src/components/SideSelector/SideSelector', () => ({ SideSelector: () => null }))
vi.mock('@/src/components/EnvironmentInfo/EnvironmentInfoPanel', () => ({ EnvironmentInfoPanel: () => null }))
vi.mock('../TonightCard', () => ({ TonightCard: () => null, useNow: () => new Date(2026, 8, 28, 14, 0) }))
vi.mock('../useNightPhases', () => ({
  useNightPhases: (side: 'left' | 'right') => ({
    phases: {
      day: 'monday',
      days: ['monday'],
      night: { temperatureF: 74, start: '22:00', end: '06:00', minutes: 480, times: ['22:00'] },
      dawn: { temperatureF: 84, start: '06:00', end: '06:30', minutes: 30, times: ['06:00'] },
    },
    draft: false,
    isLoading: false,
    error: null,
    saving: false,
    valueF: (p: 'night' | 'dawn') => (p === 'night' ? 74 : 84),
    nudge: m.nudge[side],
  }),
}))
vi.mock('../ScheduleTimeline', () => ({
  ScheduleTimeline: ({ sides }: { sides?: string[] }) => {
    m.timelineSides = sides
    return null
  },
}))
vi.mock('../LastNightCard', () => ({ LastNightCard: () => null }))
vi.mock('../AlarmCard', () => ({ AlarmCard: () => null }))
vi.mock('../useTempNotices', async (importOriginal) => {
  const actual = await importOriginal<typeof NoticesModule>()
  return {
    ...actual,
    useTempNotices: (_status: unknown, _refetch: unknown, opts?: { enabled?: boolean }) => {
      m.noticesEnabled.push(opts?.enabled ?? true)
      return { notices: m.notices, blocked: actual.blockedSides(m.notices) }
    },
  }
})
vi.mock('@/src/components/Autopilot/AutopilotStatusChip', () => ({ AutopilotStatusChip: () => null }))
vi.mock('@/src/components/Stage/TempStage', () => ({
  TempStage: ({ onExit }: { onExit: () => void }) => <button type="button" data-testid="temp-stage" onClick={onExit}>Back</button>,
}))

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
  m.tempPending = false
  m.side = { isLinked: false, primarySide: 'left', singleSleeperSide: null }
  // The stage is the default; these cover the cards it toggles back to.
  localStorage.setItem('sleepypod.base.temp.view', 'cards')
  m.timelineSides = undefined
  vi.useFakeTimers()
  m.statusLoading = false
  m.control = 'dial'
  m.display = 'degrees'
  m.nudge.left.mockReset()
  m.nudge.right.mockReset()
  m.notices = []
  m.noticesEnabled = []
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
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** ± pools taps for 500 ms before sending; click and let the burst flush. */
function tap(el: HTMLElement) {
  fireEvent.click(el)
  act(() => {
    vi.advanceTimersByTime(500)
  })
}

const card = (screen: ReturnType<typeof render>, name: string) => within(screen.getByRole('group', { name }))

describe('TempScreen', () => {
  it('opens on the stage by default and toggles between it and the cards', async () => {
    localStorage.removeItem('sleepypod.base.temp.view')
    const screen = render(<TempScreen />)
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    expect(screen.getByTestId('temp-stage')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Jon (left)' })).toBeNull()
    fireEvent.click(screen.getByTestId('temp-stage'))
    expect(localStorage.getItem('sleepypod.base.temp.view')).toBe('cards')
    expect(screen.getByRole('group', { name: 'Jon (left)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Thermal view/ })).toBeNull()
    within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'Cards' })
    expect(screen.getByRole('button', { name: 'Cards' }).getAttribute('aria-pressed')).toBe('true')
    const stage = screen.getByRole('button', { name: 'Stage' })
    expect(stage.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(stage)
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    expect(screen.getByTestId('temp-stage')).toBeTruthy()
    expect(localStorage.getItem('sleepypod.base.temp.view')).toBe('stage')
  })

  it('switches from the cards to the stage with v, but not while typing', async () => {
    const screen = render(<TempScreen />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'v' })
    expect(screen.queryByTestId('temp-stage')).toBeNull()
    fireEvent.keyDown(window, { key: 'v' })
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    expect(screen.getByTestId('temp-stage')).toBeTruthy()
    input.remove()
  })

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
    expect(card(screen, 'Heidi (right)').getAllByText('Right · Schedule off').length).toBeGreaterThan(0)
    expect(card(screen, 'Heidi (right)').getByTestId('side-away').textContent).toBe('AWAY')
    expect(card(screen, 'Jon (left)').queryByTestId('side-away')).toBeNull()
    expect(screen.queryByText(/Out of bed/)).toBeNull()
  })

  it('draws an away side as a dashed, see-through card that keeps its controls while on', () => {
    const screen = render(<TempScreen />)
    const right = screen.getByRole('group', { name: 'Heidi (right)' })
    expect(right.className).toContain('border-dashed')
    expect(right.className).toContain('border-line-2')
    expect(right.className).toContain('bg-transparent')
    expect(within(right).getByText('Heidi').className).toContain('text-fg-2')
    expect(within(right).getByRole('slider')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Jon (left)' }).className).not.toContain('border-dashed')
  })

  it('an away side that is off reads Off with a Turn on button', () => {
    m.status = { ...(m.status as object), rightSide: sideStatus(82, 0) }
    const screen = render(<TempScreen />)
    const right = card(screen, 'Heidi (right)')
    expect(right.getByTestId('side-away-off').textContent).toContain('Off')
    expect(right.queryByRole('slider')).toBeNull()
    expect(right.getAllByRole('button', { name: 'Turn on' })).toHaveLength(1)
    fireEvent.click(right.getByRole('button', { name: 'Turn on' }))
    expect(m.setPower).toHaveBeenCalledWith({ side: 'right', powered: true }, expect.anything())
  })

  it('keeps both cards, linked, when one side is away', () => {
    m.side = { isLinked: true, primarySide: 'left', singleSleeperSide: 'left' }
    m.settings = { ...(m.settings as object), device: { unusedZoneMode: 'follow' } }
    const screen = render(<TempScreen />)
    expect(card(screen, 'Jon (left)')).toBeTruthy()
    // Phone side line and the desktop ownership row both say whose schedule the away side is on.
    expect(card(screen, 'Heidi (right)').getAllByText('Right · Following Jon’s schedule').length).toBeGreaterThan(0)
    expect(card(screen, 'Heidi (right)').getAllByText('Following Jon’s schedule').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Sides linked' })).toBeTruthy()
    // The sleeper's schedule and timeline.
    expect(m.timelineSides).toEqual(['left'])
    tap(card(screen, 'Heidi (right)').getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp.mock.calls.map(c => c[0])).toEqual([{ side: 'left', temperature: 83 }, { side: 'right', temperature: 83 }])
  })

  it('shows both cards and the link button otherwise', () => {
    const screen = render(<TempScreen />)
    expect(screen.getByRole('group', { name: 'Heidi (right)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Link sides' })).toBeTruthy()
    expect(m.timelineSides).toEqual(['left', 'right'])
  })

  it('+ and − step one degree on only that side when unlinked', () => {
    const screen = render(<TempScreen />)
    tap(card(screen, 'Heidi (right)').getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp).toHaveBeenCalledExactlyOnceWith({ side: 'right', temperature: 83 }, expect.anything())
    expect(card(screen, 'Heidi (right)').getByRole('slider').getAttribute('aria-valuenow')).toBe('83')
    expect(card(screen, 'Jon (left)').getByRole('slider').getAttribute('aria-valuenow')).toBe('76')

    m.setTemp.mockReset()
    tap(card(screen, 'Jon (left)').getByRole('button', { name: 'Cooler' }))
    expect(m.setTemp).toHaveBeenCalledExactlyOnceWith({ side: 'left', temperature: 75 }, expect.anything())
  })

  it('clamps at 110°F', () => {
    m.status = { ...(m.status as object), rightSide: sideStatus(110) }
    const screen = render(<TempScreen />)
    tap(card(screen, 'Heidi (right)').getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'right', temperature: 110 }, expect.anything())
  })

  it('Link sides mirrors a change to both sides', () => {
    m.side = { isLinked: true, primarySide: 'left', singleSleeperSide: null }
    const screen = render(<TempScreen />)
    tap(card(screen, 'Jon (left)').getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp).toHaveBeenCalledTimes(2)
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'left', temperature: 77 }, expect.anything())
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'right', temperature: 77 }, expect.anything())
    expect(card(screen, 'Heidi (right)').getByRole('slider').getAttribute('aria-valuenow')).toBe('77')
  })

  it('Link sides mirrors power to both sides', () => {
    m.side = { isLinked: true, primarySide: 'left', singleSleeperSide: null }
    const screen = render(<TempScreen />)
    fireEvent.click(card(screen, 'Heidi (right)').getByRole('button', { name: 'Turn off' }))
    expect(m.setPower).toHaveBeenCalledTimes(2)
    expect(m.setPower).toHaveBeenCalledWith({ side: 'left', powered: false }, expect.anything())
    expect(m.setPower).toHaveBeenCalledWith({ side: 'right', powered: false }, expect.anything())
  })

  it('shows the pod\'s notices under the header, danger first', () => {
    m.notices = [
      { id: 'priming', kind: 'progress', tone: 'cool', icon: Droplets, title: 'Priming', blocksSides: ['left', 'right'] },
      { id: 'pump-stall:left', kind: 'action', tone: 'danger', icon: Droplets, title: 'Left side powered off. Pump stall detected.', blocksSides: ['left'] },
    ]
    const screen = render(<TempScreen />)
    const banners = [...screen.getByTestId('notice-stack').querySelectorAll('[data-notice]')]
    expect(banners.map(b => b.getAttribute('data-notice'))).toEqual(['pump-stall:left', 'priming'])
    expect(banners.map(b => b.getAttribute('role'))).toEqual(['alert', 'status'])
    // The prime toast fires from the cards only while they are the view on screen.
    expect(m.noticesEnabled.at(-1)).toBe(true)
  })

  it('pauses only the side a pump stall blocks: dimmed, PAUSED, controls off', () => {
    m.notices = [{ id: 'pump-stall:left', kind: 'action', tone: 'danger', icon: Droplets, title: 'Stall', blocksSides: ['left'] }]
    const screen = render(<TempScreen />)
    const left = screen.getByRole('group', { name: 'Jon (left)' })
    const right = screen.getByRole('group', { name: 'Heidi (right)' })
    expect(left.getAttribute('aria-disabled')).toBe('true')
    expect(left.className).toContain('opacity-40')
    expect(left.className).toContain('pointer-events-none')
    expect(within(left).getByTestId('side-paused').textContent).toBe('Paused')
    expect(within(left).getByText('PAUSED')).toBeTruthy()
    expect((within(left).getByRole('button', { name: 'Warmer' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(left).getByRole('button', { name: 'Turn off' }) as HTMLButtonElement).disabled).toBe(true)
    expect(right.getAttribute('aria-disabled')).toBeNull()
    expect(within(right).queryByTestId('side-paused')).toBeNull()
  })

  it('priming pauses both sides', () => {
    m.notices = [{ id: 'priming', kind: 'progress', tone: 'cool', icon: Droplets, title: 'Priming', blocksSides: ['left', 'right'] }]
    const screen = render(<TempScreen />)
    expect(screen.getByRole('group', { name: 'Jon (left)' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('group', { name: 'Heidi (right)' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('a linked change skips the side a notice blocks', () => {
    m.side = { isLinked: true, primarySide: 'left', singleSleeperSide: null }
    m.notices = [{ id: 'pump-stall:right', kind: 'action', tone: 'danger', icon: Droplets, title: 'Stall', blocksSides: ['right'] }]
    const screen = render(<TempScreen />)
    tap(card(screen, 'Jon (left)').getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp).toHaveBeenCalledExactlyOnceWith({ side: 'left', temperature: 77 }, expect.anything())
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
    tap(left.getByRole('button', { name: 'Warmer' }))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'left', temperature: 77, holdMinutes: 120 }, expect.anything())
  })

  it('reverts the optimistic target when the mutation fails', () => {
    const screen = render(<TempScreen />)
    tap(card(screen, 'Jon (left)').getByRole('button', { name: 'Warmer' }))
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

  it('keeps ± usable while a set point is in flight', () => {
    // Taps are shown at once and pooled into one set point, so a pending
    // request shouldn't grey the buttons out between taps.
    m.tempPending = true
    const screen = render(<TempScreen />)
    const warmer = card(screen, 'Jon (left)').getByRole('button', { name: 'Warmer' })
    const cooler = card(screen, 'Jon (left)').getByRole('button', { name: 'Cooler' })
    expect(warmer.hasAttribute('disabled')).toBe(false)
    expect(cooler.hasAttribute('disabled')).toBe(false)
    tap(warmer)
    expect(m.setTemp).toHaveBeenCalledExactlyOnceWith({ side: 'left', temperature: 77 }, expect.anything())
  })

  it('pools a burst of ± taps into one set point', () => {
    const screen = render(<TempScreen />)
    const warmer = card(screen, 'Jon (left)').getByRole('button', { name: 'Warmer' })
    fireEvent.click(warmer)
    fireEvent.click(warmer)
    fireEvent.click(warmer)
    expect(card(screen, 'Jon (left)').getByRole('slider').getAttribute('aria-valuenow')).toBe('79')
    expect(m.setTemp).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(m.setTemp).toHaveBeenCalledExactlyOnceWith({ side: 'left', temperature: 79 }, expect.anything())
  })

  describe('stepper variant', () => {
    beforeEach(() => {
      m.control = 'stepper'
    })

    it('steps Now through the pod like the dial', () => {
      const screen = render(<TempScreen />)
      const left = card(screen, 'Jon (left)')
      expect(left.getByTestId('stepper-value').textContent).toBe('76°F')
      tap(left.getByRole('button', { name: 'Warmer now' }))
      expect(m.setTemp).toHaveBeenCalledExactlyOnceWith({ side: 'left', temperature: 77 }, expect.anything())
    })

    it('edits Night on the schedule, mirrored to both sides when linked', () => {
      m.side = { isLinked: true, primarySide: 'left', singleSleeperSide: null }
      const screen = render(<TempScreen />)
      const left = card(screen, 'Jon (left)')
      fireEvent.click(left.getByRole('tab', { name: /Night/ }))
      expect(left.getByTestId('stepper-value').textContent).toBe('74°F')
      expect(left.getByTestId('stepper-status').textContent).toBe('10:00 PM – 6:00 AM')
      expect(left.getByTestId('stepper-days').textContent).toBe('Mon')
      fireEvent.click(left.getByRole('button', { name: 'Cooler night' }))
      expect(m.nudge.left).toHaveBeenCalledExactlyOnceWith('night', -1)
      expect(m.nudge.right).toHaveBeenCalledExactlyOnceWith('night', -1)
      expect(m.setTemp).not.toHaveBeenCalled()
    })

    it('edits Night on the sleeper\'s schedule only when the other side is away, from either card', () => {
      m.side = { isLinked: true, primarySide: 'left', singleSleeperSide: 'left' }
      m.settings = { ...(m.settings as object), device: { unusedZoneMode: 'follow' } }
      const screen = render(<TempScreen />)
      const right = card(screen, 'Heidi (right)')
      fireEvent.click(right.getByRole('tab', { name: /Night/ }))
      fireEvent.click(right.getByRole('button', { name: 'Cooler night' }))
      expect(m.nudge.left).toHaveBeenCalledExactlyOnceWith('night', -1)
      expect(m.nudge.right).not.toHaveBeenCalled()
    })

    it('steps Now by an Eight Sleep level in level display', () => {
      m.display = 'level'
      const screen = render(<TempScreen />)
      const left = card(screen, 'Jon (left)')
      // 76°F = level −2 → −1 = 79.75 → 80°F
      expect(left.getByTestId('stepper-value').textContent).toBe('−2')
      tap(left.getByRole('button', { name: 'Warmer now' }))
      expect(m.setTemp).toHaveBeenCalledExactlyOnceWith({ side: 'left', temperature: 80 }, expect.anything())
    })

    it('keeps the tab per side unless linked', () => {
      const screen = render(<TempScreen />)
      fireEvent.click(card(screen, 'Jon (left)').getByRole('tab', { name: /Night/ }))
      expect(card(screen, 'Jon (left)').getByTestId('stepper-value').textContent).toBe('74°F')
      expect(card(screen, 'Heidi (right)').getByTestId('stepper-value').textContent).toBe('82°F')
    })

    it('shows the heat state line, and dims and ignores the controls when off', () => {
      m.status = { ...(m.status as object), rightSide: sideStatus(82, 0) }
      // Present but off (an away side that is off shows only Off and Turn on).
      m.settings = { device: { temperatureUnit: 'F' }, sides: { left: { awayMode: false }, right: { awayMode: false } } }
      const screen = render(<TempScreen />)
      expect(card(screen, 'Jon (left)').getByTestId('stepper-status').textContent).toBe('Cooling · bed 80°F')
      const right = card(screen, 'Heidi (right)')
      expect(right.getByTestId('stepper-value').textContent).toBe('Off')
      expect(right.getByTestId('stepper-status').textContent).toBe('Off · bed 80°F')
      expect((right.getByRole('button', { name: 'Warmer now' }) as HTMLButtonElement).disabled).toBe(true)
      expect((right.getByRole('tab', { name: /Night/ }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(right.getByRole('button', { name: 'Turn on' }))
      expect(m.setPower).toHaveBeenCalledExactlyOnceWith({ side: 'right', powered: true }, expect.anything())
    })
  })
})

it('exposes solo setup without linking temperature controls', () => {
  m.settings = { device: { bedMode: 'solo-left', unusedZoneMode: 'independent' }, sides: { left: { awayMode: false }, right: { awayMode: false } } }
  m.side = { isLinked: false, primarySide: 'left', singleSleeperSide: 'left' }
  const screen = render(<TempScreen />)
  expect(screen.getByRole('link', { name: 'Manage sleepers: Solo sleeper · Jon' }).getAttribute('href')).toBe('/settings?section=sides')
  expect(screen.getByRole('button', { name: 'Link sides' })).toBeTruthy()
  expect(card(screen, 'Heidi (right)').getAllByText(/Independent schedule/).length).toBeGreaterThan(0)
})

describe('sleeper line and view switches', () => {
  it.each([
    [{ device: { bedMode: 'solo-right' }, sides: { left: { awayMode: true }, right: { awayMode: true } } }, 'Solo sleeper · Heidi · Away'],
    [{ device: {}, sides: { left: { awayMode: false }, right: { awayMode: false } } }, 'Two sleepers'],
    [{ device: {}, sides: { left: { awayMode: true }, right: { awayMode: true } } }, 'Jon & Heidi away'],
  ])('summarises the sleepers (%#)', (settings, label) => {
    m.settings = settings
    const screen = render(<TempScreen />)
    expect(screen.getByRole('link', { name: `Manage sleepers: ${label}` })).toBeTruthy()
  })

  it('names the return date when exactly one away side has one', () => {
    m.settings = { device: { timezone: 'UTC' }, sides: { left: { awayMode: false }, right: { awayMode: true, awayReturn: '2026-10-12T12:00:00Z' } } }
    const screen = render(<TempScreen />)
    expect(screen.getByRole('link', { name: /^Manage sleepers: Heidi away · Until \S/ })).toBeTruthy()
  })
})

