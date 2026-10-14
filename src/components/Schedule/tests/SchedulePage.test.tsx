import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ScheduleTime from '@/src/lib/scheduleTime'
import { SchedulePage } from '../SchedulePage'

const m = vi.hoisted(() => ({
  defaultAction: 'turn_off' as string | undefined,
  side: { primarySide: 'left', selectedSide: 'left', selectSide: vi.fn(), singleScheduleSide: null as string | null },
  schedule: {
    confirmMessage: null as string | null,
    isPowerEnabled: true,
    isGlobalEnabled: true,
    isApplying: false,
    isMutating: false,
    toggleAllSchedules: vi.fn(),
    toggleGlobalSchedules: vi.fn(),
    deleteCurve: vi.fn(),
    setSelectedDays: vi.fn(),
    isLoading: false,
  },
  query: { data: undefined as unknown, isLoading: false, error: null as Error | null },
  health: { data: undefined as unknown },
  thermalHistory: { data: undefined as unknown },
  thermalHistoryInput: [] as unknown[],
  push: vi.fn(),
  notes: [] as Array<{ dayOfWeek: string, notes: string }>,
  notesLoading: false,
  saved: { templates: [] as unknown[], isLoading: false, isDeleting: false, isChanging: false, remove: vi.fn(), setActive: vi.fn() },
}))
vi.mock('@/src/hooks/useCurveTemplates', () => ({ useCurveTemplates: () => m.saved }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push }), usePathname: () => '/en/schedule' }))
vi.mock('@/src/providers/SideProvider', () => ({ useSide: () => m.side }))
vi.mock('@/src/hooks/useSchedule', () => ({ useSchedule: () => m.schedule }))
vi.mock('@/src/hooks/useScheduleActive', () => ({ useScheduleActive: () => ({ nextEvent: { time: '12:30 AM', temperature: 79 } }) }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Jon', rightName: 'Heidi' }) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    settings: { getAll: { useQuery: () => ({ data: { device: { defaultScheduleEndAction: m.defaultAction } } }) } },
    schedules: { getAll: { useQuery: () => m.query }, getNotes: { useQuery: () => ({ data: m.notesLoading ? undefined : m.notes, isLoading: m.notesLoading }) } },
    health: {
      system: { useQuery: () => m.health },
      thermalHistory: { useQuery: (input: unknown, opts: unknown) => {
        m.thermalHistoryInput.push({ input, opts })
        return m.thermalHistory
      } },
    },
  },
}))
vi.mock('@/src/lib/scheduleTime', async orig => ({
  ...(await orig<typeof ScheduleTime>()),
  getCurrentDay: () => 'monday',
}))
vi.mock('../AlarmSection', () => ({
  AlarmSection: ({ side, selectedSide }: { side: string, selectedSide: string }) => <div data-testid="alarms">{`${side}/${selectedSide}`}</div>,
}))
vi.mock('../CurveEditor', () => ({
  CurveEditor: ({ onClose, initialDays, initialEndAction, initialSetPoints, initialNotes, curveId, initialName, initialActive, curveDays }: {
    onClose: () => void
    initialDays: string[]
    initialEndAction?: string
    initialSetPoints: Array<{ time: string }>
    initialNotes?: string
    curveId?: number
    initialName?: string
    initialActive?: boolean
    curveDays?: unknown
  }) => (
    <div
      data-testid="editor"
      data-end-action={initialEndAction}
      data-points={initialSetPoints.map(p => p.time).join(',')}
      data-notes={initialNotes ?? ''}
      data-curve={curveId === undefined ? '' : `${curveId}:${initialName}:${initialActive}:${JSON.stringify(curveDays)}`}
    >
      {initialDays.join(',') || 'new'}
      <button type="button" onClick={onClose}>close editor</button>
    </div>
  ),
}))

const temp = (dayOfWeek: string, time: string, temperature: number, enabled = true) => ({ dayOfWeek, time, temperature, enabled })
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
const DATA = {
  power: [],
  temperature: [
    ...WEEKDAYS.flatMap(d => [temp(d, '23:15', 83), temp(d, '07:00', 84)]),
    ...['saturday', 'sunday'].flatMap(d => [temp(d, '23:45', 78), temp(d, '08:30', 84)]),
  ],
}

