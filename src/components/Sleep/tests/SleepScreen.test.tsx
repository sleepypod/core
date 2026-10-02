import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SleepScreen } from '../SleepScreen'

const state = vi.hoisted(() => ({
  sleep: vi.fn(),
  stages: vi.fn(),
  vitals: vi.fn(),
  movement: vi.fn(),
  week: {
    isCurrentWeek: true,
    goToPreviousWeek: vi.fn(),
    goToNextWeek: vi.fn(),
  },
}))

vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({
    selectedSide: 'left', primarySide: 'left', activeSides: ['left'],
    singleSleeperSide: null, selectSide: vi.fn(),
  }),
}))
vi.mock('@/src/hooks/useWeekNavigator', () => ({
  useWeekNavigator: () => ({
    weekStart: new Date(2026, 8, 20), weekEnd: new Date(2026, 8, 26, 23, 59, 59, 999),
    label: 'Sep 20 – Sep 26', goToCurrentWeek: vi.fn(), ...state.week,
  }),
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    biometrics: {
      getSleepRecords: { useQuery: state.sleep },
      getSleepStages: { useQuery: state.stages },
      getVitals: { useQuery: state.vitals },
      getMovement: { useQuery: state.movement },
    },
    settings: { getAll: { useQuery: () => ({ data: undefined }) } },
  },
}))
vi.mock('@/src/components/MovementChart/MovementChart', () => ({ MovementChart: () => <div data-testid="movement" /> }))
vi.mock('@/src/components/biometrics/RawDataButton', () => ({ RawDataButton: () => <div data-testid="raw-data" /> }))
vi.mock('@/src/components/biometrics/SleepRecordActions', () => ({
  SleepRecordActions: ({ recordId }: { recordId: number }) => <div data-testid="record-actions">{recordId}</div>,
}))

const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m)
const record = (id: number, entered: Date, hours: number, exits = 0) => ({
  id,
  side: 'left',
  enteredBedAt: entered,
  leftBedAt: new Date(entered.getTime() + hours * 3_600_000),
  sleepDurationSeconds: hours * 3600,
  timesExitedBed: exits,
})
const WEEK = [record(12, at(22, 23, 20), 7.5, 1), record(11, at(21, 22), 6, 3)]
const MONTH = [...WEEK, record(3, at(3, 23), 8, 0)]

