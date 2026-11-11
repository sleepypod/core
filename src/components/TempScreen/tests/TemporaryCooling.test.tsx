import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TemporaryCooling } from '../TemporaryCooling'
import type { CoolingPage } from '@/src/temperature/cooling'
import type { ControlReceipt, ControlRequest } from '@/src/controls/contract'

const mock = vi.hoisted(() => ({ now: 1_794_350_000_000, page: {} as CoolingPage, failed: false,
  submit: vi.fn<(request: ControlRequest) => Promise<ControlReceipt>>(), read: vi.fn(), refresh: vi.fn(), invalidate: vi.fn() }))
vi.mock('../TonightCard', () => ({ useNow: () => new Date(mock.now) }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  device: { getCooling: { useQuery: () => ({ data: mock.page, isError: mock.failed, isFetching: false, refetch: mock.refresh }) } },
  controls: { submit: { useMutation: () => ({ mutateAsync: mock.submit }) } },
  useUtils: () => ({ controls: { get: { fetch: mock.read } }, device: { getStatus: { invalidate: mock.invalidate } } }),
} }))
const receipt = (request: ControlRequest): ControlReceipt => ({ ...request, version: 1, receivedAt: request.issuedAt,
  finishedAt: request.issuedAt, lastDispatchAt: request.issuedAt, state: 'acknowledged', reason: null,
  dispatchCount: 1, physicalVerification: 'unverified', replayAllowed: false })
beforeEach(() => {
  vi.clearAllMocks()
  mock.now = 1_794_350_000_000
  mock.failed = false
  mock.page = { apiVersion: 1, side: 'left', generatedAt: mock.now, observedAt: mock.now,
    state: 'ready', reason: 'Preview the change.', physicalVerification: 'unverified', lease: null,
    proposal: { scope: 'a'.repeat(64), fromTargetF: 70, targetF: 68, expiresAt: mock.now + 20 * 60_000 } }
  mock.submit.mockImplementation(async request => receipt(request))
})
afterEach(cleanup)

it('reviews one physical zone and the original expiry before submitting once', async () => {
  const view = render(<TemporaryCooling side="left" name="Luca" timeZone="UTC" />)
  fireEvent.click(view.getByRole('button', { name: 'I’m too hot' }))
  expect(mock.submit).not.toHaveBeenCalled()
  expect(view.getByText(/Request 68°F instead of 70°F/)).toBeTruthy()
  expect(view.getByText(/Only this zone changes/)).toBeTruthy()
  const start = view.getByRole('button', { name: 'Start temporary cooling' })
  fireEvent.click(start)
  fireEvent.click(start)
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('Pod acknowledged'))
  expect(mock.submit).toHaveBeenCalledTimes(1)
  expect(mock.submit.mock.calls[0][0].action).toMatchObject({ kind: 'cooling.start', side: 'left', expectedTargetF: 70,
    expectedScope: mock.page.proposal?.scope, expectedExpiresAt: mock.page.proposal?.expiresAt })
})

it.each(['stale', 'future', 'failed', 'other-side'] as const)('withdraws %s readings instead of allowing cooling', (condition) => {
  if (condition === 'stale') mock.page.generatedAt -= 20_000
  if (condition === 'future') mock.page.generatedAt++
  if (condition === 'failed') mock.failed = true
  if (condition === 'other-side') mock.page.side = 'right'
  const view = render(<TemporaryCooling side="left" name="Luca" />)
  expect(view.getByRole('button', { name: 'I’m too hot' }).hasAttribute('disabled')).toBe(true)
  expect(mock.submit).not.toHaveBeenCalled()
})

it('invalidates a reviewed target when the controller reports a newer one', () => {
  const view = render(<TemporaryCooling side="left" name="Luca" />)
  fireEvent.click(view.getByRole('button', { name: 'I’m too hot' }))
  mock.page = { ...mock.page, proposal: { scope: 'a'.repeat(64), fromTargetF: 72, targetF: 70, expiresAt: mock.now + 20 * 60_000 } }
  view.rerender(<TemporaryCooling side="left" name="Luca" />)
  expect(view.getByRole('button', { name: 'Start temporary cooling' }).hasAttribute('disabled')).toBe(true)
  expect(view.getByRole('status').textContent).toContain('changed or expired')
})

