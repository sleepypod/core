import { shadowReceiptEnvelopeSchema, shadowPartialEnvelopeSchema, validateShadowPartialReceipt, validateShadowWorkerReceipt } from './receipt'
import { shadowPlanSchema } from './plan-contracts'
export { shadowPlanSchema, shadowMonitoringSchema, shadowExpectedBindingsSchema } from './plan-contracts'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { firmwareTimestampBasis } from './worker-protocol'
import { canonicalJson, dataHash } from '../algorithms/canonical'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = integer.positive()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const metric = z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'])
const reading = z.object({ value: z.number().finite().nullable(), quality: z.number().min(0).max(1) }).strict()
export const shadowActiveProvenanceSchema = z.object({ processingRunId: z.string().uuid(), sourceSide: z.enum(['left', 'right']),
  generation: integer, manifestHash: hash, timestampBasis: z.literal(firmwareTimestampBasis).optional() }).strict()
export const shadowSampleSchema = z.object({ sequence: integer, side: z.enum(['left', 'right']), timestampMs: integer, inputHash: hash.nullable(),
  candidateConfigHash: hash, activeConfigHash: hash,
  readings: z.array(z.object({ metric, candidate: reading, active: reading }).strict()).min(1).max(3),
  pairing: z.object({ policy: z.literal('exact_timestamp_union_v1'), candidatePresent: z.boolean(), activePresent: z.boolean() }).strict().optional(),
  inputIdentityKind: z.enum(['candidate_prefix', 'active_provenance', 'unavailable']).optional(),
  activeProvenance: shadowActiveProvenanceSchema.optional(),
  candidateProvenance: z.object({ timestampBasis: z.literal(firmwareTimestampBasis).optional(), sourceSide: z.enum(['left', 'right']), outputSequence: integer,
    flags: z.array(z.string().max(200)).max(32).nullable(), limitations: z.array(z.string().max(200)).max(33) }).strict().optional(),
}).strict()
export const shadowStoragePolicySchema = z.object({ maximumRuns: positive, maximumPoints: positive, maximumBytes: positive }).strict()
type Plan = z.infer<typeof shadowPlanSchema>
interface RunRow {
  worker_receipt: string | null
  worker_receipt_hash: string | null
  id: string
  plan_hash: string
  plan: string
  side: 'left' | 'right'
  state: 'pending' | 'running' | 'completed' | 'stopped' | 'failed'
  attempt_id: string | null
  lease_until_ms: number | null
  heartbeat_at_ms: number | null
  created_at_ms: number
  ended_at_ms: number | null
  reason: string | null
  point_count: number
  byte_count: number
}
export interface ShadowLease { runId: string, attemptId: string }

/** Storage only: accepts observations from a separately admitted shipped
 * processor. No algorithm imports, canonical writes, activation or hardware.
 * The host must verify qualification/build and enforce CPU/RSS before claim. */
export class ShadowStore {
  private readonly policy: z.infer<typeof shadowStoragePolicySchema> | null
  constructor(private readonly db: Database.Database, policy?: unknown, private readonly now = Date.now) {
    this.policy = policy === undefined ? null : shadowStoragePolicySchema.parse(policy)
  }

  private executionPolicy() {
    if (!this.policy) throw new Error('Shadow execution storage policy required')
    return this.policy
  }

