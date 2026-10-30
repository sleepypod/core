import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BedtimeDraft } from '@/src/lib/bedtimeRoutines'
import { replaceBedtimeRoutineBatch } from '@/src/server/bedtimeRoutineTransaction'
import { ArrangementReviewService } from '../arrangementReviews'
import { arrangementReviewSchema } from '../arrangementContract'
import { householdHttp } from '../http'
import { personalRuntimeFixture } from './runtimeFixture'

let fixture: ReturnType<typeof personalRuntimeFixture>, service: ArrangementReviewService, enabled: boolean
const night: BedtimeDraft = {
  power: { onTime: '22:00', offTime: '07:15', onTemperature: 70, enabled: true, endAction: 'maintain' }, temperatures: [],
  alarm: { time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 20, alarmTemperature: 105, enabled: true,
    wakeWindow: 0, snoozeDuration: 540, snoozeTaper: 30 }, notes: 'Owner private operating routine',
}
const context = (key = fixture.ownerKey) => {
  const session = fixture.identities.session(key)
  return { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision }
}
function preferences(key: string, temperature: number) {
  const saved = fixture.identities.preferences(key)
  fixture.identities.updatePreferences(key, { ...context(key), expectedRevision: saved.revision,
    preferences: { ...saved.preferences, preferredTemperatureF: temperature, comfort: temperature === 70 ? 'warm_sleeper' : 'balanced' } })
}
function draft(key: string, temperature: number) {
  fixture.identities.updateRoutines(key, { ...context(key), expectedRevision: fixture.identities.routines(key).revision,
    routines: [{ dayOfWeek: 'friday', draft: { ...night, power: { ...night.power, onTemperature: temperature },
      alarm: null, notes: temperature === 82 ? 'Partner private draft' : 'Unpublished owner draft' } }] })
}
const propose = () => service.propose(fixture.ownerKey, { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
const approval = (reviewId: string, key = fixture.ownerKey) => ({ ...context(key), version: 1, reviewId,
  issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000,
  confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
const operatingRows = () => ['device_settings', 'side_settings', 'households', 'household_accounts', 'bedtime_routines',
  'power_schedules', 'temperature_schedules', 'alarm_schedules', 'household_attribution_epochs', 'household_privacy_boundary']
  .map(table => fixture.database.prepare(`SELECT * FROM ${table}`).all())

beforeEach(() => {
  fixture = personalRuntimeFixture()
  enabled = true
  service = new ArrangementReviewService({ database: fixture.database, identities: fixture.identities,
    enabled: () => enabled, now: () => fixture.clock.now })
  preferences(fixture.ownerKey, 70)
  preferences(fixture.memberKey, 82)
  draft(fixture.memberKey, 82)
  draft(fixture.ownerKey, 90)
  replaceBedtimeRoutineBatch(fixture.database, [{ side: 'left', changes: [
    { dayOfWeek: 'sunday', expectedRevision: null, replacement: night },
    { dayOfWeek: 'friday', expectedRevision: null, replacement: { ...night, power: { ...night.power, enabled: false } } },
  ] }])
})
afterEach(() => fixture.database.close())

describe('independent shared-arrangement review', () => {
  it('preserves the operating owner week and projects only each person’s private plan', () => {
    const before = operatingRows()
    const owner = propose()
    const member = service.get(fixture.memberKey, owner.reviewId)
    expect(arrangementReviewSchema.parse(owner)).toEqual(owner)
    expect(owner.self).toMatchObject({ proposedSide: 'right', routineSource: 'preserved_operating_week', preferences: { preferredTemperatureF: 70 } })
    const sunday = owner.self.week.find(entry => entry.dayOfWeek === 'sunday')
    expect(sunday?.draft).toEqual(night)
    expect(owner.self.week.find(entry => entry.dayOfWeek === 'friday')?.draft.power.enabled).toBe(false)
    expect(member.self).toMatchObject({ proposedSide: 'left', assignmentAtReview: 'unassigned', routineSource: 'own_private_draft' })
    expect(member.self.week[0].draft).toMatchObject({ power: { onTemperature: 82 }, alarm: null })
    expect(JSON.stringify(owner)).not.toContain('Partner private draft')
    expect(JSON.stringify(member)).not.toContain('Owner private operating routine')
    expect(Object.keys(owner.partner).sort()).toEqual(['approved', 'displayName', 'proposedSide'])
    expect(JSON.stringify(owner)).not.toContain('Unpublished owner draft')
    expect(operatingRows()).toEqual(before)
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('needs two separately authenticated approvals and leaves the operating bed unchanged', () => {
    const before = operatingRows()
    const review = propose()
    const ownerInput = approval(review.reviewId)
    const owner = service.approve(fixture.ownerKey, ownerInput)
    expect(owner).toMatchObject({ state: 'awaiting_approval', self: { approved: true }, partner: { approved: false }, canApprove: false, canActivate: false })
    expect(service.approve(fixture.ownerKey, ownerInput)).toEqual(owner)
    const memberInput = approval(review.reviewId, fixture.memberKey)
    const member = service.approve(fixture.memberKey, memberInput)
    expect(member).toMatchObject({ state: 'approved_for_separate_activation', canActivate: false, effect: 'review_only_bed_unchanged' })
    expect(service.latest(fixture.ownerKey)?.state).toBe('approved_for_separate_activation')
    expect(operatingRows()).toEqual(before)
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('reconciles proposal and approval outcomes after restarting without extending expiry', () => {
    const input = { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true }
    const review = service.propose(fixture.ownerKey, input)
    const consent = approval(review.reviewId)
    service.approve(fixture.ownerKey, consent)
    fixture.clock.now += 60_000
    service = new ArrangementReviewService({ database: fixture.database, identities: fixture.identities, enabled: () => enabled, now: () => fixture.clock.now })
    expect(service.propose(fixture.ownerKey, input)).toMatchObject({ reviewId: review.reviewId, expiresAt: review.expiresAt, self: { approved: true } })
    expect(service.approve(fixture.ownerKey, consent).self.approved).toBe(true)
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_arrangement_reviews').get()).toEqual({ count: 1 })
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_arrangement_approvals').get()).toEqual({ count: 1 })
  })

  it.each(['live_week', 'member_draft', 'owner_preferences', 'member_preferences', 'timezone', 'physical', 'assignment', 'membership', 'session', 'revoked_approval'] as const)(
    'invalidates approval after %s changes without applying the stored plan', (change) => {
      const review = propose()
      service.approve(fixture.ownerKey, approval(review.reviewId))
      if (change === 'live_week') {
        const current = fixture.database.prepare('SELECT configuration FROM bedtime_routines WHERE side = \'left\' AND day_of_week = \'sunday\'').get() as { configuration: string }
        fixture.database.prepare('UPDATE bedtime_routines SET configuration = ? WHERE side = \'left\' AND day_of_week = \'sunday\'')
          .run(JSON.stringify({ ...JSON.parse(current.configuration), notes: 'Changed elsewhere' }))
      }
      if (change === 'member_draft') draft(fixture.memberKey, 81)
      if (change === 'owner_preferences') preferences(fixture.ownerKey, 69)
      if (change === 'member_preferences') preferences(fixture.memberKey, 81)
      if (change === 'timezone') fixture.database.exec('UPDATE device_settings SET timezone = \'America/New_York\'')
      if (change === 'physical') fixture.database.exec('UPDATE device_settings SET unused_zone_mode = \'off\'')
      if (change === 'assignment') fixture.assignedFixture()
      if (change === 'membership') fixture.database.prepare('UPDATE household_accounts SET state = \'revoked\' WHERE id = ?').run(fixture.owner.accountId)
      if (change === 'session') fixture.database.prepare('UPDATE household_accounts SET session_revision = session_revision + 1 WHERE id = ?').run(fixture.owner.accountId)
      if (change === 'revoked_approval') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?')
        .run(fixture.clock.now, fixture.identities.deviceIdentity(fixture.ownerKey))
      const before = operatingRows()
      expect(service.get(fixture.memberKey, review.reviewId)).toMatchObject({ state: 'stale', canApprove: false, canActivate: false })
      expect(() => service.approve(fixture.memberKey, approval(review.reviewId, fixture.memberKey))).toThrow()
      expect(operatingRows()).toEqual(before)
    })

  it.each(['forward', 'backward'] as const)('expires a review when the wall clock moves %s beyond its validity', (direction) => {
    const review = propose()
    fixture.clock.now += direction === 'forward' ? 3_600_001 : -1
    expect(service.get(fixture.ownerKey, review.reviewId)).toMatchObject({ state: 'expired', canApprove: false })
    expect(() => service.approve(fixture.ownerKey, approval(review.reviewId))).toThrow()
  })

  it('rejects future, expired and incomplete approval requests', () => {
    const review = propose()
    const input = approval(review.reviewId)
    expect(() => service.approve(fixture.ownerKey, { ...input, issuedAt: fixture.clock.now + 1 })).toThrow()
    expect(() => service.approve(fixture.ownerKey, { ...input, issuedAt: fixture.clock.now - 100, expiresAt: fixture.clock.now })).toThrow()
    expect(() => service.approve(fixture.ownerKey, { ...input, confirmMyRoutine: false })).toThrow()
    expect(() => service.approve(fixture.ownerKey, { ...input, sleeperId: fixture.member.selfSleeperId })).toThrow()
    expect(fixture.database.prepare('SELECT * FROM household_arrangement_approvals').all()).toEqual([])
  })

  it('does not accept member administration, changed duplicate IDs or a second open review', () => {
    const input = { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true }
    expect(() => service.propose(fixture.memberKey, { ...input, ...context(fixture.memberKey) })).toThrow('owner proposes')
    const review = service.propose(fixture.ownerKey, input)
    expect(() => service.propose(fixture.ownerKey, { ...input, ownerSide: 'left' })).toThrow('different proposal')
    expect(() => propose()).toThrow('Cancel the existing')
    const consent = approval(review.reviewId)
    service.approve(fixture.ownerKey, consent)
    expect(() => service.approve(fixture.memberKey, { ...approval(review.reviewId, fixture.memberKey), requestId: consent.requestId })).toThrow('different review')
  })

  it.each(['owner_preferences', 'member_preferences', 'member_routines'] as const)('does not promote untouched %s defaults into a shared plan', (source) => {
    const account = source.startsWith('owner') ? fixture.owner.accountId : fixture.member.accountId
    const column = source.endsWith('routines') ? 'routines_revision' : 'preferences_revision'
    fixture.database.prepare(`UPDATE household_personal_settings SET ${column} = 1 WHERE account_id = ?`).run(account)
    expect(() => propose()).toThrow('save their own preferences')
    expect(fixture.database.prepare('SELECT * FROM household_arrangement_reviews').all()).toEqual([])
  })

  it('allows either person to cancel, and replay cannot revive the old approval', () => {
    const review = propose()
    const consent = approval(review.reviewId)
    service.approve(fixture.ownerKey, consent)
    const input = { ...context(fixture.memberKey), version: 1, reviewId: review.reviewId }
    expect(service.cancel(fixture.memberKey, input).state).toBe('cancelled')
    expect(service.cancel(fixture.memberKey, input).state).toBe('cancelled')
    expect(service.approve(fixture.ownerKey, consent)).toMatchObject({ state: 'cancelled', canActivate: false })
    expect(propose().reviewId).not.toBe(review.reviewId)
  })

  it('keeps review mutations disabled separately from personal controls', () => {
    expect(service.present(fixture.identities.session(fixture.ownerKey)).capabilities).toMatchObject({ arrangementReview: true, activateArrangement: false })
    enabled = false
    expect(service.present(fixture.identities.session(fixture.ownerKey)).capabilities.arrangementReview).toBe(false)
    expect(() => propose()).toThrow('unavailable')
    enabled = true
    const review = propose()
    enabled = false
    expect(service.get(fixture.memberKey, review.reviewId).canApprove).toBe(false)
    expect(() => service.approve(fixture.memberKey, approval(review.reviewId, fixture.memberKey))).toThrow()
    expect(service.cancel(fixture.ownerKey, { ...context(), version: 1, reviewId: review.reviewId }).state).toBe('cancelled')
  })

  it('rolls back a failed durable approval without changing the bed', () => {
    const review = propose()
    const before = operatingRows()
    fixture.database.exec('CREATE TRIGGER fail_arrangement BEFORE INSERT ON household_arrangement_approvals BEGIN SELECT RAISE(ABORT, \'disk_failure\'); END;')
    expect(() => service.approve(fixture.ownerKey, approval(review.reviewId))).toThrow('disk_failure')
    expect(service.get(fixture.ownerKey, review.reviewId).self.approved).toBe(false)
    expect(operatingRows()).toEqual(before)
  })

  it('authenticates the HTTP review routes and never returns the other person’s plan', async () => {
    const request = (key: string, suffix: string, body?: unknown) => new Request(`http://pod.local/api/v1/household/arrangement${suffix}`, {
      method: body ? 'POST' : 'GET', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const dependencies = { store: fixture.identities, verifySoloConfiguration: () => true, arrangementReviews: service }
    const empty = await householdHttp(request(fixture.memberKey, ''), dependencies)
    expect(await empty.json()).toEqual({ version: 1, review: null })
    const created = await householdHttp(request(fixture.ownerKey, '', { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true }), dependencies)
    expect(created.status).toBe(200)
    const review = await created.json()
    const own = await householdHttp(request(fixture.memberKey, `/${review.reviewId}`), dependencies)
    expect(own.headers.get('cache-control')).toBe('private, no-store')
    const text = await own.text()
    expect(text).toContain('Partner private draft')
    expect(text).not.toContain('Owner private operating routine')
    expect((await householdHttp(request('not-a-personal-key', ''), dependencies)).status).toBe(401)
    expect((await householdHttp(request(fixture.ownerKey, '/approve', approval(review.reviewId)), dependencies)).status).toBe(200)
    const member = await householdHttp(request(fixture.memberKey, '/approve', approval(review.reviewId, fixture.memberKey)), dependencies)
    expect(await member.json()).toMatchObject({ state: 'approved_for_separate_activation', canActivate: false })
    const cancelled = await householdHttp(request(fixture.memberKey, '/cancel', { ...context(fixture.memberKey), version: 1, reviewId: review.reviewId }), dependencies)
    expect(await cancelled.json()).toMatchObject({ state: 'cancelled' })
  })
})
