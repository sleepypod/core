import { randomUUID } from 'node:crypto'
import type { Side } from '@/src/hardware/types'
import type { ComfortContext, ComfortState } from './policy'
import type { PreviewEvidence } from './report-contract'
import { previewPredictiveTarget } from './predictive-policy'
import { predictiveContentHash } from './predictive-recording-store'
import { PREDICTIVE_RECORDING_INTERVAL_MS, predictiveRecordingSchema, predictiveWorkerResultSchema,
  type PredictiveRecording, type PredictiveWorkerRequest, type PredictiveWorkerResult } from './predictive-recording-contract'

export interface PredictiveObservation {
  request: PredictiveWorkerRequest
  evidence: PreviewEvidence
  state: ComfortState
  context: ComfortContext
}
interface Dependencies {
  now(): number
  capture(side: Side): PredictiveObservation | null
  evaluate(input: PredictiveWorkerRequest, signal: AbortSignal): Promise<PredictiveWorkerResult>
  save(record: PredictiveRecording, now: number): void
  prune(now: number): void
}

/** One child at a time; cancellation and newer settings discard results without affecting control. */
export class PredictiveCollector {
  private readonly runId = randomUUID()
  private readonly attempts: Partial<Record<Side, number>> = {}
  private active: AbortController | null = null
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  private running = false
  private failure: string | null = null
  private prunedAt: number | null = null
  constructor(private readonly deps: Dependencies) {}

  status() { return { running: this.running, fault: this.failure } }

  async tick(): Promise<void> {
    if (!this.running || this.pending) return
    this.pending = (async () => {
      for (const side of ['left', 'right'] as const) {
        if (!this.running) break
        const now = this.deps.now(), previous = this.attempts[side]
        if (previous !== undefined && now >= previous && now - previous < PREDICTIVE_RECORDING_INTERVAL_MS) continue
        this.attempts[side] = now
        try {
          const before = this.deps.capture(side)
          if (!before || before.state.config.mode !== 'preview') continue
          const abort = new AbortController()
          this.active = abort
          const forecasts = predictiveWorkerResultSchema.parse(await this.deps.evaluate(before.request, abort.signal))
          if (!this.running || abort.signal.aborted || forecasts.requestHash !== predictiveContentHash(before.request)) continue
          const after = this.deps.capture(side), completedAt = this.deps.now()
          if (!after || after.request.configuration !== before.request.configuration
            || after.evidence.session !== before.evidence.session || after.evidence.scheduleRevision !== before.evidence.scheduleRevision
            || JSON.stringify(after.state) !== JSON.stringify(before.state)
            || after.request.input.targetF !== before.request.input.targetF || completedAt < before.request.at
            || completedAt - before.request.observedAt >= 15_000) continue
          // Predictions are anchored to the first measurement, not to a newly observed temperature.
          const selection = previewPredictiveTarget({ side, state: before.state, context: { ...before.context, now: completedAt },
            hold: forecasts.hold, steps: forecasts.steps })
          const latestGuard = previewPredictiveTarget({ side, state: after.state, context: { ...after.context, now: completedAt },
            hold: forecasts.hold, steps: forecasts.steps })
          if (selection.disposition !== 'withheld' && latestGuard.disposition === 'withheld') continue
          this.deps.save(predictiveRecordingSchema.parse({ version: 1, id: randomUUID(), runId: this.runId, recordedAt: completedAt,
            source: { ...before.evidence, runId: this.runId }, request: before.request, forecasts, selection, attribution: 'physical_zone_only', applied: false }), completedAt)
          this.failure = null
        }
        catch { this.failure = 'Prospective collection could not verify or save a comparison. Bed controls are unaffected.' }
        finally { this.active = null }
      }
      const now = this.deps.now()
      if (this.prunedAt === null || now < this.prunedAt || now - this.prunedAt >= 3_600_000) {
        try {
          this.deps.prune(now)
          this.prunedAt = now
        }
        catch { this.failure = 'Prospective retention could not be checked. Bed controls are unaffected.' }
      }
    })().finally(() => { this.pending = undefined })
    await this.pending
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      void this.tick()
    }, 15_000)
    this.timer.unref()
    void this.tick()
  }

  async stop(): Promise<void> {
    this.running = false
    clearInterval(this.timer)
    this.active?.abort()
    await this.pending
  }
}
