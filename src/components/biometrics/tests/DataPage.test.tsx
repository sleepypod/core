import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SleepScreen as DataPage } from '@/src/components/Sleep/SleepScreen'

const state = vi.hoisted(() => ({
  primarySide: 'left' as 'left' | 'right',
  singleSleeperSide: null as 'left' | 'right' | null,
  selectSide: vi.fn(),
  sleep: vi.fn(),
  stages: vi.fn(),
  vitals: vi.fn(),
  movement: vi.fn(),
}))
vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({
    selectedSide: 'both', primarySide: state.primarySide, activeSides: ['left', 'right'],
    singleSleeperSide: state.singleSleeperSide, selectSide: state.selectSide,
  }),
}))
vi.mock('@/src/hooks/useWeekNavigator', () => ({
  useWeekNavigator: () => ({
    weekStart: new Date(2026, 8, 20), weekEnd: new Date(2026, 8, 26, 23, 59, 59, 999),
    label: 'Sep 20 – 26', isCurrentWeek: true,
    goToPreviousWeek: vi.fn(), goToNextWeek: vi.fn(), goToCurrentWeek: vi.fn(),
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
    settings: { getAll: { useQuery: () => ({ data: { sides: { left: { name: 'Jon' }, right: { name: 'Heidi' } } } }) } },
  },
}))
vi.mock('@/src/components/MovementChart/MovementChart', () => ({ MovementChart: () => null }))
vi.mock('@/src/components/biometrics/RawDataButton', () => ({ RawDataButton: () => null }))
vi.mock('@/src/components/biometrics/SleepRecordActions', () => ({ SleepRecordActions: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
  state.singleSleeperSide = null
  state.primarySide = 'left'
  state.sleep.mockReturnValue({ data: [], isLoading: false })
  state.stages.mockReturnValue({ data: undefined, isLoading: false })
  state.vitals.mockReturnValue({ data: [], isLoading: false })
  state.movement.mockReturnValue({ data: [], isLoading: false })
})
afterEach(cleanup)

const sidesQueried = (fn: ReturnType<typeof vi.fn>) => new Set(fn.mock.calls.map(([input]) => input.side))

describe('DataPage single-sleeper routing', () => {
  it.each(['left', 'right'] as const)('shows only the %s sleeper and hides the person switch', (home) => {
    state.singleSleeperSide = home
    render(<DataPage />)
    expect(screen.queryByRole('tablist', { name: 'Person' })).toBeNull()
    expect(sidesQueried(state.sleep)).toEqual(new Set([home]))
    expect(sidesQueried(state.stages)).toEqual(new Set([home]))
    expect(sidesQueried(state.vitals)).toEqual(new Set([home]))
  })

  it.each(['left', 'right'] as const)('switches person from %s when neither side is away', (side) => {
    state.primarySide = side
    const other = side === 'left' ? 'right' : 'left'
    render(<DataPage />)
    expect(sidesQueried(state.sleep)).toEqual(new Set([side]))
    const person = screen.getByRole('tablist', { name: 'Person' })
    expect(person.textContent).toBe('JonHeidi')
    fireEvent.click(screen.getByRole('tab', { name: other === 'left' ? 'Jon' : 'Heidi' }))
    expect(state.selectSide).toHaveBeenCalledWith(other)
  })

  it('does not switch when the current person is tapped again', () => {
    render(<DataPage />)
    fireEvent.click(screen.getByRole('tab', { name: 'Jon' }))
    expect(state.selectSide).not.toHaveBeenCalled()
  })
})
