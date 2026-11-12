import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownerFixture } from '../../tests/ownerFixture'
import { qualificationSchema } from '../../owner-contract'
import { ExperimentAdmissions, type ExperimentAdmissionDeps } from '../admissions'
import { ExperimentApplicationStore } from '../applications'
import { EXECUTION_REVIEW_MS } from '../admission-contract'
import { createScheduledExperimentPlan, experimentNights, experimentPlanHash } from '../plan'
import { experimentAuthorityRequestId } from '../exposure'
import { resolveExperimentSchedule } from '../schedule'
import { ComfortExperimentStore } from '../store'
import { context, fixtureSchedule } from './fixture'

const fixtures: ReturnType<typeof ownerFixture>[] = []
const scopeHash = '1'.repeat(64)
const principal = { kind: 'personal' as const, deviceId: randomUUID() }
const interruptionHash = '0'.repeat(64)
async function fixture() {
  const test = ownerFixture()
  fixtures.push(test)
  await test.ready()
  const schedule = fixtureSchedule()
  schedule.powers.forEach((row) => {
    row.onTemperature = 75
  })
  const plan = createScheduledExperimentPlan({ ...context, baselineF: 75, minimumF: 70, maximumF: 95 }, 74,
    resolveExperimentSchedule(schedule, '2026-11-13', test.now()), test.now())
  const plans = new ComfortExperimentStore(test.database, context.subjectKey, test.now)
  plans.create(plan)
  const proof = await test.owner.experimentEvidence('left')
  const deps: ExperimentAdmissionDeps = {
    database: test.database, now: test.now,
    validate: (review, includeSource) => { for (const zone of review.zones) test.owner.assertExperimentEvidence(zone.side, zone.evidence, includeSource) },
    suspend: zone => test.owner.suspendForExperiment(zone.side, zone.evidence),
    revokeLease: test.deps.revokeLease,
  }
  const admissions = new ExperimentAdmissions(deps)
  const prepare = () => admissions.prepare(context.subjectKey, scopeHash, plan.id, [{ side: 'left', evidence: proof, interruptionHash }], () => {}, principal)
  const confirm = (id: string, check = () => {}) => admissions.confirm(context.subjectKey, scopeHash, id, experimentPlanHash(plan), check)
  return { ...test, plans, plan, proof, deps, admissions, prepare, confirm }
}
afterEach(() => fixtures.splice(0).forEach(value => value.database.close()))

/** Duplicate synthetic observations into the other test zone, then recompute its own reviews. */
async function syntheticRightQualification(test: Awaited<ReturnType<typeof fixture>>) {
  test.store.commit('right', test.store.read('left'))
  const qualifications = test.database.prepare('SELECT record FROM comfort_qualifications WHERE side = ?').all('left') as { record: string }[]
  for (const row of qualifications) {
    const record = { ...qualificationSchema.parse(JSON.parse(row.record)), id: randomUUID() }
    test.database.prepare('INSERT INTO comfort_qualifications (id, side, kind, record) VALUES (?, ?, ?, ?)')
      .run(record.id, 'right', record.kind, JSON.stringify(record))
  }
  test.database.prepare(`INSERT INTO comfort_events (side, observed_at, event, report_id)
    SELECT 'right', observed_at, event, report_id FROM comfort_events WHERE side = 'left' AND report_id IS NOT NULL`).run()
  for (const night of test.proof.nights) {
    const detail = await test.reports.detail('right', night.summary.id)
    await test.reports.review({ side: 'right', id: night.summary.id, digest: detail.summary.digest,
      expectedReviewId: null, outcome: 'reviewed', confirmedActualNight: true, note: 'Synthetic right-zone fixture only.' })
  }
  return test.owner.experimentEvidence('right')
}