  list(options: { side: 'left' | 'right', maximumRuns: number, afterId?: string }) {
    const input = z.object({ side: z.enum(['left', 'right']), maximumRuns: positive.max(50), afterId: z.string().uuid().optional() }).strict().parse(options)
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id FROM biometric_shadow_runs WHERE side = ? AND id > ? ORDER BY id LIMIT ?')
        .all(input.side, input.afterId ?? '', input.maximumRuns + 1) as { id: string }[]
      const items = rows.slice(0, input.maximumRuns).map(row => this.get(row.id))
      return { items, nextCursor: rows.length > input.maximumRuns ? items.at(-1)?.id ?? null : null }
    }).deferred()
  }

  get(id: string) {
    const row = this.db.prepare('SELECT * FROM biometric_shadow_runs WHERE id = ?').get(id) as RunRow | undefined
    if (!row) throw new Error('Unknown shadow run')
    const plan = shadowPlanSchema.parse(JSON.parse(row.plan))
    if (dataHash(plan) !== row.plan_hash || row.side !== plan.side) throw new Error('Shadow plan integrity mismatch')
    let workerReceipt = null
    if (row.worker_receipt !== null) {
      if (Buffer.byteLength(row.worker_receipt) > 16384) throw new Error('Shadow receipt exceeds storage limit')
      workerReceipt = shadowReceiptEnvelopeSchema.parse(JSON.parse(row.worker_receipt))
      if (!plan.execution || dataHash(workerReceipt) !== row.worker_receipt_hash || workerReceipt.runId !== row.id
        || workerReceipt.attemptId !== row.attempt_id || workerReceipt.planHash !== row.plan_hash) throw new Error('Shadow receipt integrity mismatch')
      if (workerReceipt.schema === 'biometric-shadow-receipt-v1') {
        if (row.state !== 'completed' || workerReceipt.recordedAtMs !== row.ended_at_ms) throw new Error('Shadow receipt integrity mismatch')
        validateShadowWorkerReceipt(workerReceipt.receipt, plan.execution)
      }
      else {
        if (!['failed', 'stopped'].includes(row.state) || row.ended_at_ms === null || workerReceipt.recordedAtMs < row.ended_at_ms) throw new Error('Shadow receipt integrity mismatch')
        validateShadowPartialReceipt(workerReceipt.receipt, plan.execution)
      }
    }
    else if (row.worker_receipt_hash !== null) throw new Error('Shadow receipt integrity mismatch')
    return { ...row, plan, workerReceipt }
  }

  /** Complete bounded snapshot for scoring. Refuse oversize data rather than
   * silently scoring a paginated/downsampled subset. */
  snapshot(id: string, limits: { maximumPoints: number, maximumBytes: number }) {
    z.object({ maximumPoints: positive.max(100000), maximumBytes: positive.max(32 * 1024 * 1024) }).strict().parse(limits)
    return this.db.transaction(() => {
      const run = this.get(id)
      const totals = this.db.prepare(`SELECT COUNT(*) AS points, COALESCE(SUM(byte_length), 0) AS bytes,
        COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS actual_bytes FROM biometric_shadow_samples WHERE run_id = ?`).get(id) as { points: number, bytes: number, actual_bytes: number }
      if (totals.points !== run.point_count || totals.bytes !== run.byte_count || totals.bytes !== totals.actual_bytes) throw new Error('Shadow sample totals integrity mismatch')
      if (totals.points > limits.maximumPoints || totals.actual_bytes > limits.maximumBytes) throw new Error('Shadow report input limit exceeded')
      const rows = this.db.prepare('SELECT sequence, timestamp_ms, content_hash, payload, byte_length FROM biometric_shadow_samples WHERE run_id = ? ORDER BY sequence').all(id) as { sequence: number, timestamp_ms: number, content_hash: string, payload: string, byte_length: number }[]
      const capturedAtMs = this.now()
      let previousTime = -1
      const samples = rows.map((row, index) => {
        const envelope = shadowSampleSchema.extend({ attemptId: z.string().uuid() }).parse(JSON.parse(row.payload))
        const { attemptId, ...sample } = envelope
        if (dataHash(sample) !== row.content_hash || row.byte_length !== Buffer.byteLength(row.payload)
          || row.sequence !== index || sample.sequence !== index || sample.timestampMs !== row.timestamp_ms
          || sample.timestampMs <= previousTime || sample.timestampMs < run.plan.startMs || sample.timestampMs >= run.plan.endMs
          || sample.side !== run.side || sample.candidateConfigHash !== run.plan.candidateConfigHash || sample.activeConfigHash !== run.plan.activeConfigHash
          || sample.readings.length !== run.plan.metrics.length || new Set(sample.readings.map(row => row.metric)).size !== run.plan.metrics.length
          || sample.readings.some(row => !run.plan.metrics.includes(row.metric))) throw new Error('Shadow sample integrity mismatch')
        previousTime = sample.timestampMs
        return { ...sample, attemptId }
      })
      const snapshot = { schema: 'biometric-shadow-snapshot-v1' as const, run, capturedAtMs, samples }
      return { ...snapshot, snapshotHash: dataHash(snapshot) }
    }).deferred()
  }

  cursor(id: string) {
    return this.db.transaction(() => {
      const run = this.get(id)
      const last = this.db.prepare('SELECT sequence, timestamp_ms FROM biometric_shadow_samples WHERE run_id = ? ORDER BY sequence DESC LIMIT 1').get(id) as { sequence: number, timestamp_ms: number } | undefined
      if ((last ? last.sequence + 1 : 0) !== run.point_count) throw new Error('Shadow cursor integrity mismatch')
      return { nextSequence: run.point_count, lastTimestampMs: last?.timestamp_ms ?? null }
    }).deferred()
  }

  findCreated(raw: unknown, idempotencyKey: string) {
    const plan = shadowPlanSchema.parse(raw)
    z.string().min(1).max(200).parse(idempotencyKey)
    const previous = this.db.prepare('SELECT id, plan_hash FROM biometric_shadow_runs WHERE idempotency_key = ?').get(idempotencyKey) as { id: string, plan_hash: string } | undefined
    if (!previous) return null
    if (previous.plan_hash !== dataHash(plan)) throw new Error('Shadow idempotency conflict')
    return this.get(previous.id)
  }

  create(raw: unknown, idempotencyKey: string, admit?: (plan: Plan) => void) {
    const policy = this.executionPolicy()
    const plan = shadowPlanSchema.parse(raw), planHash = dataHash(plan)
    z.string().min(1).max(200).parse(idempotencyKey)
    return this.db.transaction(() => {
      const previous = this.findCreated(plan, idempotencyKey)
      if (previous) {
        return previous
      }
      const now = this.now()
      if (plan.startMs < now) throw new Error('Shadow window must be prospective')
      if (plan.maximumPoints > policy.maximumPoints || plan.maximumBytes > policy.maximumBytes) throw new Error('Shadow plan exceeds storage policy')
      const count = (this.db.prepare('SELECT COUNT(*) AS count FROM biometric_shadow_runs').get() as { count: number }).count
      if (count >= policy.maximumRuns) throw new Error('Shadow run quota exceeded')
      const admitted: unknown = admit?.(structuredClone(plan))
      if (admitted !== undefined) {
        void Promise.resolve(admitted).catch(() => {})
        throw new Error('Shadow admission must complete synchronously')
      }
      if (plan.startMs < this.now()) throw new Error('Shadow window must be prospective')
      const id = randomUUID()
      this.db.prepare(`INSERT INTO biometric_shadow_runs
        (id, idempotency_key, plan_hash, plan, side, state, created_at_ms) VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id, idempotencyKey, planHash, canonicalJson(plan), plan.side, now)
      return this.get(id)
    }).immediate()
  }

  /** Read-only bounded queue scan. It never resumes a running attempt after a
   * restart: recovery must revoke that authority, retaining incomplete evidence.
   * The caller still has to claim and revalidate the selected plan. */
  pending(options: { maximumRuns: number, afterId?: string }) {
    const input = z.object({ maximumRuns: positive.max(100), afterId: z.string().uuid().optional() }).strict().parse(options)
    return this.db.transaction(() => {
      const now = integer.parse(this.now())
      const rows = this.db.prepare('SELECT id, state FROM biometric_shadow_runs WHERE id > ? ORDER BY id LIMIT ?')
        .all(input.afterId ?? '', input.maximumRuns + 1) as { id: string, state: RunRow['state'] }[]
      const batch = rows.slice(0, input.maximumRuns)
      for (const row of batch) {
        if (row.state !== 'pending') continue
        const run = this.get(row.id)
        if (run.attempt_id !== null || run.lease_until_ms !== null) throw new Error('Invalid pending shadow authority')
        if (!run.plan.execution || !run.plan.expectedBindings || run.plan.candidateRevisionId === undefined || now < run.plan.startMs || now >= run.plan.endMs) continue
        return { run: { runId: run.id, revisionId: run.plan.candidateRevisionId }, nextCursor: row.id }
      }
      return { run: null, nextCursor: rows.length > input.maximumRuns ? batch.at(-1)?.id ?? null : null }
    }).deferred()
  }

  /** Admission is a trusted synchronous host check, never a client boolean. */
  claim(id: string, leaseMs: number, admit: (plan: Plan) => void): ShadowLease {
    this.executionPolicy()
    z.number().int().min(1000).max(3600000).parse(leaseMs)
    return this.db.transaction(() => {
      const run = this.get(id), now = this.now()
      if (!['pending', 'running'].includes(run.state) || (run.state === 'running' && (run.lease_until_ms ?? 0) > now)) throw new Error('Shadow run unavailable')
      if (now < run.plan.startMs || now >= run.plan.endMs) throw new Error('Outside shadow window')
      if (this.db.prepare(`SELECT id FROM biometric_shadow_runs WHERE side = ? AND state = 'running' AND lease_until_ms > ? AND id != ?`).get(run.side, now, id)) throw new Error('Side already has an active shadow worker')
      // Pass a copy: an admission callback cannot mutate the frozen plan.
      const admitted: unknown = admit(structuredClone(run.plan))
      if (admitted !== undefined) {
        void Promise.resolve(admitted).catch(() => undefined)
        throw new Error('Shadow admission must complete synchronously')
      }
      const attemptId = randomUUID()
      this.db.prepare('UPDATE biometric_shadow_runs SET state = \'running\', attempt_id = ?, lease_until_ms = ?, heartbeat_at_ms = ? WHERE id = ?')
        .run(attemptId, Math.min(run.plan.endMs + (run.plan.joining?.drainGraceMs ?? 0), now + leaseMs), now, id)
      return { runId: id, attemptId }
    }).immediate()
  }

  private current(lease: ShadowLease) {
    const run = this.get(lease.runId), now = this.now()
    if (run.state !== 'running' || run.attempt_id !== lease.attemptId || (run.lease_until_ms ?? 0) <= now || now >= run.plan.endMs + (run.plan.joining?.drainGraceMs ?? 0)) throw new Error('Stale shadow lease')
    return { run, now }
  }

  append(lease: ShadowLease, raw: unknown) {
    const policy = this.executionPolicy()
    const sample = shadowSampleSchema.parse(raw), contentHash = dataHash(sample)
    return this.db.transaction(() => {
      const { run, now } = this.current(lease)
      if (sample.side !== run.side || sample.candidateConfigHash !== run.plan.candidateConfigHash || sample.activeConfigHash !== run.plan.activeConfigHash
        || sample.timestampMs < run.plan.startMs || sample.timestampMs >= run.plan.endMs || sample.timestampMs > now
        || sample.readings.length !== run.plan.metrics.length || new Set(sample.readings.map(row => row.metric)).size !== run.plan.metrics.length
        || sample.readings.some(row => !run.plan.metrics.includes(row.metric))) throw new Error('Shadow sample differs from frozen plan')
      const previous = this.db.prepare('SELECT content_hash FROM biometric_shadow_samples WHERE run_id = ? AND sequence = ?').get(run.id, sample.sequence) as { content_hash: string } | undefined
      if (previous) {
        if (previous.content_hash !== contentHash) throw new Error('Shadow sample idempotency conflict')
        return { state: 'already_recorded' as const }
      }
      const last = this.db.prepare('SELECT sequence, timestamp_ms FROM biometric_shadow_samples WHERE run_id = ? ORDER BY sequence DESC LIMIT 1').get(run.id) as { sequence: number, timestamp_ms: number } | undefined
      if (sample.sequence !== (last ? last.sequence + 1 : 0) || (last && sample.timestampMs <= last.timestamp_ms)) throw new Error('Out-of-order shadow sample')
      const payload = canonicalJson({ ...sample, attemptId: lease.attemptId }), bytes = Buffer.byteLength(payload)
      const totals = this.db.prepare('SELECT COALESCE(SUM(point_count), 0) AS points, COALESCE(SUM(byte_count), 0) AS bytes FROM biometric_shadow_runs').get() as { points: number, bytes: number }
      if (run.point_count + 1 > run.plan.maximumPoints || run.byte_count + bytes > run.plan.maximumBytes
        || totals.points + 1 > policy.maximumPoints || totals.bytes + bytes > policy.maximumBytes) {
        this.db.prepare('UPDATE biometric_shadow_runs SET state = \'stopped\', reason = \'storage_quota\', ended_at_ms = ?, lease_until_ms = NULL WHERE id = ?').run(now, run.id)
        return { state: 'quota_reached' as const }
      }
      this.db.prepare('INSERT INTO biometric_shadow_samples VALUES (?, ?, ?, ?, ?, ?)').run(run.id, sample.sequence, sample.timestampMs, contentHash, payload, bytes)
      this.db.prepare('UPDATE biometric_shadow_runs SET point_count = point_count + 1, byte_count = byte_count + ?, heartbeat_at_ms = ? WHERE id = ?').run(bytes, now, run.id)
      return { state: 'recorded' as const }
    }).immediate()
  }

  /** Host/operator cancellation also works after a worker has disappeared or
   * the observation window has ended. Terminal evidence is preserved. */
  stop(id: string, reason: string) {
    z.string().min(1).max(500).parse(reason)
    return this.db.transaction(() => {
      this.get(id)
      this.db.prepare('UPDATE biometric_shadow_runs SET state = \'stopped\', reason = ?, ended_at_ms = ?, lease_until_ms = NULL WHERE id = ? AND state IN (\'pending\', \'running\')')
        .run(reason, this.now(), id)
      return this.get(id)
    }).immediate()
  }

  renew(lease: ShadowLease, leaseMs: number) {
    z.number().int().min(1000).max(3600000).parse(leaseMs)
    this.db.transaction(() => {
      const { run, now } = this.current(lease)
      this.db.prepare('UPDATE biometric_shadow_runs SET lease_until_ms = ?, heartbeat_at_ms = ? WHERE id = ?').run(Math.min(run.plan.endMs + (run.plan.joining?.drainGraceMs ?? 0), now + leaseMs), now, run.id)
    }).immediate()
  }

  /** Bounded keyset maintenance. Revoke expired authority, not a claim that an
   * OS process was reaped. A resumed worker cannot append/renew after recovery;
   * the kernel execution slot still excludes overlap until that worker exits. */
  reconcileExpired(options: { maximumRuns: number, afterId?: string }) {
    const input = z.object({ maximumRuns: positive.max(100), afterId: z.string().uuid().optional() }).strict().parse(options)
    return this.db.transaction(() => {
      const now = integer.parse(this.now())
      const rows = this.db.prepare('SELECT id, state FROM biometric_shadow_runs WHERE id > ? ORDER BY id LIMIT ?')
        .all(input.afterId ?? '', input.maximumRuns + 1) as { id: string, state: RunRow['state'] }[]
      const batch = rows.slice(0, input.maximumRuns)
      const recovered: { runId: string, attemptId: string | null, reason: string }[] = []
      for (const row of batch) {
        if (row.state !== 'pending' && row.state !== 'running') continue
        const run = this.get(row.id)
        let reason: string
        if (run.state === 'pending') {
          if (now < run.plan.endMs) continue
          if (run.attempt_id !== null || run.lease_until_ms !== null) throw new Error('Invalid pending shadow authority')
          reason = 'shadow_observation_window_missed'
        }
        else {
          z.string().uuid().parse(run.attempt_id)
          integer.parse(run.lease_until_ms)
          if ((run.lease_until_ms ?? 0) > now && now < run.plan.endMs + (run.plan.joining?.drainGraceMs ?? 0)) continue
          reason = 'shadow_lease_expired_cleanup_unconfirmed'
        }
        const updated = this.db.prepare(`UPDATE biometric_shadow_runs SET state = 'failed', reason = ?, ended_at_ms = ?, lease_until_ms = NULL
          WHERE id = ? AND state = ? AND attempt_id IS ? AND lease_until_ms IS ?`)
          .run(reason, now, run.id, run.state, run.attempt_id, run.lease_until_ms)
        if (updated.changes !== 1) throw new Error('Shadow recovery authority changed')
        recovered.push({ runId: run.id, attemptId: run.attempt_id, reason })
      }
      return { scanned: batch.length, recovered, nextCursor: rows.length > input.maximumRuns ? batch.at(-1)?.id ?? null : null }
    }).immediate()
  }

  /** After the host has reaped its worker, record an expired attempt's failure.
   * A newer attempt or an already terminal run is never changed. */
  failExpired(lease: ShadowLease, reason: string) {
    z.string().min(1).max(500).parse(reason)
    return this.db.transaction(() => {
      const run = this.get(lease.runId), now = this.now()
      if (run.state !== 'running' || run.attempt_id !== lease.attemptId
        || ((run.lease_until_ms ?? 0) > now && now < run.plan.endMs + (run.plan.joining?.drainGraceMs ?? 0))) return false
      this.db.prepare('UPDATE biometric_shadow_runs SET state = \'failed\', reason = ?, ended_at_ms = ?, lease_until_ms = NULL WHERE id = ?')
        .run(reason, now, run.id)
      return true
    }).immediate()
  }

  /** Attach cleanup evidence without changing terminal authority, even when an
   * operator or recovery already ended this exact attempt. Never replace evidence. */
  recordPartialReceipt(lease: ShadowLease, raw: unknown) {
    return this.db.transaction(() => {
      const run = this.get(lease.runId), now = this.now()
      if (run.attempt_id !== lease.attemptId || !['failed', 'stopped'].includes(run.state)) return false
      if (!run.plan.execution || run.ended_at_ms === null || now < run.ended_at_ms) throw new Error('Shadow partial receipt requires a terminal executable attempt')
      const receipt = validateShadowPartialReceipt(raw, run.plan.execution)
      if (run.workerReceipt) {
        if (run.workerReceipt.schema === 'biometric-shadow-partial-receipt-v1' && dataHash(run.workerReceipt.receipt) === dataHash(receipt)) return true
        throw new Error('Shadow receipt already recorded')
      }
      const envelope = shadowPartialEnvelopeSchema.parse({ schema: 'biometric-shadow-partial-receipt-v1', runId: run.id,
        attemptId: lease.attemptId, planHash: run.plan_hash, recordedAtMs: now, receipt })
      const encoded = canonicalJson(envelope)
      if (Buffer.byteLength(encoded) > 16384) throw new Error('Shadow receipt exceeds storage limit')
      this.db.prepare('UPDATE biometric_shadow_runs SET worker_receipt = ?, worker_receipt_hash = ? WHERE id = ?')
        .run(encoded, dataHash(envelope), run.id)
      return true
    }).immediate()
  }

  finish(lease: ShadowLease, state: 'completed' | 'stopped' | 'failed', reason: string, rawReceipt?: unknown) {
    z.enum(['completed', 'stopped', 'failed']).parse(state)
    z.string().min(1).max(500).parse(reason)
    this.db.transaction(() => {
      const { run, now } = this.current(lease)
      let receipt = null, receiptHash = null
      if (state === 'completed' && run.plan.execution) {
        receipt = canonicalJson(shadowReceiptEnvelopeSchema.parse({ schema: 'biometric-shadow-receipt-v1',
          runId: run.id, attemptId: lease.attemptId, planHash: run.plan_hash, recordedAtMs: now,
          receipt: validateShadowWorkerReceipt(rawReceipt, run.plan.execution) }))
        if (Buffer.byteLength(receipt) > 16384) throw new Error('Shadow receipt exceeds storage limit')
        receiptHash = dataHash(JSON.parse(receipt))
      }
      else if (rawReceipt !== undefined) throw new Error('Worker receipt requires a completed executable plan')
      this.db.prepare('UPDATE biometric_shadow_runs SET state = ?, reason = ?, ended_at_ms = ?, lease_until_ms = NULL, worker_receipt = ?, worker_receipt_hash = ? WHERE id = ?')
        .run(state, reason, now, receipt, receiptHash, run.id)
    }).immediate()
  }
}
