import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LaterAlarmPreview, NextAlarm } from '@/src/alarms/contract'
import { LaterWakeReview } from '../LaterWakeReview'

const mocks = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn(), saved: vi.fn(), uncertain: vi.fn(), close: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { nextAlarm: {
  previewLater: { useMutation: () => ({ mutateAsync: mocks.preview, isPending: false }) },
  applyLater: { useMutation: () => ({ mutateAsync: mocks.apply, isPending: false }) },
} } }))
vi.mock('@/src/hooks/useTimeFormatter', () => ({ useTimeFormatter: () => ({ formatTime: (time: string) => time }) }))
const now = Date.parse('2026-10-26T05:00:00Z')
const base: NextAlarm = {
  apiVersion: 1, side: 'left', timeZone: 'UTC', revision: 'a'.repeat(64), state: 'scheduled', canChange: true, reason: '',
  alarm: { at: '2026-10-26T07:00:00Z', originalAt: '2026-10-26T07:00:00Z', time: '07:00', scheduleIds: [1], source: 'routine', duration: 20, wakeWindow: 0, alarmTemperatureF: 105 },
  followingAt: '2026-10-27T07:00:00Z', execution: null, acknowledgment: 'accepted_not_physically_verified', change: null,
  warming: { startsAt: '2026-10-26T06:30:00Z', endsAt: '2026-10-26T07:15:20Z', earliestVibrationAt: '2026-10-26T07:00:00Z', targetF: 105 },
}
const preview: LaterAlarmPreview = {
  apiVersion: 1, effect: 'preview_only', generatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 90_000).toISOString(), before: base,
  proposed: { at: '2026-10-26T09:00:00Z', time: '09:00', duration: 20, wakeWindow: 0, targetF: 105,
    warmingStartsAt: '2026-10-26T08:30:00Z', earliestVibrationAt: '2026-10-26T09:00:00Z', warmingEndsAt: '2026-10-26T09:15:20Z', changeExpiresAt: '2026-10-26T09:15:20Z' },
  request: { side: 'left', expectedRevision: base.revision, expectedAt: base.alarm?.at, time: '09:00', action: 'time' },
  weeklyScheduleChanged: false, externalDevices: 'not_included',
}
const props = { base, current: base, now, unavailable: false, confirmedRefresh: 0, onSaved: mocks.saved, onUncertain: mocks.uncertain, onClose: mocks.close }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.preview.mockResolvedValue(preview)
  mocks.apply.mockResolvedValue({ ...base, schedulerUpdated: false })
})
afterEach(cleanup)
async function review() {
  fireEvent.change(screen.getByLabelText('Later wake time'), { target: { value: '09:00' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview later wake' }))
  await screen.findByRole('button', { name: 'Save this later wake' })
}
it('previews before writing and sends the exact displayed plan only after explicit save', async () => {
  render(<LaterWakeReview {...props} />)
  await review()
  expect(mocks.apply).not.toHaveBeenCalled()
  expect(mocks.preview).toHaveBeenCalledWith({ side: 'left', time: '09:00', expectedAt: base.alarm?.at, expectedRevision: base.revision })
  expect(screen.getByText('08:30 toward 105°F')).toBeTruthy()
  expect(screen.getByText('09:00 for 20 seconds')).toBeTruthy()
  expect(screen.getByText(/Phone alarms, lights, shades and audio are unchanged/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save this later wake' }))
  await waitFor(() => expect(mocks.saved).toHaveBeenCalledWith({ ...base, schedulerUpdated: false }))
  expect(mocks.apply).toHaveBeenCalledExactlyOnceWith({ preview })
})
it('discards a preview as soon as the selected time changes', async () => {
  render(<LaterWakeReview {...props} />)
  await review()
  fireEvent.change(screen.getByLabelText('Later wake time'), { target: { value: '10:00' } })
  expect(screen.queryByRole('button', { name: 'Save this later wake' })).toBeNull()
  expect(mocks.apply).not.toHaveBeenCalled()
})
it('requires a fresh review at expiry and blocks a concurrent schedule change', async () => {
  const view = render(<LaterWakeReview {...props} />)
  await review()
  view.rerender(<LaterWakeReview {...props} now={now + 90_000} />)
  expect(screen.getByRole('status').textContent).toContain('expired')
  expect(screen.queryByRole('button', { name: 'Save this later wake' })).toBeNull()
  view.rerender(<LaterWakeReview {...props} current={{ ...base, revision: 'b'.repeat(64) }} />)
  expect((screen.getByRole('button', { name: 'Save this later wake' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/saved alarm changed/)).toBeTruthy()
})
it('retains the chosen time and requires refresh after a lost save response', async () => {
  mocks.apply.mockRejectedValue(new Error('connection lost'))
  render(<LaterWakeReview {...props} />)
  await review()
  fireEvent.click(screen.getByRole('button', { name: 'Save this later wake' }))
  await waitFor(() => expect(mocks.uncertain).toHaveBeenCalledOnce())
  expect((screen.getByLabelText('Later wake time') as HTMLInputElement).value).toBe('09:00')
  expect(screen.getByText(/It may already have been saved/)).toBeTruthy()
  expect(mocks.saved).not.toHaveBeenCalled()
})
it('explains preview failure without saving or clearing the draft', async () => {
  mocks.preview.mockRejectedValue(Object.assign(new Error('Choose a later time on this alarm’s wake date.'), { data: { code: 'BAD_REQUEST' } }))
  render(<LaterWakeReview {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Preview later wake' }))
  expect(await screen.findByText('Choose a later time on this alarm’s wake date.')).toBeTruthy()
  const input = screen.getByLabelText('Later wake time')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id)
  expect(screen.getByRole('alert').textContent).toContain('Choose a later time')
  expect(mocks.apply).not.toHaveBeenCalled()
})
it('does not claim a changed alarm when the current read has only gone stale', async () => {
  const view = render(<LaterWakeReview {...props} />)
  await review()
  view.rerender(<LaterWakeReview {...props} current={undefined} unavailable now={now + 91_000} />)
  expect(screen.getByRole('alert').textContent).toContain('Use Refresh saved alarm below')
  expect(screen.queryByText(/saved alarm changed/)).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Preview expired')
  expect((screen.getByLabelText('Later wake time') as HTMLInputElement).value).toBe('09:00')
  expect((screen.getByRole('button', { name: 'Refresh preview' }) as HTMLButtonElement).disabled).toBe(true)
})
it.each(['original', 'proposed', 'other'] as const)('reconciles lost-save guidance after a successful refresh returns the %s plan', async (result) => {
  mocks.apply.mockRejectedValue(new Error('connection lost'))
  const view = render(<LaterWakeReview {...props} />)
  await review()
  fireEvent.click(screen.getByRole('button', { name: 'Save this later wake' }))
  await waitFor(() => expect(mocks.uncertain).toHaveBeenCalledOnce())
  view.rerender(<LaterWakeReview {...props} unavailable />)
  expect(screen.getByRole('alert').textContent).toContain('It may already have been saved')
  expect(screen.queryByText(/saved alarm is unavailable/)).toBeNull()
  const current = result === 'original' ? base : { ...base, revision: 'b'.repeat(64), alarm: base.alarm ? { ...base.alarm, time: result === 'proposed' ? '09:00' : '08:00' } : null }
  // Background data or a failed explicit refresh cannot clear uncertainty.
  view.rerender(<LaterWakeReview {...props} current={current} unavailable />)
  expect(screen.getByRole('alert').textContent).toContain('It may already have been saved')
  view.rerender(<LaterWakeReview {...props} current={current} confirmedRefresh={1} />)
  expect(screen.queryByText(/It may already have been saved/)).toBeNull()
  expect((screen.getByLabelText('Later wake time') as HTMLInputElement).value).toBe('09:00')
  const button = screen.getByRole('button', { name: 'Preview later wake' }) as HTMLButtonElement
  expect(button.disabled).toBe(result !== 'original')
  expect(screen.getByRole('alert').textContent).toBe(result === 'original' ? '' : 'The saved alarm changed. Close this review and check the latest wake plan.')
  expect(mocks.apply).toHaveBeenCalledTimes(1)
})
it('ignores a late apply receipt after leaving the reviewed side', async () => {
  let finish: ((value: NextAlarm & { schedulerUpdated: boolean }) => void) | undefined
  mocks.apply.mockImplementation(() => new Promise((resolve) => {
    finish = resolve
  }))
  const view = render(<LaterWakeReview {...props} />)
  await review()
  fireEvent.click(screen.getByRole('button', { name: 'Save this later wake' }))
  view.unmount()
  await act(async () => {
    finish?.({ ...base, schedulerUpdated: true })
  })
  expect(mocks.saved).not.toHaveBeenCalled()
})
