import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { responsePresentationFixture } from '@/src/comfort/tests/responsePresentationFixture'
import { TargetResponseEvaluation } from '../TargetResponseEvaluation'

const mock = vi.hoisted(() => ({ now: 1_800_000_000_000, unit: 'F', options: undefined as unknown,
  preview: { data: undefined as unknown, error: null as unknown, dataUpdatedAt: 1_800_000_000_000, isFetching: false, refetch: vi.fn() },
  train: { mutate: vi.fn(), isPending: false, error: null as unknown } }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { comfort: {
  targetResponsePreview: { useQuery: (_input: unknown, options: unknown) => {
    mock.options = options
    return mock.preview
  } },
  trainTargetResponseModel: { useMutation: () => mock.train },
} } }))
vi.mock('@/src/components/Schedule/CurveChart', () => ({ useNowMinute: () => mock.now / 60_000 }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: mock.unit,
  formatTemp: (celsius: number) => `${(mock.unit === 'C' ? celsius : celsius * 9 / 5 + 32).toFixed(1)}°${mock.unit}` }) }))
afterEach(cleanup)
beforeEach(() => {
  mock.now = 1_800_000_000_000
  mock.unit = 'F'
  Object.assign(mock.preview, { error: null, dataUpdatedAt: mock.now, isFetching: false,
    data: { apiVersion: 1, side: 'left', generatedAt: mock.now, activationAvailable: false, reason: 'Research only',
      candidates: [{ targetF: 69, reason: 'Comparable context', predictions: [15, 30].map(minutes => ({ minutes, waterF: 70, lowerF: 69.5, upperF: 70.5 })) },
        { targetF: 71, reason: 'No comparable warming observations.', predictions: [] }] } })
  Object.assign(mock.train, { isPending: false, error: null })
  vi.clearAllMocks()
})

it('fits only the explicitly reviewed dataset and never offers activation', () => {
  const status = responsePresentationFixture(mock.now)
  status.model = null
  render(<TargetResponseEvaluation status={status} onSaved={vi.fn()} />)
  expect(mock.train.mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Evaluate response model' }))
  expect(mock.train.mutate).toHaveBeenCalledWith({ side: 'left', expectedDatasetHash: status.datasetHash })
  expect(screen.queryByRole('button', { name: /apply|activate|enable/i })).toBeNull()
})

it('shows both evaluation horizons and only requests a preview on demand', () => {
  render(<TargetResponseEvaluation status={responsePresentationFixture(mock.now)} onSaved={vi.fn()} />)
  expect(mock.options).toMatchObject({ enabled: false, refetchOnWindowFocus: false })
  expect(screen.getByText('15 minutes · Passed comparison')).toBeTruthy()
  expect(screen.getByText('30 minutes · Passed comparison')).toBeTruthy()
  expect(screen.queryByText('If the target were 69.0°F')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Preview nearby targets' }))
  expect(mock.preview.refetch).toHaveBeenCalledOnce()
  expect(screen.getByText('If the target were 69.0°F')).toBeTruthy()
  expect(screen.getByText('No comparable warming observations.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Evaluate response model' })).toBeNull()
})

it.each(['error', 'fetching', 'expired', 'future', 'side', 'malformed', 'model', 'failed-test', 'fit-pending', 'fit-error'])(
  'withdraws a prediction when %s', (reason) => {
    const status = responsePresentationFixture(mock.now)
    const view = render(<TargetResponseEvaluation status={status} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview nearby targets' }))
    expect(screen.getByText('If the target were 69.0°F')).toBeTruthy()
    const payload = mock.preview.data as Record<string, unknown>
    if (reason === 'error') mock.preview.error = new Error('Offline')
    if (reason === 'fetching') mock.preview.isFetching = true
    if (reason === 'expired') mock.now += 150_001
    if (reason === 'future') payload.generatedAt = mock.now + 60_001
    if (reason === 'side') payload.side = 'right'
    if (reason === 'malformed') payload.activationAvailable = true
    if (reason === 'model' && status.model) status.model.current = false
    if (reason === 'failed-test' && status.model) status.model.horizons[0].validation.passes = false
    if (reason === 'fit-pending') mock.train.isPending = true
    if (reason === 'fit-error') mock.train.error = new Error('Changed')
    view.rerender(<TargetResponseEvaluation status={status} onSaved={vi.fn()} />)
    expect(screen.queryByText('If the target were 69.0°F')).toBeNull()
  })

it('formats absolute temperatures and error differences in the selected unit', () => {
  mock.unit = 'C'
  render(<TargetResponseEvaluation status={responsePresentationFixture(mock.now)} onSaved={vi.fn()} />)
  expect(screen.getAllByText('0.11°C')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Preview nearby targets' }))
  expect(screen.getByText('If the target were 20.6°C')).toBeTruthy()
  expect(screen.getByText('15 minutes: 21.1°C estimated water')).toBeTruthy()
})