describe('reviewed experiment admission with real qualification and migrated storage', () => {
  it('keeps planning inert, commits one grant durably, and reconciles a lost confirmation', async () => {
    const test = await fixture(), state = test.store.read('left')
    const review = test.prepare()
    expect(test.admissions.current('left')).toBeNull()
    expect(test.store.read('left')).toEqual(state)
    const synchronization: number[] = [], suspend = test.deps.suspend
    test.deps.suspend = (zone) => {
      synchronization.push(test.database.pragma('synchronous', { simple: true }) as number)
      suspend(zone)
    }
    const granted = test.confirm(review.id)
    expect(synchronization).toEqual([2])
    expect(test.admissions.current('left')?.admission).toMatchObject({ revision: review.id, sides: ['left'], planHash: review.planHash })
    expect(test.admissions.current('right')).toBeNull()
    test.refresh(test.now() + EXECUTION_REVIEW_MS)
    expect(test.confirm(review.id)).toEqual(granted)
    expect(synchronization).toHaveLength(1)
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_admissions').get()).toEqual({ count: 1 })
  })

  it('cannot confirm another account or browser session review', async () => {
    const test = await fixture(), review = test.prepare()
    expect(() => test.admissions.confirm('f'.repeat(64), scopeHash, review.id, review.planHash, () => {})).toThrow('current account')
    expect(() => test.admissions.confirm(context.subjectKey, 'f'.repeat(64), review.id, review.planHash, () => {})).toThrow('current account')
    expect(test.admissions.current('left')).toBeNull()
  })

  it.each(['expiry', 'clock', 'source', 'stopped', 'hash', 'authorization'])(
    'rejects confirmation after %s changes without reserving a zone', async (reason) => {
      const test = await fixture(), review = test.prepare()
      if (reason === 'expiry') test.refresh(test.now() + EXECUTION_REVIEW_MS)
      if (reason === 'clock') test.refresh(test.now() - 1)
      if (reason === 'source') test.database.prepare('DELETE FROM comfort_events WHERE report_id = ?').run(test.proof.nights[0].summary.id)
      if (reason === 'stopped') {
        const record = test.plans.read(test.plan.id)
        if (!record) throw new Error('Missing fixture record')
        test.plans.stop(test.plan.id, record.revision)
      }
      expect(() => test.admissions.confirm(context.subjectKey, scopeHash, review.id,
        reason === 'hash' ? 'f'.repeat(64) : review.planHash, () => {
          if (reason === 'authorization') throw new Error('account changed')
        })).toThrow()
      expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_zone_claims').get()).toEqual({ count: 0 })
    },
  )

  it('rolls back grant, claims and adaptation suspension together on late authority loss', async () => {
    const test = await fixture()
    const active = await test.owner.prepare({ side: 'left', purpose: 'activation', kind: null })
    await test.owner.confirm({ side: 'left', id: active.id, confirmed: true, note: 'Synthetic qualification only.' })
    const review = test.prepare(), previous = test.store.read('left')
    let checks = 0
    expect(() => test.confirm(review.id, () => {
      if (++checks === 2) throw new Error('account revoked before commit')
    })).toThrow('revoked')
    expect(test.store.read('left')).toEqual(previous)
    expect(test.owner.admission('left', previous)).not.toBeNull()
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_zone_claims').get()).toEqual({ count: 0 })
    expect(test.database.prepare('SELECT consumed_at FROM comfort_experiment_execution_reviews WHERE id = ?').get(review.id)).toEqual({ consumed_at: null })
  })

  it('requires explicit cancellation before a different review can claim the same zone', async () => {
    const test = await fixture(), first = test.prepare(), second = test.prepare()
    test.confirm(first.id)
    expect(() => test.confirm(second.id)).toThrow('still owns')
    test.admissions.revoke(context.subjectKey, first.id, 'Stopped by the sleeper', () => {})
    expect(test.confirm(first.id).revokedAt).toBe(test.now())
    expect(test.admissions.current('left')).toBeNull()
    test.confirm(second.id)
    expect(test.admissions.current('left')?.admission.revision).toBe(second.id)
  })

  it('does not let another account revoke a grant and does not restore revoked adaptation', async () => {
    const test = await fixture(), review = test.prepare()
    test.confirm(review.id)
    expect(() => test.admissions.revoke('f'.repeat(64), review.id, 'Wrong account', () => {})).toThrow('another account')
    expect(test.admissions.current('left')).not.toBeNull()
    test.admissions.revoke(context.subjectKey, review.id, 'Stopped', () => {})
    expect(test.admissions.current('left')).toBeNull()
    expect(test.store.read('left').config.mode).toBe('preview')
  })

  it('does not revoke a newer zone lease when cancelling an expired retained admission', async () => {
    const test = await fixture(), first = test.prepare()
    const older = test.confirm(first.id)
    test.refresh(older.endsAt + 1)
    // Isolate zone ownership here; source qualification has separate real-store tests above.
    test.deps.validate = () => {}
    test.deps.suspend = () => {}
    const current = test.plans.read(test.plan.id)
    if (!current) throw new Error('Missing fixture plan')
    test.plans.stop(test.plan.id, current.revision)
    const laterPlan = createScheduledExperimentPlan(test.plan.context, 74,
      resolveExperimentSchedule(fixtureSchedule(), new Date(test.now()).toISOString().slice(0, 10), test.now()), test.now())
    test.plans.create(laterPlan)
    const later = test.admissions.prepare(context.subjectKey, scopeHash, laterPlan.id,
      [{ side: 'left', evidence: test.proof, interruptionHash }], () => {}, principal)
    test.admissions.confirm(context.subjectKey, scopeHash, later.id, experimentPlanHash(laterPlan), () => {})
    vi.mocked(test.deps.revokeLease).mockClear()
    test.admissions.revoke(context.subjectKey, first.id, 'Cancel old retained admission', () => {})
    expect(test.deps.revokeLease).not.toHaveBeenCalled()
    expect(test.admissions.claim('left')?.review.id).toBe(later.id)
  })

  it('retains uncertain hardware intent from a prior experiment instead of granting a retry', async () => {
    const test = await fixture(), review = test.prepare(), before = test.now() - 8 * 86_400_000
    const older = createScheduledExperimentPlan({ ...context, subjectKey: 'c'.repeat(64) }, 69,
      resolveExperimentSchedule(fixtureSchedule(), '2026-11-03', before), before)
    new ComfortExperimentStore(test.database, older.context.subjectKey, () => before).create(older)
    if (older.version !== 2) throw new Error('Expected scheduled fixture')
    const at = older.schedule.windows[0].windowStart + 1000, night = experimentNights(older)[0]
    const journal = new ExperimentApplicationStore(test.database, () => at)
    const reservation = { id: randomUUID(), planId: older.id, planHash: experimentPlanHash(older), admissionRevision: randomUUID(),
      side: 'left' as const, nightDate: night.date, requestId: experimentAuthorityRequestId(older, night.date),
      targetF: night.targetF, previousF: 70, reservedAt: at }
    journal.reserve(reservation, () => {})
    journal.finish(reservation, null)
    expect(() => test.confirm(review.id)).toThrow('uncertain experiment application')
    expect(test.admissions.current('left')).toBeNull()
  })

  it('withholds corrupted grants and changed qualification without recreating them', async () => {
    const test = await fixture(), review = test.prepare()
    test.confirm(review.id)
    test.setEnabled(false)
    expect(test.admissions.current('left')).toBeNull()
    test.setEnabled(true)
    const record = test.database.prepare('SELECT record FROM comfort_experiment_admissions WHERE id = ?').get(review.id) as { record: string }
    const changed = JSON.parse(record.record)
    changed.endsAt++
    test.database.prepare('UPDATE comfort_experiment_admissions SET ends_at = ?, record = ? WHERE id = ?').run(changed.endsAt, JSON.stringify(changed), review.id)
    expect(test.admissions.current('left')).toBeNull()
    expect(() => test.confirm(review.id)).toThrow('scheduled plan')
  })

  it('bounds pending reviews and rejects malformed physical-zone proofs before persistence', async () => {
    const test = await fixture()
    expect(() => test.admissions.prepare(context.subjectKey, scopeHash, test.plan.id,
      [{ side: 'left', evidence: test.proof, interruptionHash }, { side: 'left', evidence: test.proof, interruptionHash }], () => {}, principal)).toThrow()
    for (let index = 0; index < 8; index++) test.prepare()
    expect(() => test.prepare()).toThrow('Several activation reviews')
    test.refresh(test.now() + EXECUTION_REVIEW_MS)
    expect(() => test.prepare()).not.toThrow()
  })

  it('commits both solo-anywhere zones together or rolls back both when the second zone fails', async () => {
    const test = await fixture(), right = await syntheticRightQualification(test)
    const active = await test.owner.prepare({ side: 'left', purpose: 'activation', kind: null })
    await test.owner.confirm({ side: 'left', id: active.id, confirmed: true, note: 'Synthetic test only.' })
    const review = test.admissions.prepare(context.subjectKey, scopeHash, test.plan.id,
      [{ side: 'left', evidence: test.proof, interruptionHash }, { side: 'right', evidence: right, interruptionHash }], () => {}, principal)
    const beforeLeft = test.store.read('left'), beforeRight = test.store.read('right'), suspend = test.deps.suspend
    test.deps.suspend = (zone) => {
      suspend(zone)
      if (zone.side === 'right') throw new Error('second zone unavailable')
    }
    expect(() => test.confirm(review.id)).toThrow('second zone')
    expect(test.store.read('left')).toEqual(beforeLeft)
    expect(test.store.read('right')).toEqual(beforeRight)
    expect(test.admissions.current('left')).toBeNull()
    expect(test.admissions.current('right')).toBeNull()
    test.deps.suspend = suspend
    test.confirm(review.id)
    expect(test.admissions.current('left')?.admission.sides).toEqual(['left', 'right'])
    expect(test.admissions.current('right')?.admission.revision).toBe(review.id)
    const revoke = vi.fn()
    test.deps.revokeLease = revoke
    test.admissions.revoke(context.subjectKey, review.id, 'Stopped whole-bed comparison', () => {})
    expect(revoke.mock.calls).toEqual([['left'], ['right']])
    expect(test.admissions.current('right')).toBeNull()
  })

  it('keeps two subject-scoped zone claims independent when one revokes its comparison', async () => {
    const test = await fixture(), right = await syntheticRightQualification(test), left = test.prepare()
    test.confirm(left.id)
    const other = { ...test.plan, id: randomUUID(), context: { ...test.plan.context, subjectKey: 'e'.repeat(64) } }
    new ComfortExperimentStore(test.database, other.context.subjectKey, test.now).create(other)
    const review = test.admissions.prepare(other.context.subjectKey, scopeHash, other.id, [{ side: 'right', evidence: right, interruptionHash }], () => {}, principal)
    test.admissions.confirm(other.context.subjectKey, scopeHash, review.id, review.planHash, () => {})
    test.admissions.revoke(other.context.subjectKey, review.id, 'Stopped right comparison', () => {})
    expect(test.admissions.current('left')?.admission.revision).toBe(left.id)
    expect(test.admissions.current('right')).toBeNull()
  })
})
