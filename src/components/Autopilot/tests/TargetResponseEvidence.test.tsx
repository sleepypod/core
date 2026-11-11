import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TargetResponseEvidence } from '../TargetResponseEvidence'

const mock = vi.hoisted(() => ({ now: 1_800_000_000_000, options: undefined as unknown,
  query: { data: undefined as unknown, error: null as unknown, dataUpdatedAt: 1_800_000_000_000, isFetching: false, refetch: vi.fn() } }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { comfort: { targetResponseModel: { useQuery: (_input: unknown, options: unknown) => {
  mock.options = options
  return mock.query
} } } } }))
vi.mock('../TargetResponseEvaluation', () => ({ TargetResponseEvaluation: () => null }))
vi.mock('@/src/components/Schedule/CurveChart', () => ({ useNowMinute: () => mock.now / 60_000 }))
afterEach(cleanup)
beforeEach(() => {
  mock.now = 1_800_000_000_000
  mock.query.data = { apiVersion: 1, policy: 'acknowledged-small-step-v1', generatedAt: mock.now, side: 'left', attribution: 'physical_zone_only',
    status: 'read', reviewedNights: 12, responseNights: 9, coolingWindows: 8, warmingWindows: 4, requiredNights: 20,
    datasetHash: 'a'.repeat(64), modelAvailable: false, activationAvailable: false,
    exclusions: [{ date: '2026-11-09', count: 2, reason: 'Water readings have a gap.' }], exclusionsTruncated: false, reason: 'Collecting' }
  const evidence = mock.query.data
  mock.query.data = { apiVersion: 1, side: 'left', generatedAt: mock.now, completeNights: 9, requiredNights: 20,
    datasetHash: 'a'.repeat(64), canTrain: false, activationAvailable: false, reason: 'Collecting', model: null, evidence }
  mock.query.error = null
  mock.query.dataUpdatedAt = mock.now
  mock.query.isFetching = false
  vi.clearAllMocks()
})

it('requires an explicit read and explains counts without offering training or activation', () => {
  render(<TargetResponseEvidence side="left" />)
  expect(mock.options).toMatchObject({ enabled: false, refetchOnWindowFocus: false })
  expect(screen.queryByText('9 of 12')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Check recorded changes' }))
  expect(mock.query.refetch).toHaveBeenCalledOnce()
  expect(screen.getByText('9 of 12')).toBeTruthy()
  expect(screen.getByText('Water readings have a gap.')).toBeTruthy()
  expect(screen.getByText(/Do not change temperatures just to fill the count/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /train|activate/i })).toBeNull()
})

it.each(['error', 'fetching', 'expired', 'future', 'wrong-side', 'malformed', 'unavailable'])(
  'withdraws cached counts when %s', (failure) => {
    const view = render(<TargetResponseEvidence side="left" />)
    fireEvent.click(screen.getByRole('button', { name: 'Check recorded changes' }))
    expect(screen.getByText('9 of 12')).toBeTruthy()
    const data = mock.query.data as Record<string, unknown>
    if (failure === 'error') mock.query.error = new Error('Offline')
    if (failure === 'fetching') mock.query.isFetching = true
    if (failure === 'expired') mock.now += 300_001
    if (failure === 'future') data.generatedAt = mock.now + 60_001
    if (failure === 'wrong-side') data.side = 'right'
    if (failure === 'malformed') data.activationAvailable = true
    if (failure === 'unavailable') (data.evidence as Record<string, unknown>).status = 'unavailable'
    view.rerender(<TargetResponseEvidence side="left" />)
    expect(screen.queryByText('9 of 12')).toBeNull()
    if (failure === 'error') expect(screen.getByRole('alert').textContent).toContain('Reconnect')
    if (failure === 'fetching') expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  })

it('labels limited reads and milestones without implying a passing predictive model', () => {
  Object.assign((mock.query.data as { evidence: object }).evidence, { status: 'partial', responseNights: 20, reviewedNights: 25, exclusionsTruncated: true })
  Object.assign(mock.query.data as object, { completeNights: 20 })
  render(<TargetResponseEvidence side="left" />)
  fireEvent.click(screen.getByRole('button', { name: 'Check recorded changes' }))
  expect(screen.getByText(/Some records could not be inspected/)).toBeTruthy()
  expect(screen.getByText(/A separate model evaluation/)).toBeTruthy()
  expect(screen.getByText(/first 300 exclusion summaries/)).toBeTruthy()
})