beforeEach(() => {
  m.notes = []
  m.notesLoading = false
  m.saved.templates = []
  m.saved.isLoading = false
  m.saved.isChanging = false
  m.saved.remove.mockReset().mockResolvedValue({ deleted: true })
  m.saved.setActive.mockReset().mockResolvedValue({ curve: {}, moved: [] })
  m.side.selectedSide = 'left'
  m.side.singleScheduleSide = null
  m.side.selectSide.mockReset()
  m.push.mockReset()
  m.schedule.isPowerEnabled = true
  m.schedule.confirmMessage = null
  m.schedule.isGlobalEnabled = true
  m.schedule.toggleAllSchedules.mockReset()
  m.schedule.toggleGlobalSchedules.mockReset()
  m.schedule.deleteCurve.mockReset().mockResolvedValue(undefined)
  m.schedule.setSelectedDays.mockReset()
  m.query = { data: DATA, isLoading: false, error: null }
  m.health = { data: { scheduler: { enabled: true, jobCount: 42, drift: { drifted: false } } } }
  m.thermalHistory = { data: undefined }
  m.thermalHistoryInput = []
})
afterEach(cleanup)

describe('SchedulePage', () => {
  it('features today’s curve as active and lists the others with a create slot', () => {
    const s = render(<SchedulePage />)
    const featured = s.getByTestId('curve-card-featured')
    expect(within(featured).getByText('Mon–Fri')).toBeTruthy()
    expect(within(featured).getAllByText('ACTIVE').length).toBeGreaterThan(0)
    expect(s.getByText('Sat, Sun')).toBeTruthy()
    expect(s.getByRole('button', { name: 'Create curve' })).toBeTruthy()
    expect(s.getByText('Scheduler in sync · 42 jobs')).toBeTruthy()
    expect(s.getByText('Applies to Jon · edits apply on save')).toBeTruthy()
    expect(s.getByTestId('alarms').textContent).toBe('left/left')
  })

  it('overlays last night’s bed temperature on the featured chart with a legend', () => {
    // 1 AM this morning falls inside the featured 11:15 PM → 7 AM curve.
    const now = new Date()
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1).getTime()
    const point = (ms: number, leftBed: number) => ({
      t: ms, leftBed, rightBed: null, leftTarget: 80, rightTarget: null, leftWater: null, rightWater: null,
      leftSurface: null, rightSurface: null, leftRpm: null, rightRpm: null, heatsink: null, ambient: null,
    })
    m.thermalHistory = { data: { points: [point(t, 78.6), point(t + 240_000, 78.9)], available: { bedTarget: true } } }
    const s = render(<SchedulePage />)
    const featured = s.getByTestId('curve-card-featured')
    expect(within(featured).getByTestId('curve-legend').textContent).toMatch(/^Target\s*Bed · (last night|tonight)$/)
    expect(within(featured).getByTestId('curve-bed')).toBeTruthy()
    expect(m.thermalHistoryInput.at(-1)).toMatchObject({ input: { range: expect.stringMatching(/^(24|48)h$/) }, opts: { enabled: true } })
  })

  it('still features a curve without the active badge when the schedule is off', () => {
    m.schedule.isPowerEnabled = false
    const s = render(<SchedulePage />)
    expect(within(s.getByTestId('curve-card-featured')).queryByText('ACTIVE')).toBeNull()
  })

  it('reports scheduler drift and a disabled scheduler', () => {
    m.health = { data: { scheduler: { enabled: true, jobCount: 1, drift: { drifted: true } } } }
    const s = render(<SchedulePage />)
    expect(s.getByText('Scheduler out of sync · 1 job')).toBeTruthy()
    cleanup()
    m.health = { data: { scheduler: { enabled: false, jobCount: 0 } } }
    expect(render(<SchedulePage />).getByText('Scheduler off')).toBeTruthy()
  })

  it('switches sides and pauses the whole schedule (all days) from the header toggle', () => {
    const s = render(<SchedulePage />)
    fireEvent.click(s.getAllByRole('tab', { name: 'Heidi' })[0])
    expect(m.side.selectSide).toHaveBeenCalledWith('right')
    const toggle = s.getAllByRole('switch', { name: 'Toggle schedule' })[0]
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(m.schedule.toggleGlobalSchedules).toHaveBeenCalledOnce()
    expect(m.schedule.toggleAllSchedules).not.toHaveBeenCalled()
  })

  it('hides the side switch when one side is away', () => {
    // The Temp screen may have the selection on 'both' (linked).
    m.side.selectedSide = 'both'
    m.side.singleScheduleSide = 'right'
    const s = render(<SchedulePage />)
    expect(s.queryAllByRole('tablist', { name: 'Side' })).toHaveLength(0)
    expect(s.getByTestId('alarms').textContent).toBe('right/right')
  })

  it('reflects the global enabled state, not just today’s power schedule', () => {
    m.schedule.isGlobalEnabled = false
    m.schedule.isPowerEnabled = true
    const s = render(<SchedulePage />)
    for (const sw of s.getAllByRole('switch', { name: 'Toggle schedule' })) {
      expect(sw.getAttribute('aria-checked')).toBe('false')
    }
  })

  it('links each curve to its own route', () => {
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('button', { name: 'Edit Sat, Sun' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/sat-sun?side=left')
    expect(m.schedule.setSelectedDays).toHaveBeenCalledWith(new Set(['sunday', 'saturday']))
    fireEvent.click(s.getByRole('button', { name: 'New curve' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/new?side=left')
    expect(s.queryByTestId('editor')).toBeNull()
  })

  it('opens the linked curve in the editor and returns to the list on close', () => {
    const s = render(<SchedulePage curve="sat-sun" curveSide="left" />)
    expect(s.getByTestId('editor').textContent).toContain('sunday,saturday')
    fireEvent.click(s.getByRole('button', { name: 'close editor' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule')
    expect(m.side.selectSide).not.toHaveBeenCalled()
    cleanup()
    expect(render(<SchedulePage curve="new" />).getByTestId('editor').textContent).toContain('new')
  })

  it('selects the linked side before opening its curve', () => {
    const s = render(<SchedulePage curve="sat-sun" curveSide="right" />)
    expect(m.side.selectSide).toHaveBeenCalledWith('right')
    expect(s.queryByTestId('editor')).toBeNull()
    expect(s.container.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('leaves the side alone on a link when only one side is scheduled', () => {
    m.side.singleScheduleSide = 'left'
    const s = render(<SchedulePage curve="sat-sun" curveSide="right" />)
    expect(m.side.selectSide).not.toHaveBeenCalled()
    expect(s.getByTestId('editor')).toBeTruthy()
    cleanup()
    fireEvent.click(render(<SchedulePage />).getByRole('button', { name: 'Edit Mon–Fri' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/mon-tue-wed-thu-fri')
  })

  it('explains a link to a curve that no longer exists', () => {
    const s = render(<SchedulePage curve="mon-sat" curveSide="left" />)
    expect(s.getByText(/No curve runs on exactly Mon, Sat/)).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: /Schedule/ }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule')
    cleanup()
    expect(render(<SchedulePage curve="tomorrow" />).getByText('"tomorrow" isn\'t a curve.')).toBeTruthy()
    cleanup()
    m.query = { data: undefined, isLoading: false, error: new Error('db down') }
    expect(render(<SchedulePage curve="sat-sun" />).getByText(/Failed to load schedules: db down/)).toBeTruthy()
  })

  it('deletes a curve after confirmation', async () => {
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('button', { name: 'Delete Mon–Fri' }))
    const dialog = s.getByRole('dialog')
    expect(within(dialog).getByText(/remove the schedule for 5 days/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(s.queryByRole('dialog')).toBeNull())
    expect(m.schedule.deleteCurve).toHaveBeenCalledWith(WEEKDAYS)
  })

  it('shows both sides as stacked lanes with per-person phases and curves', () => {
    m.side.selectedSide = 'both'
    const s = render(<SchedulePage />)
    const night = s.getByTestId('both-night')
    expect(within(night).getByText('Monday night')).toBeTruthy()
    expect(within(s.getByTestId('lane-left')).getByText('Jon')).toBeTruthy()
    expect(within(s.getByTestId('lane-right')).getByText('Heidi')).toBeTruthy()
    expect(s.queryByTestId('curve-card-featured')).toBeNull()
    const list = s.getByTestId('person-curves')
    expect(within(list).getAllByText('Jon').length).toBe(2)
    expect(within(list).getAllByText('Heidi').length).toBe(2)
    expect(s.getByText('Applies to Jon and Heidi · edits apply on save')).toBeTruthy()
    expect(s.getByText(/^Next:/)).toBeTruthy()

    fireEvent.click(within(night).getByRole('tab', { name: 'Sat' }))
    expect(within(night).getByText('Saturday night')).toBeTruthy()
  })

  it('narrows to one person to edit their curve from the Both view, then returns', () => {
    m.side.selectedSide = 'both'
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('button', { name: 'Edit Heidi Sat, Sun' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/sat-sun?side=right&from=both')
    cleanup()

    m.side.selectedSide = 'right'
    const editing = render(<SchedulePage curve="sat-sun" curveSide="right" fromBoth />)
    expect(editing.getByTestId('editor').textContent).toContain('sunday,saturday')
    fireEvent.click(editing.getByRole('button', { name: 'close editor' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule')
    // Not while the curve route is still up, where the side sync would undo it…
    expect(m.side.selectSide).not.toHaveBeenCalledWith('both')
    // …but once it's left, however it was left (close, save or browser Back).
    editing.unmount()
    expect(m.side.selectSide).toHaveBeenLastCalledWith('both')
  })

  it('keeps the open editor when a refetch regroups its days', () => {
    m.query = { data: DATA, isLoading: false, error: null }
    const s = render(<SchedulePage curve="sat-sun" curveSide="left" />)
    expect(s.getByTestId('editor').textContent).toContain('sunday,saturday')
    // Another client moved Saturday onto the weekday curve.
    m.query = { data: { ...DATA, temperature: DATA.temperature.map(t => t.dayOfWeek === 'saturday' ? { ...t, time: t.time === '23:45' ? '23:15' : '07:00', temperature: t.time === '23:45' ? 83 : 84 } : t) }, isLoading: false, error: null }
    s.rerender(<SchedulePage curve="sat-sun" curveSide="left" />)
    expect(s.getByTestId('editor').textContent).toContain('sunday,saturday')
  })

  it('shows the empty state, loading skeleton and load errors', () => {
    m.query = { data: { temperature: [] }, isLoading: false, error: null }
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('button', { name: 'Create sleep curve' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/new?side=left')
    cleanup()

    m.query = { data: undefined, isLoading: true, error: null }
    const loading = render(<SchedulePage />)
    expect(loading.container.querySelector('.animate-pulse')).not.toBeNull()
    expect(loading.queryByText('No schedule yet')).toBeNull()
    cleanup()

    m.query = { data: undefined, isLoading: false, error: new Error('db down') }
    const failed = render(<SchedulePage />)
    expect(failed.getByText(/Failed to load schedules:.*db down/)).toBeTruthy()
    expect(failed.queryByText('No schedule yet')).toBeNull()
  })
})

it('deletes from Both view, or cancels and restores the combined selection', async () => {
  m.side.selectedSide = 'both'
  const s = render(<SchedulePage />)
  fireEvent.click(s.getByRole('button', { name: 'Delete Heidi Sat, Sun' }))
  expect(m.side.selectSide).toHaveBeenLastCalledWith('right')
  fireEvent.click(within(s.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(m.side.selectSide).toHaveBeenLastCalledWith('both')
  expect(m.schedule.deleteCurve).not.toHaveBeenCalled()
  fireEvent.click(s.getByRole('button', { name: 'Delete Jon Mon–Fri' }))
  fireEvent.click(within(s.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(m.schedule.deleteCurve).toHaveBeenCalledWith(WEEKDAYS))
  expect(m.side.selectSide).toHaveBeenLastCalledWith('both')
})

it('deletes a nonfeatured curve and opens the featured curve for editing', () => {
  const s = render(<SchedulePage />)
  fireEvent.click(s.getByRole('button', { name: 'Delete Sat, Sun' }))
  expect(s.getByRole('dialog')).toBeTruthy()
  fireEvent.click(within(s.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(s.getByRole('button', { name: 'Edit Mon–Fri' }))
  expect(m.push).toHaveBeenLastCalledWith('/en/schedule/mon-tue-wed-thu-fri?side=left')
})

it('uses the global default for new curves and the saved action when editing', () => {
  m.defaultAction = 'maintain'
  expect(render(<SchedulePage curve="new" />).getByTestId('editor').getAttribute('data-end-action')).toBe('maintain')
  cleanup()
  expect(render(<SchedulePage curve="mon-tue-wed-thu-fri" />).getByTestId('editor').getAttribute('data-end-action')).toBe('turn_off')
  m.defaultAction = 'turn_off'
})

it('falls back to turning off for new curves before the default setting loads', () => {
  m.defaultAction = undefined
  expect(render(<SchedulePage curve="new" />).getByTestId('editor').getAttribute('data-end-action')).toBe('turn_off')
  m.defaultAction = 'turn_off'
})

describe('curve library', () => {
  const curve = (id: number, name: string, days: { left?: string[], right?: string[] }, active: boolean, extra: object = {}) => ({
    id, name, bedtime: '23:15', wake: '07:00', points: { '23:15': 83, '07:00': 84 }, notes: '', endAction: 'turn_off',
    days: { left: days.left ?? [], right: days.right ?? [] }, active, createdAt: 1, ...extra,
  })
  const WEEKNIGHT = curve(7, 'Weeknight', { left: WEEKDAYS }, true, { notes: 'Cooler first half.' })
  const HEATWAVE = curve(8, 'Heatwave', { left: [...WEEKDAYS, 'saturday', 'sunday'] }, false)
  const IDEA = curve(9, 'Idea', {}, false)
  const HEIDI = curve(10, 'Heidi nights', { right: WEEKDAYS }, true)

  it('lists curves with their days and switches, active first, and only those for the shown side', () => {
    m.saved.templates = [IDEA, HEATWAVE, WEEKNIGHT, HEIDI]
    const s = render(<SchedulePage />)
    expect(s.getByText('Curves')).toBeTruthy()
    const cards = s.getAllByTestId('library-curve')
    expect(cards.map(c => within(c).getAllByText(/./)[0].textContent)).toEqual(['Weeknight', 'Idea', 'Heatwave'])
    expect(within(cards[0]).getByText('Mon–Fri')).toBeTruthy()
    expect(within(cards[0]).getByRole('switch', { name: 'Turn off Weeknight' }).getAttribute('aria-checked')).toBe('true')
    expect(within(cards[1]).getByText('Off · No days')).toBeTruthy()
    expect(within(cards[2]).getByText('Off · Every day')).toBeTruthy()
    expect(s.queryByText('Heidi nights')).toBeNull()
  })

  it('shows both sides\' days in the Both view', () => {
    m.side.selectedSide = 'both'
    m.saved.templates = [WEEKNIGHT, HEIDI, curve(11, 'Shared', { left: ['monday'], right: ['monday'] }, false)]
    const s = render(<SchedulePage />)
    const labels = s.getAllByTestId('library-curve').map(c => c.textContent)
    expect(labels.some(t => t?.includes('Jon Mon–Fri'))).toBe(true)
    expect(labels.some(t => t?.includes('Heidi Mon–Fri'))).toBe(true)
    expect(labels.some(t => t?.includes('Off · Both · Mon'))).toBe(true)
  })

  it('names the featured curve after the library curve running it and marks schedules not in the library', () => {
    m.saved.templates = [WEEKNIGHT]
    const s = render(<SchedulePage />)
    const featured = s.getByTestId('curve-card-featured')
    expect(within(featured).getByText('Weeknight · Mon–Fri')).toBeTruthy()
    fireEvent.click(within(featured).getByRole('button', { name: 'Edit Weeknight · Mon–Fri' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/7?side=left')
    expect(s.getByText('NOT SAVED')).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: 'Edit Sat, Sun' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/sat-sun?side=left')
  })

  it('opens a curve from its card and from Both view rows', () => {
    m.saved.templates = [WEEKNIGHT]
    const s = render(<SchedulePage />)
    fireEvent.click(s.getAllByTestId('library-curve')[0])
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/7?side=left')
    cleanup()
    m.side.selectedSide = 'both'
    const both = render(<SchedulePage />)
    fireEvent.click(both.getByRole('button', { name: 'Edit Jon Mon–Fri' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/7?side=left&from=both')
    // A one-side curve opens on its own side from Both, so saving can't copy it to the other side.
    fireEvent.click(both.getAllByTestId('library-curve')[0])
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/7?side=left&from=both')
    m.push.mockClear()
    fireEvent.click(both.getByRole('button', { name: `Edit ${WEEKNIGHT.name}` }))
    expect(m.push).toHaveBeenCalledTimes(1)
  })

  it('turns a curve off straight away', async () => {
    m.saved.templates = [WEEKNIGHT]
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('switch', { name: 'Turn off Weeknight' }))
    await waitFor(() => expect(m.saved.setActive).toHaveBeenCalledWith(7, false))
    expect(m.push).not.toHaveBeenCalled()
    expect(s.queryByRole('dialog')).toBeNull()
  })

  it('asks before turning on a curve that takes days from another, then turns it on', async () => {
    m.saved.templates = [WEEKNIGHT, HEATWAVE]
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('switch', { name: 'Turn on Heatwave' }))
    const dialog = s.getByRole('dialog')
    expect(within(dialog).getByText('Move days to this curve?')).toBeTruthy()
    expect(within(dialog).getByText('Mon–Fri move from Weeknight, which turns off. Turn on Heatwave?')).toBeTruthy()
    expect(m.saved.setActive).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(s.queryByRole('dialog')).toBeNull()

    fireEvent.click(s.getByRole('switch', { name: 'Turn on Heatwave' }))
    fireEvent.click(within(s.getByRole('dialog')).getByRole('button', { name: 'Move & turn on' }))
    await waitFor(() => expect(m.saved.setActive).toHaveBeenCalledWith(8, true))
    await waitFor(() => expect(s.queryByRole('dialog')).toBeNull())
  })

  it('turns on a curve without overlap directly, and opens one without days to pick them', async () => {
    m.saved.templates = [WEEKNIGHT, curve(12, 'Weekend', { left: ['saturday', 'sunday'] }, false), IDEA]
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('switch', { name: 'Turn on Weekend' }))
    await waitFor(() => expect(m.saved.setActive).toHaveBeenCalledWith(12, true))
    expect(s.queryByRole('dialog')).toBeNull()
    fireEvent.click(s.getByRole('switch', { name: 'Turn on Idea' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/9?side=left')
    expect(m.saved.setActive).toHaveBeenCalledTimes(1)
  })

  it('shows a failed switch inline', async () => {
    m.saved.templates = [WEEKNIGHT]
    m.saved.setActive.mockRejectedValueOnce(new Error('pump stall guard tripped')).mockRejectedValueOnce('nope')
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('switch', { name: 'Turn off Weeknight' }))
    expect(await s.findByText('pump stall guard tripped')).toBeTruthy()
    fireEvent.click(s.getByRole('switch', { name: 'Turn off Weeknight' }))
    expect(await s.findByText('Failed to turn off Weeknight')).toBeTruthy()
  })

  it('deletes a curve after confirming, warning when it is running', async () => {
    m.saved.templates = [WEEKNIGHT, IDEA]
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('button', { name: 'Delete Weeknight' }))
    let dialog = s.getByRole('dialog')
    expect(within(dialog).getByText(/"Weeknight" will be removed and stop running on Jon Mon–Fri\./)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(m.saved.remove).not.toHaveBeenCalled()

    fireEvent.click(s.getByRole('button', { name: 'Delete Idea' }))
    dialog = s.getByRole('dialog')
    expect(within(dialog).getByText('"Idea" will be removed from your curves.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(m.saved.remove).toHaveBeenCalledWith('Idea'))
    await waitFor(() => expect(s.queryByRole('dialog')).toBeNull())
    expect(m.push).not.toHaveBeenCalled()
  })

  it('lists library curves without a schedule instead of the empty state', () => {
    m.query = { data: { temperature: [] }, isLoading: false, error: null }
    m.saved.templates = [IDEA]
    const s = render(<SchedulePage />)
    expect(s.queryByText('No schedule yet')).toBeNull()
    expect(s.getByText('Idea')).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: 'Create curve' }))
    expect(m.push).toHaveBeenLastCalledWith('/en/schedule/new?side=left')
  })

  it('opens a library curve by id with its name, state, days and set points', () => {
    m.saved.templates = [WEEKNIGHT]
    const editor = render(<SchedulePage curve="7" curveSide="left" />).getByTestId('editor')
    expect(editor.textContent).toContain('monday,tuesday,wednesday,thursday,friday')
    expect(editor.getAttribute('data-curve')).toBe(`7:Weeknight:true:${JSON.stringify(WEEKNIGHT.days)}`)
    expect(editor.getAttribute('data-points')).toBe('23:15,07:00')
    expect(editor.getAttribute('data-notes')).toBe('Cooler first half.')
  })

  it('opens the library curve running a linked set of days', () => {
    m.saved.templates = [WEEKNIGHT]
    const editor = render(<SchedulePage curve="mon-tue-wed-thu-fri" curveSide="left" />).getByTestId('editor')
    expect(editor.getAttribute('data-curve')).toMatch(/^7:Weeknight:true:/)
    cleanup()
    expect(render(<SchedulePage curve="sat-sun" curveSide="left" />).getByTestId('editor').getAttribute('data-curve')).toBe('')
  })

  it('explains a link to a curve that left the library, and waits for the library to load', () => {
    const s = render(<SchedulePage curve="99" />)
    expect(s.getByText('That curve is no longer in the library. It may have been deleted.')).toBeTruthy()
    cleanup()
    m.saved.isLoading = true
    const loading = render(<SchedulePage curve="7" />)
    expect(loading.queryByTestId('editor')).toBeNull()
    expect(loading.container.querySelector('.animate-pulse')).not.toBeNull()
    cleanup()
    expect(render(<SchedulePage curve="new" />).queryByTestId('editor')).toBeNull()
  })
})

describe('curve notes', () => {
  it('shows the first note among a curve\'s days on its card and opens the editor with it', () => {
    m.notes = [{ dayOfWeek: 'tuesday', notes: 'Weeknights: cooler first half' }, { dayOfWeek: 'sunday', notes: 'Weekend sleep-in' }]
    const s = render(<SchedulePage />)
    expect(s.getAllByText('Weeknights: cooler first half').length).toBeGreaterThan(0)
    expect(s.getByText('Weekend sleep-in')).toBeTruthy()
    cleanup()
    expect(render(<SchedulePage curve="mon-tue-wed-thu-fri" />).getByTestId('editor').getAttribute('data-notes')).toBe('Weeknights: cooler first half')
  })

  it('waits for notes before opening an existing curve so saving cannot clear an unloaded note', () => {
    m.notesLoading = true
    expect(render(<SchedulePage curve="mon-tue-wed-thu-fri" />).queryByTestId('editor')).toBeNull()
    cleanup()
    expect(render(<SchedulePage curve="new" />).getByTestId('editor')).toBeTruthy()
  })
})
