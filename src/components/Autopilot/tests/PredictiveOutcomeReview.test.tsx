import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PredictiveOutcomeReview } from '../PredictiveOutcomeReview'

const mock = vi.hoisted(() => ({ unit: 'F', query: { data: undefined as unknown, error: null as unknown, isFetching: false, refetch: vi.fn() } }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { comfort: { predictiveOutcomes: { useQuery: () => mock.query } } } }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: mock.unit, formatConverted: (value: number) => `${value.toFixed(1)}°${mock.unit}` }) }))
function result() {
  return { apiVersion: 1, side: 'left', generatedAt: Date.now(), purpose: 'prospective_water_accuracy', activationAvailable: false,
    considered: 5, pending: 1, withheld: 1, scored: 3,
    models: [{ artifactId: 'a'.repeat(64), datasetHash: 'b'.repeat(64), configuration: 'c'.repeat(64), latestAt: Date.now() - 86_400_000,
      comparisons: 3, reviewedNights: 2, horizons: [15, 30].map(minutes => ({ minutes, meanNightErrorF: 1.8,
        meanNightPersistenceErrorF: 3.6, meanNightRangeCoverage: 0.7 })) }],
    exclusions: [{ code: 'no_review', count: 1 }],
    notice: 'Only the unchanged target is scored. Unapplied alternatives have no measured outcome, and water accuracy is not evidence of better sleep.' }
}
beforeEach(() => {
  mock.unit = 'F'
  mock.query.data = result()
  mock.query.error = null
  mock.query.isFetching = false
  mock.query.refetch.mockReset().mockResolvedValue({})
})
afterEach(cleanup)
async function read() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check forecast accuracy' }))
  })
}
it('renders observed error with night counts and a baseline, without applying or claiming better sleep', async () => {
  render(<PredictiveOutcomeReview side="left" />)
  expect(screen.queryByText(/comparisons checked/)).toBeNull()
  await read()
  expect(screen.getByText('3 comparisons checked · 1 awaiting the end of the night · 1 excluded')).toBeTruthy()
  expect(screen.getByText('Forecast version 1 · 2 reviewed nights')).toBeTruthy()
  expect(screen.getAllByText('Forecast error: 1.8°F')).toHaveLength(2)
  expect(screen.getByText(/Unapplied alternatives have no measured outcome/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Apply|Activate|Train/ })).toBeNull()
})
it('converts error differences to Celsius without adding an absolute temperature offset', async () => {
  mock.unit = 'C'
  render(<PredictiveOutcomeReview side="left" />)
  await read()
  expect(screen.getAllByText('Forecast error: 1.0°C')).toHaveLength(2)
  expect(screen.getAllByText('If water had stayed the same: 2.0°C error')).toHaveLength(2)
})
it('requires a separate explicit read after changing sides, even when the new side is cached', async () => {
  const view = render(<PredictiveOutcomeReview side="left" />)
  await read()
  mock.query.data = { ...result(), side: 'right' }
  view.rerender(<PredictiveOutcomeReview side="right" />)
  expect(screen.queryByText(/comparisons checked/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Check forecast accuracy' })).toBeTruthy()
  await read()
  expect(screen.getByText(/comparisons checked/)).toBeTruthy()
})
it('withdraws cached results until the explicit refresh has completed', async () => {
  let finish: (() => void) | undefined
  mock.query.refetch.mockImplementation(() => new Promise<void>((resolve) => {
    finish = resolve
  }))
  render(<PredictiveOutcomeReview side="left" />)
  fireEvent.click(screen.getByRole('button', { name: 'Check forecast accuracy' }))
  expect(screen.queryByText(/comparisons checked/)).toBeNull()
  await act(async () => {
    finish?.()
  })
  expect(screen.getByText(/comparisons checked/)).toBeTruthy()
})
it.each(['side', 'future', 'counts', 'failure', 'loading'] as const)('withdraws %s results', async (kind) => {
  const value = result()
  if (kind === 'side') value.side = 'right'
  if (kind === 'future') value.generatedAt += 60_000
  if (kind === 'counts') value.scored++
  if (kind === 'failure') mock.query.error = new Error('Disconnected')
  mock.query.data = value
  const view = render(<PredictiveOutcomeReview side="left" />)
  await read()
  if (kind === 'loading') {
    mock.query.isFetching = true
    view.rerender(<PredictiveOutcomeReview side="left" />)
  }
  expect(screen.queryByText(/comparisons checked/)).toBeNull()
})
