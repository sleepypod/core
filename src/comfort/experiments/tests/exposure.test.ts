import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { collectExperimentExposure, experimentRequestId, type ExperimentSample } from '../exposure'
import { fixturePlan } from './fixture'

function fixture() {
  const plan = fixturePlan(), start = Date.parse('2026-11-13T22:00:00Z'), end = start + 60_000
  const window = { start, end, wakeStartsAt: end + 30_000, recordedAt: end + 1000, execution: 'active' as const }
  const sample = (offset: number): ExperimentSample => ({ at: start + offset,
    deviceAt: start + offset, presenceAt: start + offset, targetF: 70, powered: true, occupied: true,
    waterAdequate: true, priming: false, vibrating: false, baseMoving: false,
    bindingHash: plan.context.bindingHash, routineHash: plan.context.routineHash, wakeHash: plan.context.wakeHash,
    selectedRequestId: experimentRequestId(plan, '2026-11-13'), attributionAmbiguous: false })
  return { plan, start, end, window, sample }
}

describe('experiment exposure interval collection', () => {
  it('counts the intersection of fresh occupied readings and the assigned selected target', () => {
    const { plan, window, sample } = fixture()
    const samples = [sample(0), sample(10_000), sample(20_000), sample(30_000), sample(40_000), sample(50_000)]
    const result = collectExperimentExposure(plan, window, samples, [])
    expect(result).toMatchObject({ observedMs: 60_000, matchedTargetMs: 60_000, occupiedMs: 60_000, qualifiedMs: 60_000 })
    expect(collectExperimentExposure(plan, window, samples, []).sourceHash).toBe(result.sourceHash)
  })

  it('never fills a gap with a single or repeatedly replayed source reading', () => {
    const { plan, window, sample, start } = fixture()
    expect(collectExperimentExposure(plan, window, [sample(0)], []).qualifiedMs).toBe(15_000)
    const repeated = [sample(0), { ...sample(10_000), deviceAt: start }, { ...sample(20_000), deviceAt: start }]
    expect(collectExperimentExposure(plan, window, repeated, []).qualifiedMs).toBe(15_000)
  })

  it('expires presence separately and never assumes an empty bed is identified', () => {
    const { plan, window, sample, start } = fixture()
    const samples = [{ ...sample(0), presenceAt: start - 85_000 }, { ...sample(10_000), occupied: null }]
    const result = collectExperimentExposure(plan, window, samples, [])
    expect(result.observedMs).toBe(25_000)
    expect(result.qualifiedMs).toBe(5000)
  })

  it.each([
    { selectedRequestId: 'schedule:left' }, { selectedRequestId: null }, { powered: false },
    { waterAdequate: null }, { priming: true }, { vibrating: true }, { baseMoving: true },
    { baseMoving: null }, { attributionAmbiguous: true }, { targetF: 71 },
  ])('does not credit merely matching temperatures or unsafe samples (%j)', (patch) => {
    const { plan, window, sample } = fixture()
    const result = collectExperimentExposure(plan, window, [{ ...sample(0), ...patch }], [])
    expect(result.qualifiedMs).toBe(0)
  })

  it('retains a transient assignment change even when later samples restore it', () => {
    const { plan, window, sample } = fixture()
    const result = collectExperimentExposure(plan, window, [sample(0), { ...sample(10_000), bindingHash: 'f'.repeat(64) }, sample(20_000)], [])
    expect(result.bindingHash).not.toBe(plan.context.bindingHash)
    expect(result.qualifiedMs).toBe(25_000)
  })

  it('does not double-count a command receipt and rejects reused event identifiers', () => {
    const { plan, window, sample, start } = fixture()
    const event = { id: randomUUID(), at: start, kind: 'manual_change' as const }
    const result = collectExperimentExposure(plan, window, [sample(0)], [event, event])
    expect(result.manualChanges).toBe(1)
    expect(() => collectExperimentExposure(plan, window, [sample(0)], [event, { ...event, at: start + 1 }])).toThrow('reused')
  })

  it('excludes events outside the treatment window but rejects future event clocks', () => {
    const { plan, window, sample, start, end } = fixture()
    const event = { id: randomUUID(), at: start - 1, kind: 'manual_change' as const }
    expect(collectExperimentExposure(plan, window, [sample(0)], [event, { ...event, at: end }]).manualChanges).toBe(0)
    expect(() => collectExperimentExposure(plan, window, [sample(0)], [{ ...event, at: window.recordedAt + 1 }])).toThrow('future')
  })

  it('rejects duplicate, out-of-order and future source sample clocks', () => {
    const { plan, window, sample, start } = fixture()
    expect(() => collectExperimentExposure(plan, window, [sample(0), sample(0)], [])).toThrow('ordered')
    expect(() => collectExperimentExposure(plan, window, [sample(1000), sample(0)], [])).toThrow('ordered')
    expect(() => collectExperimentExposure(plan, window, [{ ...sample(0), deviceAt: start + 1 }], [])).toThrow('nonfuture')
    expect(() => collectExperimentExposure(plan, window, [{ ...sample(0), presenceAt: start + 1 }], [])).toThrow('nonfuture')
  })

  it('accepts actual DST-sized windows without inventing fixed eight-hour observations', () => {
    const { plan, window, sample } = fixture()
    const longer = { ...window, end: window.end + 3_600_000, recordedAt: window.recordedAt + 3_600_000 }
    const result = collectExperimentExposure(plan, longer, [sample(0)], [])
    expect(result.windowEnd - result.windowStart).toBe(3_660_000)
    expect(result.observedMs).toBe(15_000)
  })

  it('keeps Preview explicit and rejects unfinished or unassigned windows', () => {
    const { plan, window, sample } = fixture()
    expect(collectExperimentExposure(plan, { ...window, execution: 'preview' }, [sample(0)], []).execution).toBe('preview')
    expect(() => collectExperimentExposure(plan, { ...window, recordedAt: window.end - 1 }, [], [])).toThrow()
    const later = 30 * 86_400_000
    expect(() => collectExperimentExposure(plan, { ...window, start: window.start + later, end: window.end + later,
      recordedAt: window.recordedAt + later }, [], [])).toThrow('assigned')
  })
})
