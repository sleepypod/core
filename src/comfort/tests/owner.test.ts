import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createComfortOwner } from '../owner'
import { ownerConfirmSchema, ownerPrepareSchema } from '../owner-contract'
import { ownerFixture } from './ownerFixture'

const fixtures: ReturnType<typeof ownerFixture>[] = []
function fixture() {
  const value = ownerFixture()
  fixtures.push(value)
  return value
}
afterEach(() => fixtures.splice(0).forEach(value => value.database.close()))

describe('owner qualification and thermal activation', () => {
  it('cannot activate saved Active settings, user-uploaded evidence, missing production identity or zero nights', async () => {
    const { owner, store, configure, setIdentifiable } = fixture()
    expect(ownerPrepareSchema.safeParse({ side: 'left', purpose: 'activation', kind: null, nights: 7 }).success).toBe(false)
    expect(ownerConfirmSchema.safeParse({ side: 'left', id: randomUUID(), confirmed: true, note: '', snapshot: {} }).success).toBe(false)
    configure({ config: { ...store.read('left').config, mode: 'active' } })
    expect(owner.admission('left', store.read('left'))).toBeNull()
    await expect(owner.prepare({ side: 'left', purpose: 'activation', kind: null })).rejects.toThrow()
    setIdentifiable(false)
    expect((await owner.status('left')).identity).toBeNull()
    await expect(owner.prepare({ side: 'left', purpose: 'qualification', kind: 'presence_empty' })).rejects.toThrow('identity')
  })

  it('records physical owner observations separately from fresh sensor and acknowledgment evidence', async () => {
    const value = fixture()
    await value.qualifyAll()
    const status = await value.owner.status('left')
    expect(status.qualifications).toHaveLength(6)
    expect(status.canActivate).toBe(false)
    expect(status.nights).toEqual([])
    expect(status.qualifications.find(record => record.kind === 'warming')?.evidence).toMatchObject({ powered: true, targetF: 77 })
    expect(value.store.read('left').lastAppliedAt).toBe(0)
  })

  it('requires correct presence, fresh idle telemetry and attended temperature evidence before a review', async () => {
    const value = fixture()
    await expect(value.owner.prepare({ side: 'left', purpose: 'qualification', kind: 'presence_occupied' })).rejects.toThrow('occupied')
    await expect(value.owner.prepare({ side: 'left', purpose: 'qualification', kind: 'warming' })).rejects.toThrow('manual temperature')
    value.context.device.observedAt = value.now() - 16_000
    await expect(value.qualify('presence_empty')).rejects.toThrow('fresh firmware')
    value.refresh()
    value.context.device.baseMoving = null
    await expect(value.qualify('presence_empty')).rejects.toThrow('idle')
  })

  it('expires reviews, rejects cross-side confirmation and rechecks meaningful observations despite newer poll times', async () => {
    const value = fixture()
    const review = await value.owner.prepare({ side: 'left', purpose: 'qualification', kind: 'presence_empty' })
    await expect(value.owner.confirm({ side: 'right', id: review.id, confirmed: true, note: '' })).rejects.toThrow('not found')
    value.refresh(value.now() + 1000)
    await value.owner.confirm({ side: 'left', id: review.id, confirmed: true, note: 'Empty side observed' })
    await value.owner.confirm({ side: 'left', id: review.id, confirmed: true, note: 'Lost reply retry' })
    expect((await value.owner.status('left')).qualifications).toHaveLength(1)
    const stale = await value.owner.prepare({ side: 'left', purpose: 'qualification', kind: 'presence_empty' })
    value.refresh(value.now() + 60_000)
    await expect(value.owner.confirm({ side: 'left', id: stale.id, confirmed: true, note: '' })).rejects.toThrow('expired')
    const changed = await value.owner.prepare({ side: 'left', purpose: 'qualification', kind: 'presence_empty' })
    value.context.device.targetF = 76
    await expect(value.owner.confirm({ side: 'left', id: changed.id, confirmed: true, note: '' })).rejects.toThrow('changed')
  })

  it('admits only after all checks and seven matching source-backed eligible nights, and retains evidence after source retention', async () => {
    const value = fixture()
    await value.ready()
    expect(await value.owner.status('left')).toMatchObject({ canActivate: true, active: false, reasons: [] })
    const review = await value.owner.prepare({ side: 'left', purpose: 'activation', kind: null })
    await value.owner.confirm({ side: 'left', id: review.id, confirmed: true, note: 'Activate bounded thermal adjustments' })
    expect(value.store.read('left').config.mode).toBe('active')
    expect(value.owner.admission('left', value.store.read('left'))?.revision).toBe(review.id)
    value.database.exec('DELETE FROM comfort_events')
    const restarted = createComfortOwner(value.deps)
    expect(restarted.admission('left', value.store.read('left'))?.revision).toBe(review.id)
    expect(value.store.read('left').lastAppliedAt).toBe(0)
    value.refresh(value.now() + 181 * 86_400_000)
    await value.night(1)
    expect((await restarted.status('left')).nights).toHaveLength(7)
    expect(restarted.admission('left', value.store.read('left'))?.revision).toBe(review.id)
    value.setEnabled(false)
    expect(restarted.admission('left', value.store.read('left'))).toBeNull()
    value.setEnabled(true)
    value.setRunning(false)
    expect(restarted.admission('left', value.store.read('left'))).toBeNull()
  })

  it.each([
    { eligible: false }, { hardware: null }, { hardware: 'e'.repeat(64) }, { build: 'f'.repeat(40) }, { policy: { maximumF: 94 } },
  ])('does not qualify a reviewed night with incompatible or withheld evidence: %j', async (change) => {
    const value = fixture()
    await value.night(1, change)
    expect((await value.reports.list('left')).ownerConfirmedNights).toBe(1)
    expect((await value.owner.status('left')).nights).toHaveLength(0)
  })

  it('rechecks the exact night source before committing activation and rolls all writes back on failure', async () => {
    const value = fixture()
    await value.ready()
    const review = await value.owner.prepare({ side: 'left', purpose: 'activation', kind: null })
    value.database.exec('CREATE TRIGGER reject_activation BEFORE INSERT ON comfort_activations BEGIN SELECT RAISE(ABORT, \'synthetic disk failure\'); END')
    await expect(value.owner.confirm({ side: 'left', id: review.id, confirmed: true, note: '' })).rejects.toThrow('disk failure')
    expect(value.store.read('left').config.mode).toBe('preview')
    expect(value.database.prepare('SELECT consumed_at FROM comfort_owner_reviews WHERE id = ?').get(review.id)).toEqual({ consumed_at: null })
    value.database.exec('DROP TRIGGER reject_activation')
    value.database.exec('UPDATE comfort_events SET event = replace(event, \'Synthetic preview.\', \'Changed after review.\') WHERE id = (SELECT MIN(id) FROM comfort_events)')
    await expect(value.owner.confirm({ side: 'left', id: review.id, confirmed: true, note: '' })).rejects.toThrow('source changed')
    expect(value.store.read('left').config.mode).toBe('preview')
  })

  it('withdraws a grant on identity changes, review changes or owner retest, without enabling other rules', async () => {
    const value = fixture()
    await value.ready()
    const review = await value.owner.prepare({ side: 'left', purpose: 'activation', kind: null })
    await value.owner.confirm({ side: 'left', id: review.id, confirmed: true, note: '' })
    for (const field of ['hardware', 'calibration', 'schedule', 'build'] as const) {
      const before = value.identity[field]
      value.identity[field] = 'f'.repeat(field === 'build' ? 40 : 64)
      expect(value.owner.admission('left', value.store.read('left'))).toBeNull()
      value.identity[field] = before
    }
    const original = value.store.read('left').config
    value.configure({ config: { ...original, maximumF: 94 } })
    expect(value.owner.admission('left', value.store.read('left'))).toBeNull()
    value.configure({ config: original })
    expect(value.owner.admission('left', value.store.read('left'))).not.toBeNull()
    const night = review.snapshot.nights[0]
    await value.reports.review({ side: 'left', id: night.summary.id, digest: night.summary.digest, expectedReviewId: night.reviewId,
      outcome: 'needs_retest', confirmedActualNight: false, note: 'Observation requires retest' })
    expect(value.owner.admission('left', value.store.read('left'))).toBeNull()
    const check = review.snapshot.qualifications[0]
    await value.owner.retest('left', check.kind, check.id)
    expect(value.store.read('left').config.mode).toBe('preview')
    expect(value.deps.revokeLease).toHaveBeenCalledWith('left')
    await expect(value.owner.retest('left', check.kind, check.id)).rejects.toThrow('changed')
  })

  it('preserves uncertain application evidence and returns to Preview without declaring success or replaying', async () => {
    const value = fixture()
    const application = { requestId: randomUUID(), segment: 'night', targetF: 74, previousF: 75, createdAt: value.now() - 1000,
      reservedAt: value.now() - 1000, finishedAt: null, receiptId: null, outcome: 'unknown' as const }
    value.configure({ application, config: { ...value.store.read('left').config, mode: 'active' } })
    const review = await value.owner.prepare({ side: 'left', purpose: 'resolution', kind: null })
    await value.owner.confirm({ side: 'left', id: review.id, confirmed: true, note: 'Observed current target; unknown old result remains unknown.' })
    expect(value.store.read('left')).toMatchObject({ config: { mode: 'preview' }, lastAppliedAt: 0, lastTargetF: null,
      pausedUntil: value.now() + 6 * 3_600_000 })
    expect(value.store.read('left').application).toBeUndefined()
    const saved = value.database.prepare('SELECT snapshot FROM comfort_resolutions').get() as { snapshot: string }
    expect(JSON.parse(saved.snapshot).application).toEqual(application)
    const later = { ...application, requestId: randomUUID() }
    value.configure({ application: later })
    await value.owner.confirm({ side: 'left', id: review.id, confirmed: true, note: '' })
    expect(value.store.read('left').application).toEqual(later)
  })
})
