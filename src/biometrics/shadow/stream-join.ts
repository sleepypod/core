import { dataHash } from '../algorithms/canonical'
import type { ShadowLease, ShadowStore } from './store'
import { shadowWorkerOutputSchema } from './worker-protocol'
import { shadowActiveReadingSchema } from './worker-sink'
import type { z } from 'zod'

type Candidate = z.infer<typeof shadowWorkerOutputSchema>
type Active = z.infer<typeof shadowActiveReadingSchema>
interface Pair { candidate?: Candidate, active?: Active }

/** Exact timestamp union, with bounded buffering and a frozen lateness policy.
 * The supervisor advances the clock and validates worker batches beforehand.
 * No nearby timestamp is relabelled to make a match. */
export class ShadowStreamJoin {
  private readonly plan: ReturnType<ShadowStore['get']>['plan']
  private readonly policy: NonNullable<ReturnType<ShadowStore['get']>['plan']['joining']>
  private readonly pending = new Map<number, Pair>()
  private sealedThrough: number
  private lastClock = -1
  private nextSequence: number
  private closed = false

  constructor(private readonly store: ShadowStore, private readonly lease: ShadowLease) {
    const run = store.get(lease.runId)
    if (run.state !== 'running' || run.attempt_id !== lease.attemptId || !run.plan.joining) throw new Error('Shadow join requires a live attempt and frozen join policy')
    this.plan = structuredClone(run.plan)
    this.policy = { ...run.plan.joining }
    const cursor = store.cursor(lease.runId)
    this.nextSequence = cursor.nextSequence
    this.sealedThrough = cursor.lastTimestampMs ?? run.plan.startMs - 1
  }

  private fail(reason: string): never {
    this.closed = true
    // This is a worker failure, not an operator stop. Never stop a replacement.
    try {
      this.store.finish(this.lease, 'failed', reason)
    }
    catch { /* A lost lease already fences this attempt. */ }
    throw new Error(reason)
  }

  private push(kind: 'candidate' | 'active', row: Candidate | Active) {
    if (this.closed) throw new Error('Shadow join is closed')
    if (row.side !== this.plan.side || row.configHash !== (kind === 'candidate' ? this.plan.candidateConfigHash : this.plan.activeConfigHash)
      || row.timestampMs < this.plan.startMs || row.timestampMs >= this.plan.endMs) return this.fail('join_identity_mismatch')
    if (row.timestampMs <= this.sealedThrough) return this.fail('join_late_arrival')
    for (const metric of this.plan.metrics) {
      const reading = row.readings.find(reading => reading.metric === metric)
      if (!reading || reading.windowMs !== (metric === 'window_ibi_variability_v1' ? this.plan.windowIbiWindowMs : null)) return this.fail('join_metric_mismatch')
    }
    const previous = this.pending.get(row.timestampMs)
    if (previous?.[kind]) {
      if (dataHash(previous[kind]) !== dataHash(row)) return this.fail('join_conflicting_duplicate')
      return
    }
    if (!previous && this.pending.size >= this.policy.maximumPendingPoints) return this.fail('join_queue_quota')
    this.pending.set(row.timestampMs, { ...previous, [kind]: row })
  }

  candidate(raw: unknown) { this.push('candidate', shadowWorkerOutputSchema.parse(raw)) }

  active(raw: unknown) { this.push('active', shadowActiveReadingSchema.parse(raw)) }

  advance(nowMs: number) {
    if (this.closed) throw new Error('Shadow join is closed')
    if (!Number.isSafeInteger(nowMs) || nowMs < this.plan.startMs || nowMs < this.lastClock) return this.fail('join_clock_regression')
    this.lastClock = nowMs
    const through = Math.min(this.plan.endMs - 1, nowMs - this.policy.maximumLatenessMs)
    let emitted = 0
    for (const timestampMs of [...this.pending.keys()].filter(time => time <= through).sort((a, b) => a - b)) {
      const pair = this.pending.get(timestampMs)
      if (!pair) throw new Error('Missing shadow join point')
      const { candidate, active } = pair
      const readings = this.plan.metrics.map((metric) => {
        const next = candidate?.readings.find(reading => reading.metric === metric)
        const previous = active?.readings.find(reading => reading.metric === metric)
        return { metric, candidate: next ? { value: next.value, quality: next.quality } : { value: null, quality: 0 },
          active: previous ? { value: previous.value, quality: previous.quality } : { value: null, quality: 0 } }
      })
      const inputHash = candidate?.inputHash ?? active?.inputHash ?? null
      const result = this.store.append(this.lease, { sequence: this.nextSequence, timestampMs, side: this.plan.side,
        candidateConfigHash: this.plan.candidateConfigHash, activeConfigHash: this.plan.activeConfigHash, inputHash,
        inputIdentityKind: candidate ? 'candidate_prefix' : inputHash ? 'active_provenance' : 'unavailable',
        ...(active?.provenance ? { activeProvenance: active.provenance } : {}),
        pairing: { policy: 'exact_timestamp_union_v1', candidatePresent: Boolean(candidate), activePresent: Boolean(active) }, readings,
        ...(candidate
          ? { candidateProvenance: { timestampBasis: candidate.timestampBasis, sourceSide: candidate.sourceSide, outputSequence: candidate.sequence, flags: candidate.flags,
              limitations: active ? candidate.limitations : [...candidate.limitations, 'missing_contemporaneous_active_reading'] } }
          : {}) })
      if (result.state === 'quota_reached') {
        this.closed = true
        return { emitted, stopped: true }
      }
      // Keep the point and sequence unchanged until storage acknowledges it;
      // this permits an exact retry after an uncertain committed write.
      this.pending.delete(timestampMs)
      this.nextSequence++
      this.sealedThrough = timestampMs
      emitted++
    }
    this.sealedThrough = Math.max(this.sealedThrough, through)
    return { emitted, stopped: false }
  }
}