function stagesFor(entered: Date, id: number) {
  const start = entered.getTime()
  const epoch = (i: number, stage: string, heartRate: number) => ({
    start: start + i * 300_000, duration: 300_000, stage, heartRate, hrv: 40, breathingRate: 15, movement: 0,
  })
  const epochs = [epoch(0, 'wake', 70), epoch(1, 'light', 60), epoch(2, 'deep', 54), epoch(3, 'rem', 66)]
  return {
    epochs,
    blocks: epochs.map(e => ({ start: e.start, end: e.start + e.duration, stage: e.stage })),
    distribution: { wake: 25, light: 25, deep: 25, rem: 25 },
    qualityScore: 78,
    totalSleepMs: 4 * 300_000,
    sleepRecordId: id,
    enteredBedAt: start,
    leftBedAt: start + 7.5 * 3_600_000,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 28, 12))
  vi.clearAllMocks()
  state.week.isCurrentWeek = true
  state.sleep.mockImplementation(({ limit }: { limit: number }) => ({ data: limit === 100 ? MONTH : WEEK, isLoading: false }))
  state.stages.mockImplementation(({ sleepRecordId }: { sleepRecordId?: number }) => ({
    data: sleepRecordId === 11 ? stagesFor(at(21, 22), 11) : stagesFor(at(22, 23, 20), 12),
    isLoading: false,
  }))
  state.vitals.mockReturnValue({ data: [], isLoading: false })
  state.movement.mockReturnValue({ data: [], isLoading: false })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SleepScreen night view', () => {
  it('shows the latest night of the week with its summary and vitals', () => {
    render(<SleepScreen />)
    expect(state.stages).toHaveBeenCalledWith({ side: 'left', sleepRecordId: 12 }, { enabled: true })
    expect(screen.getByText('Tuesday, Sep 22')).toBeTruthy()
    expect(screen.getAllByText('11:20 PM → 6:50 AM').length).toBeGreaterThan(0)
    expect(screen.getByText('Bedtime').nextSibling?.textContent).toBe('11:20 PM')
    expect(screen.getByText('Wake').nextSibling?.textContent).toBe('6:50 AM')
    // Asleep excludes the awake epoch (3 × 5 min).
    expect(screen.getByText('Asleep').nextSibling?.textContent).toBe('15m')
    expect(screen.getByText('Bed exits').nextSibling?.textContent).toBe('1')
    expect(screen.getByText('min 54 · avg 63 · max 70 bpm')).toBeTruthy()
    expect(screen.getByTestId('record-actions').textContent).toBe('12')
    expect(screen.getByTestId('raw-data')).toBeTruthy()
  })

  it('reads out the heart rate under the pointer with the epoch time', () => {
    const { container } = render(<SleepScreen />)
    // The heart-rate chart is the filled line (two paths) inside a hoverable box.
    const box = [...container.querySelectorAll('svg')].map(s => s.parentElement).find(p => p?.className.includes('relative') && p.querySelectorAll('path').length === 2) as HTMLElement
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 300, height: 96, right: 300, bottom: 96, toJSON: () => ({}) })
    fireEvent.pointerMove(box, { clientX: 0, clientY: 10 })
    expect(screen.getByTestId('chart-hover').textContent).toBe('11:20 PM · 70 bpm')
    fireEvent.pointerMove(box, { clientX: 300, clientY: 10 })
    expect(screen.getByTestId('chart-hover').textContent).toBe('11:35 PM · 66 bpm')
    fireEvent.pointerLeave(box)
    expect(screen.queryByTestId('chart-hover')).toBeNull()
  })

  it('opens another night from the This week bars', () => {
    render(<SleepScreen />)
    fireEvent.click(screen.getByRole('button', { name: /^Mon, Sep 21/ }))
    expect(state.stages).toHaveBeenLastCalledWith({ side: 'left', sleepRecordId: 11 }, { enabled: true })
    expect(screen.getByText('Monday, Sep 21')).toBeTruthy()
    expect(screen.getByText('Bed exits').nextSibling?.textContent).toBe('3')
    expect((screen.getByRole('button', { name: /^Sun, Sep 20/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('falls back to the server latest night when the current week is empty', () => {
    state.sleep.mockReturnValue({ data: [], isLoading: false })
    render(<SleepScreen />)
    expect(state.stages).toHaveBeenCalledWith({ side: 'left' }, { enabled: true })
    expect(screen.getByText('Tuesday, Sep 22')).toBeTruthy()
  })

  it('shows an empty state for a past week without records', () => {
    state.week.isCurrentWeek = false
    state.sleep.mockReturnValue({ data: [], isLoading: false })
    render(<SleepScreen />)
    expect(state.stages).toHaveBeenCalledWith({ side: 'left' }, { enabled: false })
    expect(screen.getByText('No sleep recorded this week')).toBeTruthy()
    expect(screen.getByText('Bedtime').nextSibling?.textContent).toBe('—')
  })

  it('shows an inline error when records fail to load', () => {
    state.sleep.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') })
    render(<SleepScreen />)
    expect(screen.getByText('Failed to load sleep data')).toBeTruthy()
  })

  it('pages weeks from the navigator and blocks paging past the current week', () => {
    render(<SleepScreen />)
    const next = screen.getAllByRole('button', { name: 'Next week' })[0] as HTMLButtonElement
    expect(next.disabled).toBe(true)
    fireEvent.click(screen.getAllByRole('button', { name: 'Previous week' })[0])
    expect(state.week.goToPreviousWeek).toHaveBeenCalled()
    expect(screen.getAllByText('Sep 20 – 26').length).toBeGreaterThan(0)
  })
})

describe('SleepScreen week and month views', () => {
  const pick = (name: string) => fireEvent.click(screen.getAllByRole('tab', { name })[0])

  it('shows the timeline, drill-in and week averages', () => {
    render(<SleepScreen />)
    pick('Week')
    expect(screen.getByText('Sleep timeline')).toBeTruthy()
    expect(screen.getByTestId('movement')).toBeTruthy()
    expect(screen.getByText('Tuesday, Sep 22')).toBeTruthy()
    expect(screen.getByText('11:20 PM → 6:50 AM · 7h 30m · quality 78')).toBeTruthy()
    // (7.5 + 6) / 2 nights
    expect(screen.getByText('Week averages').parentElement?.textContent).toContain('6h 45m')
    fireEvent.click(screen.getByRole('button', { name: /Mon 21/ }))
    expect(screen.getByText('Monday, Sep 21')).toBeTruthy()
  })

  it('shows the month calendar, stats and nights list', () => {
    render(<SleepScreen />)
    pick('Month')
    expect(state.sleep).toHaveBeenLastCalledWith(expect.objectContaining({ side: 'left', limit: 100, startDate: new Date(2026, 8, 1, 6) }))
    expect(screen.getAllByText('September 2026').length).toBeGreaterThan(0)
    const day3 = screen.getByTestId('day-2026-09-03')
    expect(day3.style.background).toContain('0.6')
    expect(within(screen.getByTestId('day-2026-09-04')).getByText('no data')).toBeTruthy()
    expect(within(screen.getByTestId('day-2026-09-29')).queryByText('no data')).toBeNull()
    expect(screen.getByTestId('day-2026-09-28').className).toContain('shadow')
    expect(screen.getAllByText('Nights')[0].nextSibling?.textContent).toBe('3')
    expect(screen.getByText('Tue, Sep 22')).toBeTruthy()
    expect(screen.getByText('3 exits')).toBeTruthy()
    expect(screen.getByText('0 exits')).toBeTruthy()
    const nextMonth = screen.getAllByRole('button', { name: 'Next month' })[0] as HTMLButtonElement
    expect(nextMonth.disabled).toBe(true)
    fireEvent.click(screen.getAllByRole('button', { name: 'Previous month' })[0])
    expect(screen.getAllByText('August 2026').length).toBeGreaterThan(0)
    expect(state.sleep).toHaveBeenLastCalledWith(expect.objectContaining({ startDate: new Date(2026, 7, 1, 6) }))
  })
})
