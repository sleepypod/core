import { z } from 'zod'
import type { ShadowStore } from './store'
import { type ShadowLease, shadowActiveProvenanceSchema } from './store'
import { shadowWorkerOutputSchema } from './worker-protocol'

export const shadowActiveReadingSchema = z.object({ side: z.enum(['left', 'right']), timestampMs: z.number().int().nonnegative(),
  provenance: shadowActiveProvenanceSchema.optional(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/), inputHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), readings: shadowWorkerOutputSchema.shape.readings,
}).strict().refine(value => new Set(value.readings.map(row => row.metric)).size === 3, 'All active metric identities required')

/** Fenced candidate-output sink. The supervisor validates response batches with
 * ShadowWorkerProtocol first and supplies actual contemporaneous active data.
 * Missing active data stays missing; no nearest-time substitution is allowed. */
export class ShadowWorkerSink {
  private readonly baseSequence: number
  private nextOutput = 0
  private readonly plan: ReturnType<ShadowStore['get']>['plan']

  constructor(private readonly store: ShadowStore, private readonly lease: ShadowLease) {
    const run = store.get(lease.runId)
    if (run.state !== 'running' || run.attempt_id !== lease.attemptId) throw new Error('Shadow sink attempt mismatch')
    this.baseSequence = run.point_count
    this.plan = structuredClone(run.plan)
  }

  append(rawOutput: unknown, rawActive: unknown | null) {
    const output = shadowWorkerOutputSchema.parse(rawOutput)
    const active = rawActive === null ? null : shadowActiveReadingSchema.parse(rawActive)
    if (output.sequence > this.nextOutput || output.side !== this.plan.side || output.configHash !== this.plan.candidateConfigHash) throw new Error('Shadow sink output identity mismatch')
    if (active && (active.side !== this.plan.side || active.configHash !== this.plan.activeConfigHash || active.timestampMs !== output.timestampMs)) throw new Error('Active reading is not contemporaneous with shadow output')
    const readings = this.plan.metrics.map((metric) => {
      const candidate = output.readings.find(row => row.metric === metric)
      const baseline = active?.readings.find(row => row.metric === metric)
      if (!candidate || (active && !baseline)) throw new Error('Missing sink metric')
      const expectedWindow = metric === 'window_ibi_variability_v1' ? this.plan.windowIbiWindowMs : null
      if (candidate.windowMs !== expectedWindow || (baseline && baseline.windowMs !== expectedWindow)) throw new Error('Shadow sink metric window mismatch')
      return { metric, candidate: { value: candidate.value, quality: candidate.quality },
        active: baseline ? { value: baseline.value, quality: baseline.quality } : { value: null, quality: 0 } }
    })
    const result = this.store.append(this.lease, { sequence: this.baseSequence + output.sequence, side: output.side, timestampMs: output.timestampMs,
      inputHash: output.inputHash, candidateConfigHash: output.configHash, activeConfigHash: this.plan.activeConfigHash, readings,
      ...(active?.provenance ? { activeProvenance: active.provenance } : {}),
      candidateProvenance: { timestampBasis: output.timestampBasis, sourceSide: output.sourceSide, outputSequence: output.sequence, flags: output.flags,
        limitations: active ? output.limitations : [...output.limitations, 'missing_contemporaneous_active_reading'] } })
    if (result.state !== 'quota_reached') this.nextOutput = Math.max(this.nextOutput, output.sequence + 1)
    return result
  }
}
