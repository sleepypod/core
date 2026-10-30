import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OwnerIdentity, OwnerReview } from '@/src/comfort/owner-contract'
import { ComfortOwnerReview } from '../ComfortOwnerReview'

const api = vi.hoisted(() => ({ data: {} as unknown, review: {} as unknown, prepare: vi.fn(), confirm: vi.fn(), invalidate: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ comfort: { owner: { invalidate: api.invalidate }, get: { invalidate: api.invalidate } } }),
  comfort: {
    owner: { useQuery: () => ({ data: api.data, error: null, isLoading: false, isFetching: false, refetch: vi.fn() }) },
    prepareOwnerReview: { useMutation: (options: { onSuccess(value: unknown): void }) => ({ isPending: false, error: null,
      mutate: (value: unknown) => {
        api.prepare(value)
        options.onSuccess(api.review)
      } }) },
    confirmOwnerReview: { useMutation: () => ({ isPending: false, isSuccess: false, error: null, mutate: api.confirm, reset: vi.fn() }) },
    retestQualification: { useMutation: () => ({ isPending: false, error: null, mutate: vi.fn(), reset: vi.fn() }) },
  },
} }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers().setSystemTime(new Date('2026-11-05T18:00:00Z'))
  const identity: OwnerIdentity = { hardware: 'd'.repeat(64), calibration: 'c'.repeat(64), schedule: 'b'.repeat(64), build: 'a'.repeat(40),
    policy: { minimumF: 70, maximumF: 95, sensorAware: false, followBedtime: false } }
  api.data = { identity, qualifications: [], nights: [], reasons: ['Seven nights required'], active: false, canActivate: false, application: null }
  api.review = {
    id: 'd930f1d9-42aa-421c-84f0-96ec3a7fc4d5', side: 'left', purpose: 'qualification', kind: 'presence_empty', at: Date.now(), expiresAt: Date.now() + 60_000,
    snapshot: { identity, qualifications: [], nights: [], application: null,
      evidence: { identity, observedAt: Date.now(), presenceAt: Date.now(), presence: 'empty', powered: false, offConfirmed: false,
        targetF: 75, applicationId: null, applicationAt: null, alarmAt: null, pausedUntil: 0 } },
  } satisfies OwnerReview
})
afterEach(() => vi.useRealTimers())

it('shows machine evidence separately and submits only the prepared reference plus an explicit owner observation', () => {
  render(<ComfortOwnerReview side="left" />)
  expect((screen.getByRole('button', { name: 'Review activation' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Inspect check evidence' }))
  expect(api.prepare).toHaveBeenCalledWith({ side: 'left', purpose: 'qualification', kind: 'presence_empty' })
  expect(screen.getByText(/Power state unavailable/)).toBeTruthy()
  const confirm = screen.getByRole('button', { name: 'Confirm attended check' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Observation or note (optional)'), { target: { value: 'This side was empty.' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /I attended this check/ }))
  expect(confirm.disabled).toBe(false)
  fireEvent.click(confirm)
  expect(api.confirm).toHaveBeenCalledWith({ side: 'left', id: (api.review as OwnerReview).id, confirmed: true, note: 'This side was empty.' })
})

it('expires a prepared review and resets its physical confirmation when preparing another', () => {
  render(<ComfortOwnerReview side="left" />)
  fireEvent.click(screen.getByRole('button', { name: 'Inspect check evidence' }))
  fireEvent.click(screen.getByRole('checkbox', { name: /I attended this check/ }))
  act(() => vi.advanceTimersByTime(60_000))
  expect(screen.getByText(/Review expired/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Confirm attended check' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  api.review = { ...(api.review as OwnerReview), at: Date.now(), expiresAt: Date.now() + 60_000 }
  fireEvent.click(screen.getByRole('button', { name: 'Inspect check evidence' }))
  expect((screen.getByRole('checkbox', { name: /I attended this check/ }) as HTMLInputElement).checked).toBe(false)
})
