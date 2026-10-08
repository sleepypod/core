/**
 * TempStage behaviour: the six zone readouts carry live sensor data, side labels read
 * target-or-measured in the ramp colour with a truthful status word, keyboard covers
 * select / link / nudge / power / escape, the timeline scrub previews the schedule,
 * linking copies left to right, and the flat cards appear when 3D cannot load.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { forwardRef, useEffect, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { SideCard as SideCardComponent } from '@/src/components/TempScreen/SideCard'
import type { StageSceneCallbacks, StageSceneState } from '../stageScene'

type SideCardProps = ComponentProps<typeof SideCardComponent>

// Monday 28 Sep 2026, 9:00 PM local.
const NOW = new Date(2026, 8, 28, 21, 0)

const m = vi.hoisted(() => ({
  setTemp: vi.fn(),
  setPower: vi.fn(),
  refetch: vi.fn(),
  toggleLink: vi.fn(),
  orbitBy: vi.fn(),
  side: { isLinked: false },
  status: undefined as unknown,
  statusLoading: false,
  settings: { device: { temperatureUnit: 'F' }, sides: { left: { name: 'Jon' }, right: { name: 'Heidi' } } } as unknown,
  occupancy: { left: { occupied: true, available: true }, right: { occupied: false, available: true } } as unknown,
  frame: undefined as unknown,
  stored: undefined as unknown,
  schedules: { left: [] as unknown[], right: [] as unknown[] },
  control: 'dial' as 'dial' | 'slider' | 'stepper',
  display: 'degrees' as 'degrees' | 'offset' | 'level',
  mode: '3d' as '3d' | '2d',
  canvas: null as null | { state: StageSceneState, callbacks: Omit<StageSceneCallbacks, 'onFail'>, labels: () => unknown },
  older: undefined as unknown,
  health: { tone: 'ok', summary: 'healthy' },
  phases: null as unknown,
  nudge: vi.fn(),
  sideCards: {} as Record<string, SideCardProps>,
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    device: {
      setTemperature: { useMutation: () => ({ mutate: m.setTemp, isPending: false }) },
      setPower: { useMutation: () => ({ mutate: m.setPower, isPending: false }) },
      resumeTemperature: { useMutation: (opts?: { onSuccess?: () => void }) => ({ mutate: () => opts?.onSuccess?.(), isPending: false, error: null }) },
    },
    settings: { getAll: { useQuery: () => ({ data: m.settings }) } },
    biometrics: { getOccupancy: { useQuery: () => ({ data: m.occupancy }) } },
    environment: { getLatestBedTemp: { useQuery: () => ({ data: m.stored }) } },
    schedules: { getAll: { useQuery: ({ side }: { side: 'left' | 'right' }) => ({ data: { temperature: m.schedules[side], power: [], alarm: [] }, isLoading: false }) } },
  },
}))
vi.mock('@/src/hooks/useDeviceStatus', () => ({
  useDeviceStatus: () => ({ status: m.status, isLoading: m.statusLoading, refetch: m.refetch }),
}))
vi.mock('@/src/hooks/useSensorStream', () => ({
  useSensorStream: () => {},
  useSensorFrame: (type: string) => (type === 'bedTemp2' ? m.frame : m.older),
}))
vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({ isLinked: m.side.isLinked, toggleLink: m.toggleLink }),
}))
vi.mock('@/src/providers/PrefsProvider', () => ({ usePrefs: () => ({ control: m.control, tempDisplay: m.display }) }))
vi.mock('@/src/hooks/useSideNames', () => ({
  useSideNames: () => ({ sideName: (s: string) => (s === 'left' ? 'Jon' : 'Heidi') }),
}))
vi.mock('@/src/components/AppShell/usePodHealth', () => ({
  usePodHealth: () => ({ footer: { ...m.health, issues: [] }, podVersion: 'J55' }),
}))
vi.mock('@/src/components/TempScreen/TonightCard', () => ({ useNow: () => NOW }))
vi.mock('@/src/components/TempScreen/useNightPhases', () => ({
  useNightPhases: () => ({ phases: m.phases, draft: false, isLoading: false, error: null, saving: false, valueF: () => (m.phases ? 68 : null), nudge: m.nudge }),
}))
vi.mock('@/src/components/TempScreen/SideCard', () => ({
  SideCard: (props: SideCardProps) => {
    m.sideCards[props.side] = props
    return <div data-testid="side-card">{props.name}</div>
  },
}))
vi.mock('../StageCanvas', () => ({
  default: forwardRef(function StageCanvasMock(props: { state: StageSceneState, callbacks: Omit<StageSceneCallbacks, 'onFail'>, labels: () => unknown, onMode: (mode: '3d' | '2d') => void }, ref) {
    m.canvas = { state: props.state, callbacks: props.callbacks, labels: props.labels }
    useImperativeHandle(ref, () => ({ orbitBy: m.orbitBy }), [])
    const { onMode } = props
    useEffect(() => {
      onMode(m.mode)
    }, [onMode])
    return <div data-testid="stage-canvas" />
  }),
}))

import { TempStage } from '../TempStage'

const sideStatus = (target: number, level: number, current = 80) => ({ currentTemperature: current, targetTemperature: target, currentLevel: 0, targetLevel: level, heatingDuration: 0 })
const rows = (points: [string, number][]) => points.map(([time, temperature], i) => ({ id: i + 1, dayOfWeek: 'monday', time, temperature, enabled: true }))

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  vi.clearAllMocks()
  m.side = { isLinked: false }
  m.control = 'dial'
  m.display = 'degrees'
  m.mode = '3d'
  m.canvas = null
  m.statusLoading = false
  m.status = {
    leftSide: sideStatus(72, 5),
    rightSide: sideStatus(84, 0),
    temperatureControl: { left: { source: 'manual', requestId: null, targetTemperature: 72, holdUntil: null, blocked: null }, right: { source: null, requestId: null, targetTemperature: null, holdUntil: null, blocked: 'off' } },
  }
  m.frame = {
    type: 'bedTemp2', ts: NOW.getTime() / 1000 - 10, ambientTemp: 21, mcuTemp: 40, humidity: 44.6,
    leftOuterTemp: 22, leftCenterTemp: 23, leftInnerTemp: 24, rightOuterTemp: 30, rightCenterTemp: 31, rightInnerTemp: 32,
  }
  m.stored = undefined
  m.older = undefined
  m.health = { tone: 'ok', summary: 'healthy' }
  m.phases = null
  m.sideCards = {}
  m.settings = { device: { temperatureUnit: 'F' }, sides: { left: { name: 'Jon' }, right: { name: 'Heidi' } } }
  m.occupancy = { left: { occupied: true, available: true }, right: { occupied: false, available: true } }
  m.schedules = { left: rows([['22:00', 72], ['02:00', 68], ['06:00', 79]]), right: [] }
  localStorage.clear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 100, right: 1000, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const zones = () => Array.from(document.querySelectorAll<HTMLElement>('[data-stage-zone]')).map(el => `${el.dataset.testid?.replace('stage-zone-', '')}:${el.textContent}`)

describe('TempStage', () => {
  it('renders the six zone readouts from the live surface frame, in °F, with the room readings', async () => {
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    expect(zones()).toEqual([
      'left-outer:OUTER71.6°', 'left-center:CENTER73.4°', 'left-inner:INNER75.2°',
      'right-outer:OUTER86.0°', 'right-center:CENTER87.8°', 'right-inner:INNER89.6°',
    ])
    expect(screen.getByTestId('stage-room').textContent).toBe('70°')
    expect(screen.getByTestId('stage-humidity').textContent).toBe('45%')
    expect(screen.getByTestId('stage-bed-air').textContent).toBe('80.6°')
    expect(screen.getByTestId('stage-health').textContent).toBe('Pod · healthy')
    expect(screen.queryByTestId('stage-loading')).toBeNull()
    // The scene gets the same six readings for the heat field.
    expect(m.canvas?.state.sides.left.zonesF.map(z => z && Math.round(z * 10) / 10)).toEqual([71.6, 73.4, 75.2])
    expect(m.canvas?.state.sides.right.zonesF.map(z => z && Math.round(z * 10) / 10)).toEqual([86, 87.8, 89.6])
  })

  it('reads unknown zones after the frame goes stale and falls back to the stored row', async () => {
    m.frame = { ...(m.frame as object), ts: NOW.getTime() / 1000 - 200 }
    m.stored = { timestamp: new Date(NOW.getTime() - 20_000), ambientTemp: 20, humidity: 50, leftOuterTemp: 25, leftCenterTemp: 25, leftInnerTemp: 25, rightOuterTemp: 25, rightCenterTemp: 25, rightInnerTemp: 25 }
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    expect(zones()[0]).toBe('left-outer:OUTER77.0°')
    m.stored = undefined
    cleanup()
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    expect(zones()[0]).toBe('left-outer:OUTER--')
    expect(m.canvas?.state.sides.left.zonesF).toEqual([null, null, null])
  })

  it('labels each side with target-or-measured, a truthful status word and presence', async () => {
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    expect(screen.getByTestId('stage-label-left-temp').textContent).toBe('72°')
    expect(screen.getByTestId('stage-label-left-status').textContent).toBe('COOLING')
    expect(screen.getByTestId('stage-label-right-temp').textContent).toBe('80°')
    expect(screen.getByTestId('stage-label-right-status').textContent).toBe('OFF')
    // On: the target in the ramp colour. Off: the measured bed in plain text.
    expect(screen.getByTestId('stage-label-left-temp').style.color).toBe('rgb(69, 94, 130)')
    expect(screen.getByTestId('stage-label-right-temp').style.color).toBe('rgb(236, 236, 236)')
    expect(screen.getByTestId('stage-mode').textContent).toBe('Live')
    expect(screen.getByTestId('stage-next').textContent).toBe('next · Jon 72° in 1h 00m')
    // The cover wears what the surface measures, not the request.
    expect(m.canvas?.state.sides.left.shownF).toBe(80)
    expect(m.canvas?.state.sides.right.shownF).toBe(80)
    expect(m.canvas?.state.hour).toBe(21)
    expect(m.canvas?.state.selected).toBeNull()
  })

  it('selects with 1/2, nudges with the arrows, powers with space and escapes', async () => {
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    const panel = screen.getByTestId('stage-panel')
    expect(panel.dataset.open).toBe('false')
    fireEvent.keyDown(window, { key: '1' })
    expect(panel.dataset.open).toBe('true')
    expect(m.canvas?.state.selected).toBe('left')
    expect(screen.getByRole('region', { name: 'Jon controls' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(screen.getByTestId('stage-label-left-temp').textContent).toBe('73°')
    act(() => vi.advanceTimersByTime(600))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'left', temperature: 73 }, expect.anything())
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(m.orbitBy).toHaveBeenCalledWith(0.25)
    fireEvent.keyDown(window, { key: ' ' })
    expect(m.setPower).toHaveBeenCalledWith({ side: 'left', powered: false }, expect.anything())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(panel.dataset.open).toBe('false')
    fireEvent.keyDown(window, { key: '2' })
    expect(m.canvas?.state.selected).toBe('right')
    // An off side does not step.
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(m.setTemp).toHaveBeenCalledTimes(1)
  })

  it('links by copying the left side to the right, then mirrors changes to both', async () => {
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    fireEvent.keyDown(window, { key: 'l' })
    expect(m.setPower).toHaveBeenCalledWith({ side: 'right', powered: true }, expect.anything())
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'right', temperature: 72 }, expect.anything())
    expect(m.toggleLink).toHaveBeenCalledTimes(1)
    m.side = { isLinked: true }
    m.status = { ...(m.status as object), rightSide: sideStatus(72, 5) }
    cleanup()
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    expect(screen.getByTestId('stage-label-linked').style.display).not.toBe('none')
    expect(screen.getByTestId('stage-label-left').style.display).toBe('none')
    fireEvent.keyDown(window, { key: '1' })
    expect(screen.getByRole('region', { name: 'Both sides controls' }).textContent).toContain('Jon · Heidi · Linked')
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    act(() => vi.advanceTimersByTime(600))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'left', temperature: 71 }, expect.anything())
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'right', temperature: 71 }, expect.anything())
    expect(m.canvas?.state.linked).toBe(true)
  })

  it('previews the schedule when the timeline is scrubbed and returns to live on escape', async () => {
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    fireEvent.pointerDown(screen.getByTestId('stage-lane'), { clientX: 500, button: 0, pointerId: 1, pointerType: 'mouse' })
    // Half way across 6 PM → 9 AM is 1:30 AM: Jon holds 72°, Heidi has no schedule.
    expect(screen.getByTestId('stage-mode').textContent).toContain('Preview · 1:30 AM')
    expect(screen.getByTestId('stage-label-left-status').textContent).toBe('SCHEDULED 72°')
    expect(screen.getByTestId('stage-label-right-status').textContent).toBe('OFF')
    expect(screen.getByTestId('stage-preview-marker')).toBeTruthy()
    expect(m.canvas?.state.previewing).toBe(true)
    expect(m.canvas?.state.sides.left.shownF).toBe(72)
    expect(m.canvas?.state.sides.right.shownF).toBeNull()
    expect(m.canvas?.state.hour).toBe(1.5)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('stage-mode').textContent).toBe('Live')
    expect(screen.queryByTestId('stage-preview-marker')).toBeNull()
  })

  it('drives the bed from the canvas: a drag turns the side on and previews, release commits, a tap selects', async () => {
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    act(() => m.canvas?.callbacks.onDrag('right', 86))
    expect(m.setPower).toHaveBeenCalledWith({ side: 'right', powered: true }, expect.anything())
    expect(screen.getByTestId('stage-label-right-temp').textContent).toBe('86°')
    act(() => m.canvas?.callbacks.onDragEnd('right', 86))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'right', temperature: 86 }, expect.anything())
    act(() => m.canvas?.callbacks.onSelect('left'))
    expect(m.canvas?.state.selected).toBe('left')
    act(() => m.canvas?.callbacks.onSelect('left'))
    expect(m.canvas?.state.selected).toBeNull()
    act(() => m.canvas?.callbacks.onNudge('left', 1))
    expect(screen.getByTestId('stage-label-left-temp').textContent).toBe('73°')
  })

  it('shows the cards and the could-not-load line when 3D is unavailable, keeping header and timeline', async () => {
    m.mode = '2d'
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    expect(screen.getByText('3D view could not load')).toBeTruthy()
    expect(screen.getAllByTestId('side-card').map(el => el.textContent)).toEqual(['Jon', 'Heidi'])
    expect(screen.queryByTestId('stage-canvas')).toBeNull()
    expect(screen.queryByTestId('stage-labels')).toBeNull()
    expect(screen.queryByTestId('stage-loading')).toBeNull()
    expect(screen.getByTestId('stage-timeline')).toBeTruthy()
    expect(screen.getByTestId('stage-mode').textContent).toBe('Live')
    expect(screen.getByTestId('stage-hints').textContent).toContain('set temp on a side')
  })

  it('exits through the header button and turns everything off with All off', async () => {
    const onExit = vi.fn()
    render(<TempStage onExit={onExit} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Back to cards' }))
    expect(onExit).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'All off' }))
    expect(m.setPower).toHaveBeenCalledTimes(1)
    expect(m.setPower).toHaveBeenCalledWith({ side: 'left', powered: false }, expect.anything())
  })

  it('falls back to °F, unknown room readings and no presence when settings, occupancy and frames are missing', async () => {
    m.settings = undefined
    m.occupancy = undefined
    m.frame = undefined
    m.health = { tone: 'warn', summary: 'checking…' }
    m.statusLoading = true
    m.status = { leftSide: { ...sideStatus(72, 5), currentTemperature: null }, rightSide: sideStatus(84, 0) }
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    expect(screen.getByTestId('stage-room').textContent).toBe('—')
    expect(screen.getByTestId('stage-humidity').textContent).toBe('—')
    expect(screen.getByTestId('stage-bed-air').textContent).toBe('—')
    expect(screen.getByTestId('stage-health').textContent).toBe('Pod · Checking')
    expect(screen.getByTestId('stage-mode').textContent).toBe('Connecting')
    // No controller reading and no zones: the left half has nothing to show.
    expect(m.canvas?.state.sides.left.shownF).toBeNull()
    fireEvent.keyDown(window, { key: '1' })
    expect(screen.getByRole('region', { name: 'Jon controls' }).textContent).toContain('Left')
    expect(screen.getByRole('region', { name: 'Jon controls' }).textContent).not.toMatch(/In bed|Out of bed|Away/)
  })

  it('reads the newest of both frames for the room and refreshes staleness on its own clock', async () => {
    m.older = { ...(m.frame as object), type: 'bedTemp', ts: NOW.getTime() / 1000 - 30, ambientTemp: 10, humidity: 10 }
    m.health = { tone: 'bad', summary: 'degraded' }
    m.status = { leftSide: { ...sideStatus(72, 0), currentTemperature: null }, rightSide: sideStatus(84, 0) }
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    // bedTemp2 is newer (10 s) than bedTemp (30 s), so the room reads 21 °C → 70 °F.
    expect(screen.getByTestId('stage-room').textContent).toBe('70°')
    expect(screen.getByTestId('stage-health').textContent).toBe('Pod · degraded')
    // Off with no controller reading: the label falls back to the mean of the zones.
    expect(screen.getByTestId('stage-label-left-temp').textContent).toBe('73°')
    // 90 s later the frames are stale; the 5 s tick notices without a new frame.
    act(() => vi.advanceTimersByTime(95_000))
    expect(zones()[0]).toBe('left-outer:OUTER--')
  })

  it('exposes the label refs to the canvas', async () => {
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    const refs = m.canvas?.labels() as { side: Record<string, HTMLElement | null>, linked: HTMLElement | null }
    expect(refs.side.left).toBe(screen.getByTestId('stage-label-left'))
    expect(refs.linked).toBe(screen.getByTestId('stage-label-linked'))
  })

  it('toggles selection with a repeat key, orbits left and ignores keys it does not own', async () => {
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    // Nothing selected: arrows and space are consumed but do nothing.
    expect(fireEvent.keyDown(window, { key: 'ArrowUp' })).toBe(false)
    expect(fireEvent.keyDown(window, { key: ' ' })).toBe(false)
    expect(m.setPower).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '1' })
    expect(m.canvas?.state.selected).toBe('left')
    fireEvent.keyDown(window, { key: '1' })
    expect(m.canvas?.state.selected).toBeNull()
    fireEvent.keyDown(window, { key: '2' })
    fireEvent.keyDown(window, { key: '2' })
    expect(m.canvas?.state.selected).toBeNull()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(m.orbitBy).toHaveBeenCalledWith(-0.25)
    // Unowned keys and modified keys pass through untouched.
    expect(fireEvent.keyDown(window, { key: 'x' })).toBe(true)
    expect(fireEvent.keyDown(window, { key: '1', metaKey: true })).toBe(true)
    expect(m.canvas?.state.selected).toBeNull()
    // Typing in a field never drives the stage.
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(fireEvent.keyDown(input, { key: '1' })).toBe(true)
    expect(m.canvas?.state.selected).toBeNull()
    input.remove()
  })

  it('names the panel scope from away mode and presence', async () => {
    m.settings = { device: { temperatureUnit: 'F' }, sides: { left: { name: 'Jon', awayMode: true }, right: { name: 'Heidi' } } }
    m.occupancy = { left: { occupied: true, available: true }, right: { occupied: false, available: true } }
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    fireEvent.keyDown(window, { key: '1' })
    expect(screen.getByRole('region', { name: 'Jon controls' }).textContent).toContain('Left · Away')
    fireEvent.keyDown(window, { key: '2' })
    expect(screen.getByRole('region', { name: 'Heidi controls' }).textContent).toContain('Right · Out of bed')
    m.settings = { device: { temperatureUnit: 'F' }, sides: {} }
    m.occupancy = { left: { occupied: true, available: true }, right: { occupied: false, available: false } }
    cleanup()
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    fireEvent.keyDown(window, { key: '1' })
    expect(screen.getByRole('region', { name: 'Jon controls' }).textContent).toContain('Left · In bed')
    fireEvent.keyDown(window, { key: '2' })
    const right = screen.getByRole('region', { name: 'Heidi controls' }).textContent
    expect(right).toContain('Right')
    expect(right).not.toMatch(/In bed|Out of bed/)
  })

  it('drives the selected side from the panel: power, warmer, the dial, resume and close', async () => {
    m.status = {
      ...(m.status as object),
      temperatureControl: { left: { source: 'manual', requestId: null, targetTemperature: 72, holdUntil: NOW.getTime() + 60_000, blocked: null }, right: { source: null, requestId: null, targetTemperature: null, holdUntil: null, blocked: 'off' } },
    }
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    fireEvent.keyDown(window, { key: '1' })
    const panel = screen.getByRole('region', { name: 'Jon controls' })
    fireEvent.click(screen.getByRole('button', { name: 'Warmer' }))
    act(() => vi.advanceTimersByTime(600))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'left', temperature: 73 }, expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Cooler' }))
    act(() => vi.advanceTimersByTime(600))
    expect(m.setTemp).toHaveBeenLastCalledWith({ side: 'left', temperature: 72 }, expect.anything())
    // The dial's own keys preview and commit through the same path.
    const dial = screen.getByRole('slider', { name: 'Target temperature' })
    fireEvent.keyDown(dial, { key: 'ArrowRight' })
    expect(m.setTemp).toHaveBeenLastCalledWith({ side: 'left', temperature: 73 }, expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(m.refetch).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Turn Jon off' }))
    expect(m.setPower).toHaveBeenCalledWith({ side: 'left', powered: false }, expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(panel.dataset.open).toBe('false')
  })

  it('steps Now and the night phases from the panel stepper, mirrored when linked', async () => {
    m.control = 'stepper'
    m.side = { isLinked: true }
    m.status = { ...(m.status as object), rightSide: sideStatus(72, 5) }
    m.phases = {
      day: 'monday',
      days: ['monday'],
      night: { temperatureF: 68, start: '22:00', end: '02:00', minutes: 240, times: ['22:00'] },
      dawn: { temperatureF: 79, start: '06:00', end: '06:30', minutes: 30, times: ['06:00'] },
    }
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    fireEvent.keyDown(window, { key: '1' })
    fireEvent.click(screen.getByRole('button', { name: 'Warmer now' }))
    act(() => vi.advanceTimersByTime(600))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'right', temperature: 73 }, expect.anything())
    fireEvent.click(screen.getByRole('tab', { name: /Night/ }))
    expect(screen.getByRole('tab', { name: /Night/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Cooler night' }))
    expect(m.nudge).toHaveBeenCalledTimes(2)
    expect(m.nudge).toHaveBeenCalledWith('night', -1)
  })

  it('wires every card action in the 2D fallback, with the stepper when that is the control', async () => {
    m.mode = '2d'
    m.control = 'stepper'
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    const left = m.sideCards.left
    expect(left.presence).toBe('in')
    expect(m.sideCards.right.presence).toBe('out')
    act(() => left.onPreview(75))
    act(() => left.onCommit(75))
    expect(m.setTemp).toHaveBeenCalledWith({ side: 'left', temperature: 75 }, expect.anything())
    act(() => left.onStep(1))
    act(() => vi.advanceTimersByTime(600))
    expect(m.setTemp).toHaveBeenCalledTimes(2)
    expect(m.setTemp.mock.lastCall?.[0]).toMatchObject({ side: 'left' })
    act(() => left.onPower())
    expect(m.setPower).toHaveBeenCalledWith({ side: 'left', powered: false }, expect.anything())
    act(() => left.onResumed())
    expect(m.refetch).toHaveBeenCalled()
    act(() => left.onHoldChange(60))
    act(() => m.sideCards.left.stepper?.onTabChange('dawn'))
    expect(m.sideCards.left.stepper?.tab).toBe('dawn')
    expect(m.sideCards.right.stepper?.tab).toBe('now')
    act(() => m.sideCards.left.stepper?.onStepPhase('dawn', 1))
    expect(m.nudge).toHaveBeenCalledWith('dawn', 1)
    m.control = 'dial'
    cleanup()
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    expect(m.sideCards.left.stepper).toBeUndefined()
  })

  it('unlinks without copying, skips the copy when sides already match and leaves a running side on during a drag', async () => {
    m.status = { ...(m.status as object), rightSide: sideStatus(72, 5) }
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Link sides' }))
    expect(m.toggleLink).toHaveBeenCalledTimes(1)
    expect(m.setPower).not.toHaveBeenCalled()
    expect(m.setTemp).not.toHaveBeenCalled()
    act(() => m.canvas?.callbacks.onDrag('left', 70))
    expect(m.setPower).not.toHaveBeenCalled()
    expect(screen.getByTestId('stage-label-left-temp').textContent).toBe('70°')
    m.side = { isLinked: true }
    cleanup()
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Linked' }))
    expect(m.toggleLink).toHaveBeenCalledTimes(2)
    expect(m.setPower).not.toHaveBeenCalled()
    // Linked, the bed wears the mean of both halves and the right being occupied lights the linked label.
    expect(m.canvas?.state.sides.left.shownF).toBe(m.canvas?.state.sides.right.shownF)
  })

  it('returns to live from the preview pill', async () => {
    render(<TempStage onExit={() => {}} />)
    await act(async () => {})
    fireEvent.pointerDown(screen.getByTestId('stage-lane'), { clientX: 500, button: 0, pointerId: 1, pointerType: 'mouse' })
    fireEvent.click(screen.getByTestId('stage-mode'))
    expect(screen.getByTestId('stage-mode').textContent).toBe('Live')
    expect(m.canvas?.state.previewing).toBe(false)
  })
})