it('reads the same lost request without resending and rejects a mismatched receipt', async () => {
  mock.submit.mockRejectedValueOnce(new Error('reply lost'))
  const view = render(<TemporaryCooling side="left" name="Luca" />)
  fireEvent.click(view.getByRole('button', { name: 'I’m too hot' }))
  fireEvent.click(view.getByRole('button', { name: 'Start temporary cooling' }))
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('response was lost'))
  const request = mock.submit.mock.calls[0][0]
  mock.read.mockResolvedValueOnce({ ...receipt(request), requestId: crypto.randomUUID() })
  fireEvent.click(view.getByRole('button', { name: 'Check last request' }))
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('receipt is unavailable'))
  expect(view.getByRole('button', { name: 'I’m too hot' }).hasAttribute('disabled')).toBe(true)
  mock.read.mockResolvedValueOnce(receipt(request))
  fireEvent.click(view.getByRole('button', { name: 'Check last request' }))
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('Pod acknowledged'))
  expect(mock.read).toHaveBeenLastCalledWith({ requestId: request.requestId })
  expect(mock.submit).toHaveBeenCalledTimes(1)
})

it('cancels only the displayed lease and uses the chosen units', async () => {
  const coolingId = crypto.randomUUID()
  mock.page = { ...mock.page, proposal: null, state: 'cooling', lease: { version: 1, id: coolingId, side: 'left', scope: 'a'.repeat(64),
    startedAt: mock.now, expiresAt: mock.now + 20 * 60_000, sessionEndsAt: mock.now + 60 * 60_000, fromTargetF: 70, targetF: 68, phase: 'active' } }
  const view = render(<TemporaryCooling side="left" name="Luca" unit="C" />)
  expect(view.getByText(/Requested 20°C/)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Cancel temporary cooling' }))
  await waitFor(() => expect(mock.submit).toHaveBeenCalledTimes(1))
  expect(mock.submit.mock.calls[0][0].action).toEqual({ kind: 'cooling.cancel', side: 'left', coolingId })
})

it('retires a pending left-side response when the owner changes to right', async () => {
  const gate = Promise.withResolvers<ControlReceipt>()
  mock.submit.mockReturnValueOnce(gate.promise)
  const view = render(<TemporaryCooling side="left" name="Luca" />)
  fireEvent.click(view.getByRole('button', { name: 'I’m too hot' }))
  fireEvent.click(view.getByRole('button', { name: 'Start temporary cooling' }))
  const request = mock.submit.mock.calls[0][0]
  mock.page = { ...mock.page, side: 'right' }
  view.rerender(<TemporaryCooling side="right" name="Marissa" />)
  await act(async () => {
    gate.resolve(receipt(request))
  })
  expect(view.queryByRole('status')).toBeNull()
  expect(view.queryByRole('button', { name: 'Check last request' })).toBeNull()
  expect(mock.submit).toHaveBeenCalledTimes(1)
})

it('keeps a lost cancellation receipt instead of issuing a second cancellation', async () => {
  const coolingId = crypto.randomUUID()
  mock.page = { ...mock.page, proposal: null, state: 'cooling', lease: { version: 1, id: coolingId, side: 'left', scope: 'a'.repeat(64),
    startedAt: mock.now, expiresAt: mock.now + 20 * 60_000, sessionEndsAt: mock.now + 60 * 60_000, fromTargetF: 70, targetF: 68, phase: 'active' } }
  mock.submit.mockRejectedValueOnce(new Error('cancel reply lost'))
  const view = render(<TemporaryCooling side="left" name="Luca" />)
  const cancel = view.getByRole('button', { name: 'Cancel temporary cooling' })
  fireEvent.click(cancel)
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('response was lost'))
  expect(cancel.hasAttribute('disabled')).toBe(true)
  fireEvent.click(cancel)
  const request = mock.submit.mock.calls[0][0]
  mock.read.mockResolvedValueOnce(receipt(request))
  fireEvent.click(view.getByRole('button', { name: 'Check last request' }))
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('Pod acknowledged'))
  expect(mock.submit).toHaveBeenCalledTimes(1)
  expect(mock.read).toHaveBeenCalledWith({ requestId: request.requestId })
})
