import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PredictiveCollector } from '../predictive-collector'
import { predictiveRecordingFixture } from './predictiveRecordingFixture'
import { predictiveContentHash } from '../predictive-recording-store'
import type { PredictiveRecording, PredictiveWorkerRequest, PredictiveWorkerResult } from '../predictive-recording-contract'

const now = 1_800_000_000_000
const collectors: PredictiveCollector[] = []
beforeEach(() => vi.useFakeTimers().setSystemTime(now))
afterEach(async () => {
  for (const collector of collectors.splice(0)) await collector.stop()
  vi.useRealTimers()
})
function fixture() {
  const initial = predictiveRecordingFixture(now)
  const deps = {
    now: Date.now, capture: vi.fn((side: string) => side === 'left' ? structuredClone(initial.observation) : null),
    evaluate: vi.fn<(request: PredictiveWorkerRequest, signal: AbortSignal) => Promise<PredictiveWorkerResult>>(async () => initial.forecasts),
    save: vi.fn<(record: PredictiveRecording, now: number) => void>(), prune: vi.fn(),
  }
  const collector = new PredictiveCollector(deps)
  collectors.push(collector)
  return { collector, deps, initial }
}
async function finishTick() {
  await vi.advanceTimersByTimeAsync(1)
}

describe('isolated prospective collection', () => {
  it('records once per interval without needing a viewer or any command dependency', async () => {
    const { collector, deps } = fixture()
    expect(collector.status()).toEqual({ running: false, fault: null })
    collector.start()
    collector.start()
    await finishTick()
    expect(deps.save).toHaveBeenCalledTimes(1)
    expect(deps.save.mock.calls[0][0]).toMatchObject({ applied: false, attribution: 'physical_zone_only', selection: { disposition: 'candidate' } })
    await vi.advanceTimersByTimeAsync(240_000)
    expect(deps.evaluate).toHaveBeenCalledTimes(1)
    expect(deps.prune).toHaveBeenCalledTimes(1)
  })
  it.each(['off', 'active'] as const)('does not run model reads in %s mode', async (mode) => {
    const { collector, deps, initial } = fixture()
    initial.observation.state.config.mode = mode
    collector.start()
    await finishTick()
    expect(deps.evaluate).not.toHaveBeenCalled()
    expect(deps.save).not.toHaveBeenCalled()
  })
  it.each(['expired', 'state', 'configuration', 'session', 'manual', 'source hash', 'target', 'future'] as const)('withdraws a pending comparison after %s changes', async (change) => {
    const { collector, deps, initial } = fixture()
    deps.evaluate.mockImplementation(async () => {
      if (change === 'expired') vi.setSystemTime(now + 15_000)
      if (change === 'future') vi.setSystemTime(now - 1)
      if (change === 'state') initial.observation.state.config.maximumF++
      if (change === 'configuration') initial.observation.request.configuration = 'f'.repeat(64)
      if (change === 'session') initial.observation.evidence.session = 'another-night'
      if (change === 'manual') initial.observation.context.owner = 'manual'
      if (change === 'target') initial.observation.request.input.targetF++
      if (change === 'source hash') initial.forecasts.requestHash = 'f'.repeat(64)
      return initial.forecasts
    })
    collector.start()
    await finishTick()
    expect(deps.save).not.toHaveBeenCalled()
  })
  it('cancels the child and does not save late results during shutdown', async () => {
    const { collector, deps, initial } = fixture()
    deps.evaluate.mockImplementation((_request, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(initial.forecasts), { once: true })
    }))
    collector.start()
    await finishTick()
    await collector.stop()
    expect(deps.save).not.toHaveBeenCalled()
    expect(collector.status().running).toBe(false)
  })
  it('isolates a worker failure and permits a later fresh comparison', async () => {
    const { collector, deps } = fixture()
    deps.evaluate.mockRejectedValueOnce(new Error('Unreadable history'))
    collector.start()
    await finishTick()
    expect(collector.status().fault).toContain('unaffected')
    deps.capture.mockImplementation(side => side === 'left' ? predictiveRecordingFixture(Date.now()).observation : null)
    deps.evaluate.mockImplementation(async request => ({ ...predictiveRecordingFixture(request.at).forecasts, requestHash: predictiveContentHash(request) }))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(deps.save).toHaveBeenCalledTimes(1)
    expect(collector.status().fault).toBeNull()
  })
})
