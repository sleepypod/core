import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultComfortState } from '@/src/comfort/policy'
import { ComfortInputError } from '@/src/comfort/runtime'
import { PreviewReportError } from '@/src/comfort/report-summary'

const runtime = vi.hoisted(() => ({ status: vi.fn(), configure: vi.fn(), setMode: vi.fn(), feedback: vi.fn() }))
const owner = vi.hoisted(() => ({ status: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), retest: vi.fn() }))
const targetResponse = vi.hoisted(() => vi.fn())
const responseModels = vi.hoisted(() => ({ status: vi.fn(), train: vi.fn() }))
const responsePreview = vi.hoisted(() => vi.fn())
const predictivePreview = vi.hoisted(() => vi.fn())
const predictiveRecordings = vi.hoisted(() => vi.fn())
const predictiveOutcomes = vi.hoisted(() => vi.fn())
const reports = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), review: vi.fn() }))
vi.mock('@/src/comfort/instance', () => ({ getComfortRuntime: () => runtime, getPreviewReports: () => reports, getComfortOwner: () => owner,
  getTargetResponseAudit: targetResponse, getTargetResponseModels: () => responseModels, previewTargetResponse: responsePreview,
  previewPredictiveControl: predictivePreview, getPredictiveRecordingStatus: predictiveRecordings, getPredictiveOutcomes: predictiveOutcomes }))
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
  it('only accepts a side when reading prospective outcomes and never accepts client scores or activation', async () => {
    const result = { apiVersion: 1, side: 'left', generatedAt: 1, purpose: 'prospective_water_accuracy',
      activationAvailable: false, considered: 0, pending: 0, withheld: 0, scored: 0, models: [], exclusions: [],
      notice: 'Only the unchanged target is scored. Unapplied alternatives have no measured outcome, and water accuracy is not evidence of better sleep.' }
    predictiveOutcomes.mockResolvedValue(result)
    expect(await caller.predictiveOutcomes({ side: 'left' })).toEqual(result)
    await expect(caller.predictiveOutcomes({ side: 'left', score: 0, activate: true } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(predictiveOutcomes).toHaveBeenCalledExactlyOnceWith('left')
    expect(runtime.configure).not.toHaveBeenCalled()
  })
  it('reads historical Preview counts without accepting records or enabling collection', async () => {
    const result = { apiVersion: 1, side: 'left', generatedAt: 1, mode: 'research_preview', activationAvailable: false,
      records: 0, sessions: 0, candidates: 0, holds: 0, withheld: 0, latestAt: null, reason: 'Waiting',
      outcomeNotice: 'Unapplied targets have no observed outcome. These records do not establish comfort benefit.' }
    predictiveRecordings.mockReturnValue(result)
    expect(await caller.predictiveRecordings({ side: 'left' })).toEqual(result)
    await expect(caller.predictiveRecordings({ side: 'left', record: {}, activate: true } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(predictiveRecordings).toHaveBeenCalledExactlyOnceWith('left')
    expect(runtime.configure).not.toHaveBeenCalled()
  })
  it('reads predictive research without accepting client targets or starting controls', async () => {
    const result = { apiVersion: 1, policy: 'bounded-water-tracking-v1', side: 'left', generatedAt: 1,
      mode: 'research_preview', activationAvailable: false, objective: 'bounded-routine-water-target', disposition: 'withheld',
      currentTargetF: null, desiredWaterF: null, proposedTargetF: null, expiresAt: null,
      minimumF: null, maximumF: null, comparisons: [], reason: 'Fresh readings required' }
    predictivePreview.mockReturnValue(result)
    expect(await caller.predictiveTargetPreview({ side: 'left' })).toEqual(result)
    await expect(caller.predictiveTargetPreview({ side: 'left', targetF: 69, activate: true } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(predictivePreview).toHaveBeenCalledExactlyOnceWith('left')
    expect(runtime.status).not.toHaveBeenCalled()
    expect(runtime.configure).not.toHaveBeenCalled()
  })
  it('exposes inert response-model status and preserves explicit fit conflicts', async () => {
    const status = { apiVersion: 1, side: 'left', generatedAt: 1, completeNights: 0, requiredNights: 20,
      datasetHash: 'a'.repeat(64), canTrain: false, activationAvailable: false, reason: 'Collecting', model: null,
      evidence: { apiVersion: 1, policy: 'acknowledged-small-step-v1', generatedAt: 1, side: 'left', attribution: 'physical_zone_only',
        status: 'read', reviewedNights: 0, responseNights: 0, coolingWindows: 0, warmingWindows: 0, requiredNights: 20,
        datasetHash: 'a'.repeat(64), modelAvailable: false, activationAvailable: false, exclusions: [], exclusionsTruncated: false, reason: 'Collecting' } }
    responseModels.status.mockReturnValue(status)
    expect(await caller.targetResponseModel({ side: 'left' })).toEqual(status)
    responseModels.train.mockRejectedValue(new PreviewReportError('Recordings changed', 'CONFLICT'))
    await expect(caller.trainTargetResponseModel({ side: 'left', expectedDatasetHash: status.datasetHash })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(responseModels.train).toHaveBeenCalledWith('left', status.datasetHash)
    await expect(caller.trainTargetResponseModel({ side: 'left', expectedDatasetHash: status.datasetHash, activate: true } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.trainTargetResponseModel({ side: 'left', expectedDatasetHash: 'old' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(responseModels.train).toHaveBeenCalledTimes(1)
    expect(runtime.configure).not.toHaveBeenCalled()
  })
  it('reads response candidates only from the server and rejects caller-supplied measurements', async () => {
    const result = { apiVersion: 1, side: 'right', generatedAt: 1, activationAvailable: false, candidates: [], reason: 'No fresh observations' }
    responsePreview.mockReturnValue(result)
    expect(await caller.targetResponsePreview({ side: 'right' })).toEqual(result)
    await expect(caller.targetResponsePreview({ side: 'left', input: { waterF: 70 }, targetF: 69 } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(responsePreview).toHaveBeenCalledTimes(1)
    expect(responsePreview).toHaveBeenCalledWith('right')
    expect(runtime.status).not.toHaveBeenCalled()
    expect(runtime.configure).not.toHaveBeenCalled()
  })
  it('reads target response evidence without evaluating the controller and rejects extra input', async () => {
    const result = { apiVersion: 1, policy: 'acknowledged-small-step-v1', generatedAt: 1, side: 'right', attribution: 'physical_zone_only',
      status: 'read', reviewedNights: 0, responseNights: 0, coolingWindows: 0, warmingWindows: 0, requiredNights: 20,
      datasetHash: '0'.repeat(64), modelAvailable: false, activationAvailable: false, exclusions: [], exclusionsTruncated: false, reason: 'No observations' }
    targetResponse.mockReturnValue(result)
    expect(await caller.targetResponse({ side: 'right' })).toEqual(result)
    expect(targetResponse).toHaveBeenCalledWith('right')
    await expect(caller.targetResponse({ side: 'left', activate: true } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.targetResponse({ side: 'middle' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(targetResponse).toHaveBeenCalledTimes(1)
    expect(runtime.status).not.toHaveBeenCalled()
    expect(runtime.configure).not.toHaveBeenCalled()
  })
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
