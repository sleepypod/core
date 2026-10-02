import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ScheduleTime from '@/src/lib/scheduleTime'
import { SchedulePage } from '../SchedulePage'

const m = vi.hoisted(() => ({
  side: { primarySide: 'left', selectedSide: 'left', selectSide: vi.fn(), singleSleeperSide: null as string | null },
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
}))
vi.mock('@/src/providers/SideProvider', () => ({ useSide: () => m.side }))
vi.mock('@/src/hooks/useSchedule', () => ({ useSchedule: () => m.schedule }))
vi.mock('@/src/hooks/useScheduleActive', () => ({ useScheduleActive: () => ({ nextEvent: { time: '12:30 AM', temperature: 79 } }) }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Jon', rightName: 'Heidi' }) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    schedules: { getAll: { useQuery: () => m.query } },
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
  CurveEditor: ({ onClose, initialDays }: { onClose: () => void, initialDays: string[] }) => (
    <div data-testid="editor">
      {initialDays.join(',') || 'new'}
      <button type="button" onClick={onClose}>close editor</button>
    </div>
  ),
}))

const temp = (dayOfWeek: string, time: string, temperature: number, enabled = true) => ({ dayOfWeek, time, temperature, enabled })
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
const DATA = {
  temperature: [
    ...WEEKDAYS.flatMap(d => [temp(d, '23:15', 83), temp(d, '07:00', 84)]),
    ...['saturday', 'sunday'].flatMap(d => [temp(d, '23:45', 78), temp(d, '08:30', 84)]),
  ],
}

beforeEach(() => {
  m.side.selectedSide = 'left'
  m.side.singleSleeperSide = null
  m.side.selectSide.mockReset()
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
    m.side.singleSleeperSide = 'right'
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

  it('opens the editor for a curve and returns to the list on close', () => {
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('button', { name: 'Edit Sat, Sun' }))
    expect(s.getByTestId('editor').textContent).toContain('sunday,saturday')
    expect(m.schedule.setSelectedDays).toHaveBeenCalledWith(new Set(['sunday', 'saturday']))
    fireEvent.click(s.getByRole('button', { name: 'close editor' }))
    expect(s.queryByTestId('editor')).toBeNull()
    fireEvent.click(s.getByRole('button', { name: 'New curve' }))
    expect(s.getByTestId('editor').textContent).toContain('new')
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
    expect(m.side.selectSide).toHaveBeenLastCalledWith('right')
    expect(s.getByTestId('editor').textContent).toContain('sunday,saturday')
    fireEvent.click(s.getByRole('button', { name: 'close editor' }))
    expect(m.side.selectSide).toHaveBeenLastCalledWith('both')
  })

  it('shows the empty state, loading skeleton and load errors', () => {
    m.query = { data: { temperature: [] }, isLoading: false, error: null }
    const s = render(<SchedulePage />)
    fireEvent.click(s.getByRole('button', { name: 'Create sleep curve' }))
    expect(s.getByTestId('editor').textContent).toContain('new')
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
  expect(s.getByTestId('editor')).toBeTruthy()
})
