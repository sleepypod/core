import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LearningJourney } from '../LearningJourney'

const mock = vi.hoisted(() => ({
  now: 1_800_000_000_000,
  stage: { data: undefined as unknown, error: null as unknown, dataUpdatedAt: 1_800_000_000_000, isFetching: false, refetch: vi.fn() },
  thermal: { data: undefined as unknown, error: null as unknown, dataUpdatedAt: 1_800_000_000_000, isFetching: false, refetch: vi.fn() },
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  settings: { getAll: { useQuery: () => ({ data: { device: { temperatureUnit: 'F' } } }) } },
  sleepStages: { getModel: { useQuery: () => mock.stage } },
  comfort: { thermalModel: { useQuery: () => mock.thermal } },
} }))
vi.mock('@/src/components/Schedule/CurveChart', () => ({ useNowMinute: () => mock.now / 60_000 }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ sideName: (side: string) => side === 'left' ? 'Left' : 'Right' }) }))
afterEach(cleanup)
beforeEach(() => {
  mock.stage.data = { model: null, active: false }
  mock.stage.error = null
  mock.stage.dataUpdatedAt = mock.now
  mock.stage.isFetching = false
  mock.thermal.data = { side: 'right', generatedAt: mock.now, completeNights: 13, requiredNights: 20, canTrain: false, model: null }
  mock.thermal.error = null
  mock.thermal.dataUpdatedAt = mock.now
  mock.thermal.isFetching = false
  vi.clearAllMocks()
})

it('keeps phone baseline private and directs the selected temperature side to a reviewed workspace', () => {
  const side = vi.fn(), temperature = vi.fn()
  render(<LearningJourney side="right" onSideChange={side} lang="en" onTemperature={temperature} />)
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(screen.getByText('Private on your iPhone')).toBeTruthy()
  expect(screen.getByText('13 / 20 complete reviewed nights for fitting')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Model details · choose Right' }).getAttribute('href')).toContain('section=sleep-stages')
  fireEvent.click(screen.getByRole('button', { name: 'Review temperature learning' }))
  expect(temperature).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('tab', { name: 'Left' }))
  expect(side).toHaveBeenCalledWith('left')
})

it('withdraws previously cached progress on a read failure and refreshes both independent checks', () => {
  mock.stage.error = new Error('unavailable')
  mock.thermal.error = new Error('unavailable')
  render(<LearningJourney side="right" onSideChange={vi.fn()} lang="en" onTemperature={vi.fn()} />)
  expect(screen.getAllByText('Needs a current read')).toHaveLength(2)
  expect(screen.queryByRole('progressbar')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh model checks' }))
  expect(mock.stage.refetch).toHaveBeenCalledOnce()
  expect(mock.thermal.refetch).toHaveBeenCalledOnce()
})

it('refuses a response for the other side or one with old source timing', () => {
  const view = render(<LearningJourney side="left" onSideChange={vi.fn()} lang="en" onTemperature={vi.fn()} />)
  expect(screen.queryByRole('progressbar')).toBeNull()
  mock.thermal.data = { side: 'left', generatedAt: mock.now - 300_001, completeNights: 20, requiredNights: 20, canTrain: true, model: null }
  view.rerender(<LearningJourney side="left" onSideChange={vi.fn()} lang="en" onTemperature={vi.fn()} />)
  expect(screen.queryByText('Ready to review a fit')).toBeNull()
})
