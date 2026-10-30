import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultComfortState } from '@/src/comfort/policy'
import { ComfortInputError } from '@/src/comfort/runtime'
import { PreviewReportError } from '@/src/comfort/report-summary'

const runtime = vi.hoisted(() => ({ status: vi.fn(), configure: vi.fn(), setMode: vi.fn(), feedback: vi.fn() }))
const owner = vi.hoisted(() => ({ status: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), retest: vi.fn() }))
const reports = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), review: vi.fn() }))
vi.mock('@/src/comfort/instance', () => ({ getComfortRuntime: () => runtime, getPreviewReports: () => reports, getComfortOwner: () => owner }))
const { comfortRouter } = await import('../comfort')
const caller = comfortRouter.createCaller({})

beforeEach(() => {
  vi.resetAllMocks()
  const result = {
    apiVersion: 1, generatedAt: 1, side: 'left', timezone: 'UTC', deviceDate: '2026-10-25', state: defaultComfortState(),
    history: [], evaluatedAt: null, decision: null, fault: null, runtime: 'stopped',
    activation: { available: false, reason: 'Hardware qualification and reviewed Preview nights are pending.' },
    features: { sensorAware: false, followBedtime: false },
  }
  runtime.status.mockReturnValue(result)
  runtime.configure.mockResolvedValue(result)
  runtime.setMode.mockResolvedValue(result)
  runtime.feedback.mockResolvedValue(result)
})

describe('personal comfort API contract', () => {
  it('accepts only server-issued owner review references and preserves gate failures', async () => {
    owner.prepare.mockRejectedValue(new PreviewReportError('Seven matching nights required', 'PRECONDITION_FAILED'))
    await expect(caller.prepareOwnerReview({ side: 'left', purpose: 'activation', kind: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(caller.confirmOwnerReview({ side: 'left', id: 'not-an-id', confirmed: true, note: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.prepareOwnerReview({ side: 'left', purpose: 'activation', kind: null, evidence: {} } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(owner.confirm).not.toHaveBeenCalled()
    expect(runtime.configure).not.toHaveBeenCalled()
  })
  it('accepts a mode-only change and rejects extra settings and Active before dispatch', async () => {
    await caller.mode({ side: 'right', mode: 'preview' })
    expect(runtime.setMode).toHaveBeenCalledWith('right', 'preview')
    await expect(caller.mode({ side: 'left', mode: 'active' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(caller.mode({ side: 'left', mode: 'off', config: {} } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(runtime.setMode).toHaveBeenCalledTimes(1)
    expect(runtime.configure).not.toHaveBeenCalled()
  })
  it('reads reports without starting the runtime and preserves actionable review conflicts', async () => {
    reports.list.mockResolvedValue({ apiVersion: 1, generatedAt: 1, side: 'left', items: [], targetNights: 7,
      ownerConfirmedNights: 0, activationAvailable: false })
    expect(await caller.reports({ side: 'left' })).toMatchObject({ items: [], activationAvailable: false })
    expect(runtime.status).not.toHaveBeenCalled()
    const input = { side: 'left' as const, id: 'a'.repeat(64), digest: 'b'.repeat(64), expectedReviewId: null,
      outcome: 'reviewed' as const, confirmedActualNight: true, note: '' }
    reports.review.mockRejectedValue(new PreviewReportError('Refresh the report', 'CONFLICT'))
    await expect(caller.reviewReport(input)).rejects.toMatchObject({ code: 'CONFLICT', message: 'Refresh the report' })
    reports.detail.mockRejectedValue(new PreviewReportError('No report for this side', 'NOT_FOUND'))
    await expect(caller.report({ side: 'right', id: input.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(caller.reviewReport({ ...input, confirmedActualNight: false })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.report({ side: 'left', id: '../source', afterId: -1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(reports.review).toHaveBeenCalledTimes(1)
    expect(runtime.configure).not.toHaveBeenCalled()
  })

  it('accepts explicit sensor-aware Preview without enabling Active', async () => {
    const config = { mode: 'preview' as const, minimumF: 70, maximumF: 95, sensorAware: true, followBedtime: true }
    await caller.configure({ side: 'left', config })
    expect(runtime.configure).toHaveBeenCalledWith('left', config)
  })

  it('reads status without starting or evaluating the service', async () => {
    expect(await caller.get({ side: 'left' })).toMatchObject({ runtime: 'stopped', activation: { available: false } })
    expect(runtime.configure).not.toHaveBeenCalled()
  })

  it('rejects activation and unsupported adapters before touching persisted state', async () => {
    await expect(caller.configure({ side: 'left', config: { mode: 'active', minimumF: 70, maximumF: 95 } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(caller.configure({ side: 'left', config: { mode: 'preview', minimumF: 70, maximumF: 95, followBedtime: true } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(runtime.configure).not.toHaveBeenCalled()
  })

  it('validates bounds and returns an actionable date error without treating storage failure as input', async () => {
    await expect(caller.configure({ side: 'left', config: { mode: 'preview', minimumF: 95, maximumF: 70 } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    runtime.feedback.mockRejectedValueOnce(new ComfortInputError('Future local date'))
    await expect(caller.feedback({ side: 'left', feedback: { date: '2026-10-26', comfort: 'warm' } })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Future local date' })
    runtime.feedback.mockRejectedValueOnce(new Error('Unavailable'))
    await expect(caller.feedback({ side: 'left', feedback: { date: '2026-10-25', comfort: 'warm' } })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })
})
