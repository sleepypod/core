import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PredictiveRecordingStatus } from '../PredictiveRecordingStatus'

const mock = vi.hoisted(() => ({ query: { data: undefined as unknown, error: null as unknown, isFetching: false, refetch: vi.fn() } }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { comfort: { predictiveRecordings: { useQuery: () => mock.query } } } }))
function result() {
  return { apiVersion: 1, side: 'left', generatedAt: Date.now(), mode: 'research_preview', activationAvailable: false,
    records: 3, sessions: 1, candidates: 1, holds: 1, withheld: 1, latestAt: Date.now() - 1000,
    collector: { running: true, fault: null }, reason: 'Production observations; no changes sent.',
    outcomeNotice: 'Unapplied targets have no observed outcome. These records do not establish comfort benefit.' }
}
beforeEach(() => {
  mock.query.data = result()
  mock.query.error = null
  mock.query.isFetching = false
  mock.query.refetch.mockReset().mockResolvedValue({})
})
afterEach(cleanup)
async function read() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check Preview recordings' }))
  })
}

it('shows explicitly read counts without describing proposals as applied improvements', async () => {
  render(<PredictiveRecordingStatus side="left" />)
  expect(screen.queryByText('3 comparisons · 1 routine sessions')).toBeNull()
  await read()
  expect(screen.getByText('3 comparisons · 1 routine sessions')).toBeTruthy()
  expect(screen.getByText(/Unapplied targets have no observed outcome/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Apply|Activate|Train/ })).toBeNull()
})
it.each(['wrong side', 'future', 'failed refresh', 'contradictory counts'] as const)('withdraws %s historical status', async (kind) => {
  const value = result()
  if (kind === 'wrong side') value.side = 'right'
  if (kind === 'future') value.generatedAt = Date.now() + 60_000
  if (kind === 'failed refresh') mock.query.error = new Error('Offline')
  if (kind === 'contradictory counts') value.records = 10
  mock.query.data = value
  render(<PredictiveRecordingStatus side="left" />)
  await read()
  expect(screen.queryByText('3 comparisons · 1 routine sessions')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('could not be verified')
})
