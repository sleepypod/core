import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DataPage from '@/app/[lang]/data/page'
import { VitalsPanel } from '@/src/components/VitalsPanel/VitalsPanel'

const state = vi.hoisted(() => ({
  primarySide: 'left' as 'left' | 'right',
  singleSleeperSide: null as 'left' | 'right' | null,
  selectSide: vi.fn(),
  sleep: vi.fn(),
  vitals: vi.fn(),
  baseline: vi.fn(),
}))
vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({
    selectedSide: 'both', primarySide: state.primarySide, activeSides: ['left', 'right'],
    singleSleeperSide: state.singleSleeperSide, selectSide: state.selectSide,
  }),
}))
vi.mock('@/src/hooks/useWeekNavigator', () => ({
  useWeekNavigator: () => ({
    weekStart: new Date('2026-09-20'), weekEnd: new Date('2026-09-27'),
    label: 'This week', isCurrentWeek: true,
    goToPreviousWeek: vi.fn(), goToNextWeek: vi.fn(), goToCurrentWeek: vi.fn(),
  }),
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: { biometrics: {
    getSleepRecords: { useQuery: state.sleep },
    getVitals: { useQuery: state.vitals },
    getVitalsBaseline: { useQuery: state.baseline },
  } },
}))
vi.mock('@/src/components/biometrics/SleepSummaryCard', () => ({
  SleepSummaryCard: ({ records }: { records: Array<{ side: string }> }) => (
    <div data-testid="sleep-summary">{records.map(r => r.side).join(',')}</div>
  ),
}))
vi.mock('@/src/components/SleepStages/SleepStagesCard', () => ({
  SleepStagesCard: ({ side }: { side: string }) => <div data-testid="stages">{side}</div>,
}))
vi.mock('@/src/components/MovementChart/MovementChart', () => ({ MovementChart: () => null }))
vi.mock('@/src/components/biometrics/VitalsGrid', () => ({ VitalsGrid: () => null }))
vi.mock('@/src/components/biometrics/RawDataButton', () => ({ RawDataButton: () => null }))
vi.mock('@/src/components/VitalsChart/VitalsChart', () => ({ VitalsChart: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
  state.singleSleeperSide = null
  state.primarySide = 'left'
  // Disabled queries can still expose cached data. The away side must not leak
  // into summaries even when that cache contains an older session.
  state.sleep.mockImplementation(({ side, limit }) => ({
    data: limit === 7 ? [{ id: side === 'left' ? 1 : 2, enteredBedAt: new Date('2026-09-25') }] : [],
  }))
  state.vitals.mockReturnValue({ data: [], isLoading: false })
  state.baseline.mockReturnValue({ data: undefined })
})
afterEach(cleanup)

describe('DataPage single-sleeper routing', () => {
  it.each(['left', 'right'] as const)('shows only the %s sleeper despite both-side controls and cached away data', (home) => {
    state.singleSleeperSide = home
    render(<DataPage />)
    const away = home === 'left' ? 'right' : 'left'
    expect(screen.getByTestId('sleep-summary').textContent).toBe(home)
    expect(screen.getAllByTestId('stages').map(el => el.textContent)).toEqual([home, home])
    expect(screen.queryByRole('button', { name: /tap to switch/ })).toBeNull()
    expect(state.sleep).toHaveBeenCalledWith(expect.objectContaining({ side: home, limit: 7 }), { enabled: true })
    expect(state.sleep).toHaveBeenCalledWith(expect.objectContaining({ side: away, limit: 7 }), { enabled: false })
    expect(state.sleep).toHaveBeenCalledWith(expect.objectContaining({ side: home, limit: 100 }))
    expect(state.baseline).toHaveBeenCalledWith({ side: home, days: 30 })
    expect(state.vitals).toHaveBeenCalledWith(expect.objectContaining({ side: home }))
    expect(state.vitals).toHaveBeenCalledWith(expect.objectContaining({ side: away }), { enabled: false })
  })

  it.each(['left', 'right'] as const)('keeps both summaries with %s selected when neither side is away', (side) => {
    state.primarySide = side
    const other = side === 'left' ? 'right' : 'left'
    render(<DataPage />)
    expect(screen.getAllByTestId('sleep-summary').map(el => el.textContent)).toEqual(['left', 'right'])
    expect(state.sleep).toHaveBeenCalledWith(expect.objectContaining({ side: 'left', limit: 7 }), { enabled: true })
    expect(state.sleep).toHaveBeenCalledWith(expect.objectContaining({ side: 'right', limit: 7 }), { enabled: true })
    expect(state.vitals).toHaveBeenCalledWith(expect.objectContaining({ side: other }), { enabled: true })
    fireEvent.click(screen.getByRole('button', { name: /tap to switch/ }))
    expect(state.selectSide).toHaveBeenCalledWith(other)
  })
})

describe('VitalsPanel side navigation', () => {
  it.each(['left', 'right'] as const)('switches from %s when shown outside the data page', (side) => {
    state.primarySide = side
    render(<VitalsPanel />)
    fireEvent.click(screen.getByRole('button', { name: side === 'left' ? 'leftL' : 'rightR' }))
    expect(state.selectSide).toHaveBeenCalledWith(side === 'left' ? 'right' : 'left')
  })

  it.each(['left', 'right'] as const)('hides side switching for the %s single sleeper', (home) => {
    state.singleSleeperSide = home
    render(<VitalsPanel />)
    expect(screen.queryByRole('button', { name: /^(leftL|rightR)$/ })).toBeNull()
    expect(state.baseline).toHaveBeenCalledWith({ side: home, days: 30 })
  })
})
