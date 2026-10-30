// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShadowStore } from '../store'
import { reportShadowRun } from '../report'
import { ShadowWorkerSink } from '../worker-sink'
import { ShadowStreamJoin } from '../stream-join'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))
const hash = 'a'.repeat(64), start = 1700000000000
const plan = { subjectId: 'fixture', monitoring: { expectedIntervalMs: 1000, maximumGapMs: 2000, heartbeatStaleMs: 2000, minimumCandidateCoverage: 0.8, maximumCoverageLoss: 0.1, minimumQuality: 0.8,
  alignment: { version: 'reference-alignment-v1', pointToleranceMs: 0, clockOffsetMs: 0, offsetSource: 'fixed' } }, schema: 'biometric-shadow-plan-v1', side: 'left', candidateConfigHash: hash, activeConfigHash: 'b'.repeat(64),
qualificationHash: 'c'.repeat(64), engineBuildHash: 'd'.repeat(64), startMs: start, endMs: start + 60000,
maximumPoints: 3, maximumBytes: 10000, metrics: ['heart_rate'] }
function setup(policy = { maximumRuns: 10, maximumPoints: 10, maximumBytes: 100000 }) {
  const db = new Database(':memory:')
  databases.push(db)
  migrate(drizzle(db), { migrationsFolder: fileURLToPath(new URL('../../../db/biometrics-migrations/', import.meta.url)) })
  let now = start
  return { db, store: new ShadowStore(db, policy, () => now), advance: (ms: number) => {
    now += ms
  } }
}
function sample(sequence = 0) {
  return { sequence, side: 'left', timestampMs: start + sequence, inputHash: hash, candidateConfigHash: hash, activeConfigHash: plan.activeConfigHash,
    readings: [{ metric: 'heart_rate', candidate: { value: null as number | null, quality: 0 }, active: { value: 60, quality: 1 } }] }
}
const joining = { maximumPendingPoints: 10, maximumLatenessMs: 1000, drainGraceMs: 2000 }
const executable = { ...plan, joining, candidateRevisionId: null,
  expectedBindings: { left: { generation: 1, resolvedHash: hash }, right: { generation: 1, resolvedHash: hash } },
  execution: { version: 'shadow-execution-policy-v1', configHashes: { left: hash, right: hash },
    maximumRecords: 10, maximumOutputs: 10, maximumCpuMs: 1000, maximumInputBytes: 100000, maximumOutputBytes: 100000,
    budgets: { cpuSeconds: 2, addressSpaceBytes: 100000000, maximumRssBytes: 100000000, wallMs: 10000, acknowledgmentMs: 1000, idleMs: 1000, rssIntervalMs: 100, rssTimeoutMs: 100 },
    leaseMs: 1500, heartbeatMs: 200, sources: { pollMs: 50, maximumActiveRows: 10, databaseBusyTimeoutMs: 50,
      frames: { maximumFrames: 10, maximumBytes: 100000, maximumEventAgeMs: 1000, maximumFutureSkewMs: 0 },
      context: { presenceStaleMs: 300000, pumpStaleMs: 5000, maximumPresenceBytes: 4096 } } } }

it('persists candidate revision identity and rejects identity changes on retry', () => {
  const { store } = setup()
  const revision = '11111111-1111-4111-8111-111111111111'
  const run = store.create({ ...executable, candidateRevisionId: revision }, 'identity')
  expect(store.get(run.id).plan.candidateRevisionId).toBe(revision)
  expect(() => store.create(executable, 'identity')).toThrow('idempotency')
  expect(() => store.create({ ...executable, candidateRevisionId: 'latest' }, 'invalid')).toThrow()
})

it('scans bounded pages past legacy, future and running plans using saved identity', () => {
  const { store, advance } = setup()
  store.create(plan, 'legacy')
  const { candidateRevisionId, ...legacyExecution } = executable
  expect(candidateRevisionId).toBeNull()
  store.create(legacyExecution, 'no-identity')
  const future = store.create({ ...executable, startMs: start + 1000 }, 'future')
  const running = store.create(executable, 'running')
  store.claim(running.id, 10000, () => {})
  const ready = store.create(executable, 'ready')
  const scan = () => {
    const results: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = store.pending({ maximumRuns: 1, ...(cursor ? { afterId: cursor } : {}) })
      if (page.run) {
        expect(page.run.revisionId).toBeNull()
        results.push(page.run.runId)
      }
      cursor = page.nextCursor ?? undefined
      expect(++pages).toBeLessThan(8)
    } while (cursor)
    return results
  }
  expect(scan()).toEqual([ready.id])
  advance(1000)
  expect(scan().sort()).toEqual([ready.id, future.id].sort())
  advance(60000)
  expect(scan()).toEqual([])
  expect(store.get(running.id).state).toBe('running')
})

