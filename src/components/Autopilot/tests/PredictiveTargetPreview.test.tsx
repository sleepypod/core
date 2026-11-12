import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { previewPredictiveTarget } from '@/src/comfort/predictive-policy'
import { predictiveFixture } from '@/src/comfort/tests/predictiveFixture'
import { PredictiveTargetPreview } from '../PredictiveTargetPreview'

const mock = vi.hoisted(() => ({ options: undefined as unknown,
  query: { data: undefined as unknown, error: null as unknown, isFetching: false, dataUpdatedAt: 1_800_000_000_000, refetch: vi.fn() } }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { comfort: { predictiveTargetPreview: {
  useQuery: (_input: unknown, options: unknown) => {
    mock.options = options
    return mock.query
  },
} } } }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ formatTemp: (celsius: number) => `${Math.round(celsius * 9 / 5 + 32)}°F` }) }))

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(1_800_000_000_000)
  mock.query.data = previewPredictiveTarget(predictiveFixture(Date.now()))
  mock.query.error = null
  mock.query.isFetching = false
  mock.query.refetch.mockReset().mockResolvedValue({})
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function requestComparison() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Compare with holding' }))
  })
}

it('requires an explicit read and explains a research choice without an apply control', async () => {
  render(<PredictiveTargetPreview side="left" />)
  expect(mock.options).toMatchObject({ enabled: false, retry: false, refetchOnWindowFocus: false })
  expect(screen.queryByText('69°F is an experiment candidate')).toBeNull()
  await requestComparison()
  expect(screen.getByText('69°F is an experiment candidate')).toBeTruthy()
  expect(screen.getByText(/No adjustment was sent/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Apply|Activate/ })).toBeNull()
  expect(mock.query.refetch).toHaveBeenCalledTimes(1)
})

it('withdraws the comparison at its source expiry without sending another request', async () => {
  render(<PredictiveTargetPreview side="left" />)
  await requestComparison()
  act(() => {
    vi.advanceTimersByTime(15_001)
  })
  expect(screen.queryByText('69°F is an experiment candidate')).toBeNull()
  expect(screen.getByText(/comparison has expired/)).toBeTruthy()
  expect(mock.query.refetch).toHaveBeenCalledTimes(1)
})

it.each(['side', 'future', 'malformed', 'read-failure', 'refreshing'])('withdraws cached output for %s', async (failure) => {
  const view = render(<PredictiveTargetPreview side="left" />)
  await requestComparison()
  const result = previewPredictiveTarget(predictiveFixture(Date.now()))
  if (failure === 'side') result.side = 'right'
  if (failure === 'future') result.generatedAt += 10_000
  if (failure === 'malformed') result.proposedTargetF = 60
  if (failure === 'read-failure') mock.query.error = new Error('Offline')
  if (failure === 'refreshing') mock.query.isFetching = true
  mock.query.data = result
  view.rerender(<PredictiveTargetPreview side="left" />)
  expect(screen.queryByText('69°F is an experiment candidate')).toBeNull()
})

it('keeps a withholding reason distinct from a successful hold decision', async () => {
  const input = predictiveFixture()
  input.context.device.waterAdequate = null
  mock.query.data = previewPredictiveTarget(input)
  render(<PredictiveTargetPreview side="left" />)
  await requestComparison()
  expect(screen.getByText('A comparison is not ready yet')).toBeTruthy()
  expect(screen.getByText(/confirmed adequate water level/)).toBeTruthy()
  expect(screen.queryByText(/Tracking objective/)).toBeNull()
})