it('fails queue inspection on corrupted pending evidence', () => {
  const { store, db } = setup()
  const run = store.create(executable, 'ready')
  db.prepare('UPDATE biometric_shadow_runs SET plan_hash = \'corrupt\' WHERE id = ?').run(run.id)
  expect(() => store.pending({ maximumRuns: 1 })).toThrow('integrity')
})
function workerOutput(timestampMs: number, sequence = 0) {
  return { sequence, inputHash: hash, side: 'left', sourceSide: 'left', timestampBasis: 'firmware_event_time_v1', timestampMs, configHash: hash,
    readings: [{ metric: 'heart_rate', unit: 'bpm', windowMs: null, value: 60, quality: 1 },
      { metric: 'breathing_rate', unit: 'breaths/min', windowMs: null, value: 15, quality: 1 },
      { metric: 'window_ibi_variability_v1', unit: 'ms', windowMs: 300000, value: null, quality: 0 }], flags: null, limitations: [] }
}
function activeOutput(timestampMs: number) {
  return { side: 'left', timestampMs, configHash: plan.activeConfigHash, readings: workerOutput(timestampMs).readings }
}
describe('separate prospective shadow storage', () => {
  it('uses the generated additive migration and never writes canonical observations', () => {
    const { db, store } = setup()
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER deny_vitals_${operation} BEFORE ${operation} ON vitals BEGIN SELECT RAISE(ABORT, 'canonical write forbidden'); END`)
    const before = db.prepare('SELECT * FROM vitals').all()
    const run = store.create(plan, 'create')
    const lease = store.claim(run.id, 10000, (admitted) => {
      expect(admitted.qualificationHash).toBe(plan.qualificationHash)
    })
    expect(store.append(lease, sample())).toEqual({ state: 'recorded' })
    expect(store.append(lease, sample())).toEqual({ state: 'already_recorded' })
    expect(store.get(run.id)).toMatchObject({ point_count: 1, state: 'running' })
    expect(db.prepare('SELECT * FROM vitals').all()).toEqual(before)
    const payload = JSON.parse((db.prepare('SELECT payload FROM biometric_shadow_samples').get() as { payload: string }).payload)
    expect(payload).toMatchObject({ attemptId: lease.attemptId, readings: [{ candidate: { value: null }, active: { value: 60 } }] })
  })
  it('rejects retroactive windows and changed idempotency requests, while exact retries survive time passing', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    advance(100)
    expect(store.create(plan, 'first').id).toBe(run.id)
    expect(() => store.create(plan, 'second')).toThrow('prospective')
    expect(() => store.create({ ...plan, side: 'right' }, 'first')).toThrow('idempotency')
  })
  it('requires admission and fences replaced workers without losing retained samples', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    expect(() => store.claim(run.id, 1000, () => {
      throw new Error('Unqualified build')
    })).toThrow('Unqualified build')
    expect(store.get(run.id).state).toBe('pending')
    const old = store.claim(run.id, 1000, () => undefined)
    store.append(old, sample())
    advance(1000)
    expect(() => store.append(old, sample(1))).toThrow('Stale')
    const current = store.claim(run.id, 1000, () => undefined)
    expect(() => store.renew(old, 1000)).toThrow('Stale')
    expect(() => store.finish(old, 'completed', 'stale')).toThrow('Stale')
    expect(store.append(current, sample(1))).toEqual({ state: 'recorded' })
    expect(store.get(run.id).point_count).toBe(2)
  })
  it('limits concurrent workers per side but permits the other side', () => {
    const { store } = setup()
    const first = store.create(plan, 'first'), second = store.create(plan, 'second'), right = store.create({ ...plan, side: 'right' }, 'right')
    store.claim(first.id, 1000, () => undefined)
    expect(() => store.claim(second.id, 1000, () => undefined)).toThrow('Side already')
    expect(store.claim(right.id, 1000, () => undefined).runId).toBe(right.id)
  })
  it('rejects configuration changes, duplicate metrics, future points, reordered points and altered retries', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 10000, () => undefined)
    for (const invalid of [{ ...sample(), side: 'right' }, { ...sample(), candidateConfigHash: 'f'.repeat(64) }, { ...sample(), activeConfigHash: 'f'.repeat(64) },
      { ...sample(), timestampMs: start - 1 }, { ...sample(), timestampMs: start + 1 }, { ...sample(), readings: [...sample().readings, ...sample().readings] }]) {
      expect(() => store.append(lease, invalid)).toThrow('frozen plan')
    }
    store.append(lease, sample())
    expect(() => store.append(lease, { ...sample(), inputHash: 'f'.repeat(64) })).toThrow('idempotency')
    advance(100)
    expect(() => store.append(lease, sample(2))).toThrow('Out-of-order')
    expect(() => store.append(lease, { ...sample(1), timestampMs: start })).toThrow('Out-of-order')
  })
  it('atomically stops at per-run and global quotas and keeps stored evidence', () => {
    const { store, advance } = setup({ maximumRuns: 2, maximumPoints: 3, maximumBytes: 100000 })
    const first = store.create({ ...plan, maximumPoints: 1 }, 'first'), second = store.create({ ...plan, side: 'right' }, 'second')
    expect(() => store.create(plan, 'third')).toThrow('run quota')
    const lease = store.claim(first.id, 10000, () => undefined)
    const other = store.claim(second.id, 10000, () => undefined)
    store.append(lease, sample())
    advance(1)
    expect(store.append(lease, sample(1))).toEqual({ state: 'quota_reached' })
    expect(store.get(first.id)).toMatchObject({ state: 'stopped', reason: 'storage_quota', point_count: 1 })
    store.append(other, { ...sample(), side: 'right' })
    store.append(other, { ...sample(1), side: 'right' })
    advance(1)
    expect(store.append(other, { ...sample(2), side: 'right' })).toEqual({ state: 'quota_reached' })
    expect(store.get(second.id).point_count).toBe(2)
  })
  it('can cancel after deadline and cannot accept asynchronous admission', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    expect(() => store.claim(run.id, 1000, async () => undefined)).toThrow('synchronously')
    expect(store.get(run.id).state).toBe('pending')
    const lease = store.claim(run.id, 1000, () => undefined)
    store.append(lease, sample())
    advance(60000)
    expect(() => store.renew(lease, 1000)).toThrow('Stale')
    expect(store.stop(run.id, 'window_elapsed')).toMatchObject({ state: 'stopped', reason: 'window_elapsed', point_count: 1 })
    expect(store.stop(run.id, 'retry')).toMatchObject({ reason: 'window_elapsed' })
    expect(() => store.claim(run.id, 1000, () => undefined)).toThrow('unavailable')
  })
  it('reports dropped candidate values, common reference support and current worker health', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 10000, () => undefined)
    const first = sample()
    first.readings[0].candidate = { value: 61, quality: 1 }
    store.append(lease, first)
    advance(1000)
    store.append(lease, { ...sample(1), timestampMs: start + 1000 })
    const reference = { subjectId: 'fixture', side: 'left', source: 'test', rows: [0, 1000].map((offset, index) => ({
      recordKey: String(index), metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: start + offset })) }
    const report = reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 }, reference)
    expect(report).toMatchObject({ expectedSlots: 2, observedSamples: 2, health: 'issues_detected', issues: ['coverage_degraded'],
      metrics: [{ candidate: { coverage: 0.5, usableCount: 1 }, current: { coverage: 1 }, coverageDifference: -0.5,
        comparison: { commonObservationCount: 1, lostObservationTimestamps: 1 } }] })
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/)
    advance(10000)
    expect(report.contextEvidence).toBe('host_observations_not_live_processor_cache_attestation')
    const stale = reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 })
    expect(stale.issues).toEqual(expect.arrayContaining(['worker_stale', 'observation_gap']))
  })
  it('does not inflate coverage from bursts within one cadence slot', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 10000, () => undefined)
    for (let index = 0; index < 3; index++) {
      const point = sample(index)
      point.readings[0].candidate = { value: 60, quality: 1 }
      store.append(lease, point)
      advance(1)
    }
    advance(1997)
    const report = reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 })
    expect(report).toMatchObject({ expectedSlots: 3, metrics: [{ candidate: { usableCount: 3, usableSlots: 1, coverage: 1 / 3 } }] })
  })
  it('requires matching reference identity and never compares RMSSD to the variability index', () => {
    const { store } = setup()
    const lease = store.claim(store.create({ ...plan, metrics: ['window_ibi_variability_v1'], windowIbiWindowMs: 300000 }, 'first').id, 10000, () => undefined)
    store.append(lease, { ...sample(), readings: [{ metric: 'window_ibi_variability_v1', active: { value: 20, quality: 1 }, candidate: { value: 20, quality: 1 } }] })
    const reference = { subjectId: 'fixture', side: 'left', source: 'test', rows: [{ recordKey: '0', metric: 'hrv_rmssd', value: 20, unit: 'ms', windowMs: 300000, timestampMs: start }] }
    const limits = { maximumPoints: 10, maximumBytes: 10000 }
    expect(reportShadowRun(store, lease.runId, limits, reference).metrics[0]).toMatchObject({
      referenceExclusions: { incompatible_metric_definition: 1 }, comparison: { commonSupport: { candidate: { status: 'incompatible', metrics: null } } },
    })
    expect(() => reportShadowRun(store, lease.runId, limits, { ...reference, subjectId: 'other' })).toThrow('subject or side')
    expect(() => reportShadowRun(store, lease.runId, limits, { ...reference, side: 'right' })).toThrow('subject or side')
    expect(() => store.create({ ...plan, metrics: ['window_ibi_variability_v1'] }, 'invalid')).toThrow()
  })
  it('refuses oversized or corrupted snapshots instead of scoring partial history', () => {
    const { db, store } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 10000, () => undefined)
    store.append(lease, sample())
    expect(() => store.snapshot(lease.runId, { maximumPoints: 10, maximumBytes: 1 })).toThrow('input limit')
    db.prepare('UPDATE biometric_shadow_samples SET content_hash = ? WHERE run_id = ?').run('f'.repeat(64), lease.runId)
    expect(() => store.snapshot(lease.runId, { maximumPoints: 10, maximumBytes: 10000 })).toThrow('integrity')
  })
  it('reports clock skew and missing observations without converting unknown values to zero', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'first')
    expect(reportShadowRun(store, run.id, { maximumPoints: 10, maximumBytes: 10000 }).issues).toContain('no_observations')
    const lease = store.claim(run.id, 10000, () => undefined)
    store.append(lease, sample())
    advance(-1)
    expect(reportShadowRun(store, run.id, { maximumPoints: 10, maximumBytes: 10000 })).toMatchObject({
      health: 'issues_detected', issues: expect.arrayContaining(['clock_skew']), metrics: [{ candidate: { coverage: null } }],
    })
  })
  it('bridges typed worker readings with exact active identity and preserves missing data and limitations', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create(plan, 'first').id, 1000, () => undefined)
    const sink = new ShadowWorkerSink(store, lease)
    const output = { sequence: 0, inputHash: hash, side: 'left', sourceSide: 'right', timestampBasis: 'firmware_event_time_v1', timestampMs: start, configHash: hash,
      readings: [{ metric: 'heart_rate', unit: 'bpm', windowMs: null, value: 60, quality: 1 },
        { metric: 'breathing_rate', unit: 'breaths/min', windowMs: null, value: 15, quality: 1 },
        { metric: 'window_ibi_variability_v1', unit: 'ms', windowMs: 300000, value: null, quality: 0 }],
      flags: null, limitations: ['cold_start_without_serialized_state'] }
    const active = { side: 'left', timestampMs: start, configHash: plan.activeConfigHash, readings: output.readings }
    for (const changed of [{ ...active, side: 'right' }, { ...active, timestampMs: start + 1 }, { ...active, configHash: hash }]) {
      expect(() => sink.append(output, changed)).toThrow('not contemporaneous')
    }
    expect(store.get(lease.runId).point_count).toBe(0)
    expect(sink.append(output, null)).toEqual({ state: 'recorded' })
    expect(sink.append(output, null)).toEqual({ state: 'already_recorded' })
    const snapshot = store.snapshot(lease.runId, { maximumPoints: 10, maximumBytes: 10000 })
    expect(snapshot.samples[0]).toMatchObject({ readings: [{ active: { value: null, quality: 0 }, candidate: { value: 60 } }],
      candidateProvenance: { sourceSide: 'right', limitations: expect.arrayContaining(['missing_contemporaneous_active_reading']) } })
    expect(reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 }).limitations).toContain('cold_start_without_serialized_state')
    advance(1000)
    expect(() => sink.append({ ...output, sequence: 1, timestampMs: start + 1000 }, null)).toThrow('Stale')
  })
  it('retains active-only times so dropped candidate readings reduce reported coverage', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create({ ...plan, joining }, 'joined').id, 10000, () => undefined)
    const join = new ShadowStreamJoin(store, lease)
    for (const offset of [2000, 0, 1000]) join.active(activeOutput(start + offset))
    join.candidate(workerOutput(start + 1000))
    advance(2999)
    expect(join.advance(start + 2999)).toEqual({ emitted: 2, stopped: false })
    advance(1)
    expect(join.advance(start + 3000)).toEqual({ emitted: 1, stopped: false })
    const report = reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 })
    expect(report).toMatchObject({ pairing: { activeOnly: 2, candidateOnly: 0, unknownInputIdentity: 2 },
      metrics: [{ current: { usableCount: 3 }, candidate: { usableCount: 1 }, issues: expect.arrayContaining(['coverage_regression']) }] })
    const points = store.snapshot(lease.runId, { maximumPoints: 10, maximumBytes: 10000 }).samples
    expect(points.map(row => row.timestampMs)).toEqual([start, start + 1000, start + 2000])
    expect(points[0]).toMatchObject({ inputHash: null, inputIdentityKind: 'unavailable', readings: [{ candidate: { value: null } }] })
  })
  it('does not match nearby timestamps and fails explicitly on late or conflicting arrivals', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create({ ...plan, joining }, 'joined').id, 10000, () => undefined)
    const join = new ShadowStreamJoin(store, lease)
    join.active(activeOutput(start))
    join.active(activeOutput(start))
    join.candidate(workerOutput(start + 1))
    advance(1001)
    expect(join.advance(start + 1001).emitted).toBe(2)
    expect(reportShadowRun(store, lease.runId, { maximumPoints: 10, maximumBytes: 10000 }).pairing).toMatchObject({ activeOnly: 1, candidateOnly: 1 })
    expect(() => join.candidate(workerOutput(start))).toThrow('join_late_arrival')
    expect(store.get(lease.runId)).toMatchObject({ state: 'failed', reason: 'join_late_arrival' })
    const nextPlan = { ...plan, startMs: start + 1001, joining }
    const secondLease = store.claim(store.create(nextPlan, 'second').id, 10000, () => undefined)
    const second = new ShadowStreamJoin(store, secondLease)
    second.active(activeOutput(start + 1001))
    const changed = activeOutput(start + 1001)
    changed.readings[0].value = 80
    expect(() => second.active(changed)).toThrow('join_conflicting_duplicate')
  })
  it('bounds pending points and preserves uncertain-write retry identity', () => {
    const { store, advance } = setup()
    const lease = store.claim(store.create({ ...plan, joining: { ...joining, maximumPendingPoints: 1 } }, 'joined').id, 10000, () => undefined)
    const join = new ShadowStreamJoin(store, lease)
    join.active(activeOutput(start))
    join.candidate(workerOutput(start))
    const append = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementationOnce((lease, point) => {
      append(lease, point)
      throw new Error('lost acknowledgment')
    })
    advance(1000)
    expect(() => join.advance(start + 1000)).toThrow('lost acknowledgment')
    expect(store.get(lease.runId).point_count).toBe(1)
    expect(join.advance(start + 1000).emitted).toBe(1)
    expect(store.get(lease.runId).point_count).toBe(1)
    join.active(activeOutput(start + 2000))
    expect(() => join.active(activeOutput(start + 3000))).toThrow('join_queue_quota')
  })
  it('drains final buffered samples during explicit grace without extending the sampling window', () => {
    const { store, advance } = setup()
    const selected = { ...plan, endMs: start + 5000, joining }
    const run = store.create(selected, 'joined')
    const lease = store.claim(run.id, 10000, () => undefined)
    const join = new ShadowStreamJoin(store, lease)
    join.active(activeOutput(start + 4999))
    advance(6000)
    expect(join.advance(start + 6000)).toEqual({ emitted: 1, stopped: false })
    expect(store.get(run.id).point_count).toBe(1)
    store.renew(lease, 10000)
    expect(store.get(run.id).lease_until_ms).toBe(start + 7000)
    advance(1000)
    expect(() => store.renew(lease, 10000)).toThrow('Stale')
  })
  it('enforces byte quotas and terminal states', () => {
    const { store } = setup()
    const lease = store.claim(store.create({ ...plan, maximumBytes: 1 }, 'first').id, 1000, () => undefined)
    expect(store.append(lease, sample()).state).toBe('quota_reached')
    expect(() => store.append(lease, sample())).toThrow('Stale')
    const next = store.claim(store.create(plan, 'second').id, 1000, () => undefined)
    store.finish(next, 'failed', 'processor_failure')
    expect(store.get(next.runId)).toMatchObject({ state: 'failed', reason: 'processor_failure' })
    expect(() => store.renew(next, 1000)).toThrow('Stale')
  })
})

describe('bounded expired shadow recovery', () => {
  it('revokes expired leases while retaining observations and exposing unconfirmed cleanup', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'recover')
    const lease = store.claim(run.id, 1000, () => {})
    store.append(lease, sample())
    advance(1000)
    expect(store.reconcileExpired({ maximumRuns: 10 }).recovered).toEqual([{ runId: run.id, attemptId: lease.attemptId, reason: 'shadow_lease_expired_cleanup_unconfirmed' }])
    expect(store.get(run.id)).toMatchObject({ state: 'failed', point_count: 1, attempt_id: lease.attemptId, workerReceipt: null })
    expect(() => store.append(lease, sample(1))).toThrow(/Stale/)
    expect(() => store.renew(lease, 1000)).toThrow(/Stale/)
    expect(store.reconcileExpired({ maximumRuns: 10 }).recovered).toEqual([])
    const report = reportShadowRun(store, run.id, { maximumPoints: 10, maximumBytes: 10000 })
    expect(report.issues).toContain('worker_cleanup_unconfirmed')
    expect(report.observedSamples).toBe(1)
  })
  it('marks missed pending windows without claiming processor execution', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'missed')
    advance(60000)
    expect(store.reconcileExpired({ maximumRuns: 10 }).recovered).toEqual([{ runId: run.id, attemptId: null, reason: 'shadow_observation_window_missed' }])
    expect(store.get(run.id)).toMatchObject({ state: 'failed', point_count: 0, attempt_id: null })
    const report = reportShadowRun(store, run.id, { maximumPoints: 10, maximumBytes: 10000 })
    expect(report.issues).toContain('observation_window_missed')
    expect(report.issues).not.toContain('processor_failed')
  })
  it('preserves renewed replacement attempts and terminal evidence', () => {
    const { store, advance } = setup()
    const run = store.create(plan, 'replacement'), stopped = store.create({ ...plan, side: 'right' }, 'stopped')
    store.claim(run.id, 1000, () => {})
    store.stop(stopped.id, 'operator')
    advance(1000)
    const replacement = store.claim(run.id, 1000, () => {})
    expect(store.reconcileExpired({ maximumRuns: 10 }).recovered).toEqual([])
    expect(store.get(run.id)).toMatchObject({ state: 'running', attempt_id: replacement.attemptId })
    expect(store.get(stopped.id)).toMatchObject({ state: 'stopped', reason: 'operator' })
  })
  it('advances a bounded keyset scan past future runs without starving later rows', () => {
    const { store, advance } = setup()
    const runs = Array.from({ length: 5 }, (_, index) => store.create({ ...plan, endMs: start + (index % 2 ? 120000 : 60000) }, String(index)))
    advance(60000)
    const recovered: string[] = [], visited: number[] = []
    let cursor: string | undefined
    do {
      const batch = store.reconcileExpired({ maximumRuns: 2, ...(cursor ? { afterId: cursor } : {}) })
      recovered.push(...batch.recovered.map(row => row.runId))
      visited.push(batch.scanned)
      cursor = batch.nextCursor ?? undefined
    } while (cursor)
    expect(visited).toEqual([2, 2, 1])
    expect(recovered.sort()).toEqual([runs[0].id, runs[2].id, runs[4].id].sort())
    expect(() => store.reconcileExpired({ maximumRuns: 101 })).toThrow()
  })
})

it('recovery preserves final drain authority until the actual lease deadline', () => {
  const { store, advance } = setup()
  const run = store.create({ ...plan, joining }, 'draining')
  store.claim(run.id, 100000, () => {})
  advance(61000)
  expect(store.reconcileExpired({ maximumRuns: 10 }).recovered).toEqual([])
  advance(1000)
  expect(store.reconcileExpired({ maximumRuns: 10 }).recovered).toHaveLength(1)
})
it('rolls back the entire recovery batch if a plan fails integrity validation', () => {
  const { db, store, advance } = setup()
  const ids = [store.create(plan, 'one').id, store.create(plan, 'two').id].sort()
  db.prepare('UPDATE biometric_shadow_runs SET plan_hash = \'corrupt\' WHERE id = ?').run(ids[1])
  advance(60000)
  expect(() => store.reconcileExpired({ maximumRuns: 10 })).toThrow(/integrity/)
  expect(store.get(ids[0]).state).toBe('pending')
})

describe('storage policy and integrity guards', () => {
  const receipt = { health: { state: 'completed', reason: 'window_complete', records: 2, outputs: 2, cpu_ms: 1, input_hash: hash,
    counts: { records: 2, accepted_frames: 2, empty_channel_frames: 0, pump_gated_frames: 0, preroll_outputs: 0, scored_outputs: 2 }, limitations: [] },
  inputBytes: 100, outputBytes: 100, peakObservedRssBytes: 1000, rssSamples: 2, maximumObservationGapMs: 100,
  budgets: executable.execution.budgets, memoryScope: 'sum_rss_of_shadow_process_group', exactKernelPeak: false }
  const partial = { kind: 'partial_supervisor_observation', health: null, inputBytes: 100, outputBytes: 100, diagnosticBytes: 0,
    peakObservedRssBytes: 1000, rssSamples: 2, maximumObservationGapMs: 100, budgets: executable.execution.budgets,
    cleanupConfirmed: true, memoryScope: 'sum_rss_of_shadow_process_group', exactKernelPeak: false }
  const oversized = Array.from({ length: 32 }, () => '€'.repeat(200))

  it('pages run listings per side and refuses plans beyond the storage policy', () => {
    const { store } = setup()
    const ids = ['one', 'two', 'three'].map(key => store.create(plan, key).id).sort()
    const first = store.list({ side: 'left', maximumRuns: 2 })
    expect(first.items.map(row => row.id)).toEqual(ids.slice(0, 2))
    expect(first.nextCursor).toBe(ids[1])
    const rest = store.list({ side: 'left', maximumRuns: 2, afterId: ids[1] })
    expect(rest.items.map(row => row.id)).toEqual([ids[2]])
    expect(rest.nextCursor).toBeNull()
    expect(store.list({ side: 'right', maximumRuns: 2 }).items).toEqual([])
    expect(() => store.list({ side: 'left', maximumRuns: 51 })).toThrow()
    expect(() => store.create({ ...plan, maximumPoints: 11 }, 'points')).toThrow('exceeds storage policy')
    expect(() => store.create({ ...plan, maximumBytes: 100001 }, 'bytes')).toThrow('exceeds storage policy')
    expect(() => new ShadowStore(setup().db).create(plan, 'no-policy')).toThrow('storage policy required')
  })

  it('refuses asynchronous admission, windows that pass during admission and claims outside the window', () => {
    const { store, advance } = setup()
    const later = async () => {
      throw new Error('later')
    }
    expect(() => store.create(plan, 'async', later)).toThrow('synchronously')
    expect(store.list({ side: 'left', maximumRuns: 5 }).items).toEqual([])
    const run = store.create(plan, 'claimed')
    expect(() => store.claim(run.id, 1000, later)).toThrow('synchronously')
    const future = store.create({ ...plan, startMs: start + 1000 }, 'future')
    expect(() => store.claim(future.id, 1000, () => {})).toThrow('Outside shadow window')
    const lease = store.claim(run.id, 1000, () => {})
    expect(() => store.claim(run.id, 1000, () => {})).toThrow('Shadow run unavailable')
    expect(store.failExpired(lease, 'early')).toBe(false)
    store.renew(lease, 2000)
    expect(store.get(run.id).lease_until_ms).toBe(start + 2000)
    expect(() => store.finish(lease, 'failed', 'with_receipt', receipt)).toThrow('requires a completed executable plan')
    expect(() => store.create(plan, 'late', () => advance(1))).toThrow('prospective')
    advance(60000)
    expect(() => store.claim(future.id, 1000, () => {})).toThrow('Outside shadow window')
    store.stop(run.id, 'operator')
    expect(() => store.recordPartialReceipt(lease, partial)).toThrow('terminal executable attempt')
  })

  it('detects corrupted receipts, totals and queue authority', () => {
    const { store, db, advance } = setup()
    const run = store.create(executable, 'corrupt')
    const lease = store.claim(run.id, 1000, () => {})
    store.append(lease, sample())
    db.prepare('UPDATE biometric_shadow_runs SET worker_receipt_hash = ? WHERE id = ?').run('x', run.id)
    expect(() => store.get(run.id)).toThrow('receipt integrity')
    db.prepare('UPDATE biometric_shadow_runs SET worker_receipt = ?, worker_receipt_hash = ? WHERE id = ?').run('x'.repeat(16385), 'x', run.id)
    expect(() => store.get(run.id)).toThrow('exceeds storage limit')
    db.prepare('UPDATE biometric_shadow_runs SET worker_receipt = NULL, worker_receipt_hash = NULL, point_count = point_count + 1 WHERE id = ?').run(run.id)
    expect(() => store.snapshot(run.id, { maximumPoints: 10, maximumBytes: 10000 })).toThrow('totals integrity')
    expect(() => store.cursor(run.id)).toThrow('cursor integrity')
    db.prepare('UPDATE biometric_shadow_runs SET point_count = point_count - 1 WHERE id = ?').run(run.id)
    expect(store.cursor(run.id)).toEqual({ nextSequence: 1, lastTimestampMs: start })
    const pending = store.create(executable, 'pending')
    db.prepare('UPDATE biometric_shadow_runs SET attempt_id = ? WHERE id = ?').run('11111111-1111-4111-8111-111111111111', pending.id)
    expect(() => store.pending({ maximumRuns: 10 })).toThrow('Invalid pending shadow authority')
    advance(60000)
    expect(() => store.reconcileExpired({ maximumRuns: 10 })).toThrow('Invalid pending shadow authority')
  })

  it('fences sink and join construction, identity and window mismatches', () => {
    const { store, advance } = setup()
    const run = store.create({ ...plan, joining }, 'joined'), unjoinedRun = store.create({ ...plan, side: 'right' }, 'unjoined')
    const stale = store.claim(run.id, 1000, () => undefined)
    advance(1000)
    const lease = store.claim(run.id, 10000, () => undefined)
    expect(() => new ShadowWorkerSink(store, stale)).toThrow('attempt mismatch')
    expect(() => new ShadowStreamJoin(store, stale)).toThrow('live attempt')
    const unjoined = store.claim(unjoinedRun.id, 10000, () => undefined)
    expect(() => new ShadowStreamJoin(store, unjoined)).toThrow('frozen join policy')
    const sink = new ShadowWorkerSink(store, lease)
    const output = workerOutput(start + 1000)
    expect(() => sink.append({ ...output, side: 'right' }, null)).toThrow('identity mismatch')
    expect(() => sink.append({ ...output, sequence: 5 }, null)).toThrow('identity mismatch')
    const active = { ...activeOutput(start + 1000), inputHash: hash, provenance: { processingRunId: '11111111-1111-4111-8111-111111111111', sourceSide: 'left', generation: 1, manifestHash: hash } }
    expect(sink.append(output, active)).toEqual({ state: 'recorded' })
    expect(store.snapshot(run.id, { maximumPoints: 10, maximumBytes: 10000 }).samples[0]).toMatchObject({ activeProvenance: active.provenance,
      readings: [{ active: { value: 60, quality: 1 } }], candidateProvenance: { timestampBasis: 'firmware_event_time_v1', limitations: [] } })
    const join = new ShadowStreamJoin(store, lease)
    expect(() => join.active({ ...activeOutput(start + 2000), side: 'right' })).toThrow('join_identity_mismatch')
    expect(store.get(run.id).state).toBe('failed')
    expect(() => join.active(activeOutput(start + 2000))).toThrow('closed')
    expect(() => join.advance(start + 2000)).toThrow('closed')
  })

  it('records active-only identity and fails on metric gaps or clock regression', () => {
    const { store, advance } = setup()
    const windowed = { ...plan, joining, metrics: ['heart_rate', 'window_ibi_variability_v1'], windowIbiWindowMs: 300000 }
    const lease = store.claim(store.create(windowed, 'windowed').id, 10000, () => undefined)
    const mismatchedRun = store.create({ ...windowed, side: 'right', windowIbiWindowMs: 60000 }, 'mismatched')
    const join = new ShadowStreamJoin(store, lease)
    join.active({ ...activeOutput(start), inputHash: hash })
    advance(1000)
    expect(join.advance(start + 1000)).toEqual({ emitted: 1, stopped: false })
    expect(store.snapshot(lease.runId, { maximumPoints: 10, maximumBytes: 10000 }).samples[0]).toMatchObject({ inputIdentityKind: 'active_provenance', inputHash: hash })
    expect(() => join.advance(start + 999)).toThrow('join_clock_regression')
    const mismatched = store.claim(mismatchedRun.id, 10000, () => undefined)
    const output = { ...workerOutput(start + 1000), side: 'right' }
    expect(() => new ShadowWorkerSink(store, mismatched).append(output, null)).toThrow('window mismatch')
    expect(() => new ShadowStreamJoin(store, mismatched).candidate(output)).toThrow('join_metric_mismatch')
  })

  it('pages the pending queue past non-executable plans', () => {
    const { store } = setup()
    const ids = [store.create(plan, 'legacy-one').id, store.create(plan, 'legacy-two').id].sort()
    expect(store.pending({ maximumRuns: 1 })).toEqual({ run: null, nextCursor: ids[0] })
    expect(store.pending({ maximumRuns: 1, afterId: ids[0] })).toEqual({ run: null, nextCursor: null })
  })

  it('verifies stored receipts against the terminal state and bounds their size', () => {
    const { store, db } = setup()
    const completed = store.create(executable, 'completed')
    const lease = store.claim(completed.id, 1000, () => {})
    expect(() => store.finish(lease, 'completed', 'done', { ...receipt, health: { ...receipt.health, limitations: oversized } })).toThrow('exceeds storage limit')
    store.finish(lease, 'completed', 'done', receipt)
    expect(store.get(completed.id).workerReceipt).toMatchObject({ schema: 'biometric-shadow-receipt-v1', receipt })
    db.prepare('UPDATE biometric_shadow_runs SET ended_at_ms = ended_at_ms + 1 WHERE id = ?').run(completed.id)
    expect(() => store.get(completed.id)).toThrow('receipt integrity')
    const stopped = store.create({ ...executable, side: 'right' }, 'stopped')
    const stoppedLease = store.claim(stopped.id, 1000, () => {})
    store.stop(stopped.id, 'operator')
    expect(() => store.recordPartialReceipt(stoppedLease, { ...partial, health: { ...receipt.health, state: 'stopped', limitations: oversized } })).toThrow('exceeds storage limit')
    expect(store.recordPartialReceipt(stoppedLease, partial)).toBe(true)
    db.prepare('UPDATE biometric_shadow_runs SET state = \'completed\' WHERE id = ?').run(stopped.id)
    expect(() => store.get(stopped.id)).toThrow('receipt integrity')
  })
})
