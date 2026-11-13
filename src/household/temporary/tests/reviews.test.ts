import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { temporaryFixture } from './fixture'

let fixture: ReturnType<typeof temporaryFixture>
beforeEach(() => {
  fixture = temporaryFixture()
})
afterEach(() => fixture.close())
const propose = () => fixture.service.propose(fixture.ownerKey, fixture.proposal())

describe('persisted temporary arrangement review', () => {
  it('requires both independent accounts and never changes operating state', () => {
    const before = fixture.operating()
    const review = propose()
    const owner = fixture.service.approve(fixture.ownerKey, fixture.approval(review.reviewId))
    expect(owner).toMatchObject({ state: 'awaiting_approval', self: { approved: true }, others: [{ approved: false }] })
    const partner = fixture.service.approve(fixture.memberKey, fixture.approval(review.reviewId, fixture.memberKey))
    expect(partner).toMatchObject({ state: 'approved_for_separate_activation', canActivate: false, effect: 'review_only_bed_unchanged' })
    expect(JSON.stringify(owner)).toContain('Owner private week')
    expect(JSON.stringify(owner)).not.toContain('Partner private week')
    expect(JSON.stringify(partner)).toContain('Partner private week')
    expect(JSON.stringify(partner)).not.toContain('Owner private week')
    expect(JSON.stringify(partner)).not.toContain('Unpublished private draft')
    expect(fixture.operating()).toEqual(before)
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('reconciles proposal and approval retries after service restart without extending expiry', () => {
    const request = fixture.proposal()
    const review = fixture.service.propose(fixture.ownerKey, request)
    const consent = fixture.approval(review.reviewId)
    fixture.service.approve(fixture.ownerKey, consent)
    fixture.clock.now += 60_000
    const service = fixture.makeService()
    expect(service.propose(fixture.ownerKey, request)).toMatchObject({ reviewExpiresAt: review.reviewExpiresAt, self: { approved: true } })
    expect(service.approve(fixture.ownerKey, consent).self.approved).toBe(true)
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_temporary_reviews').get()).toEqual({ count: 1 })
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_temporary_approvals').get()).toEqual({ count: 1 })
  })

  it('rejects changed request IDs, member administration and competing proposals', () => {
    const request = fixture.proposal()
    expect(() => fixture.service.propose(fixture.memberKey, { ...request, ...fixture.context(fixture.memberKey) })).toThrow('owner')
    const review = fixture.service.propose(fixture.ownerKey, request)
    expect(() => fixture.service.propose(fixture.ownerKey, { ...request, endsAt: request.endsAt + 1 })).toThrow('changed')
    expect(() => propose()).toThrow('Cancel the existing')
    const consent = fixture.approval(review.reviewId)
    fixture.service.approve(fixture.ownerKey, consent)
    expect(() => fixture.service.approve(fixture.memberKey, { ...fixture.approval(review.reviewId, fixture.memberKey), requestId: consent.requestId })).toThrow('changed')
  })

  it.each(['future', 'expired', 'missing_consent', 'forged_account', 'stale_assignment', 'stale_session'])(
    'rejects %s approval with no saved consent', (kind) => {
      const review = propose()
      const request = fixture.approval(review.reviewId)
      const malformed = { ...request,
        ...kind === 'future' ? { issuedAt: fixture.clock.now + 1 } : {},
        ...kind === 'expired' ? { issuedAt: fixture.clock.now - 1000, expiresAt: fixture.clock.now } : {},
        ...kind === 'missing_consent' ? { acknowledgeRecordingPolicy: false } : {},
        ...kind === 'forged_account' ? { accountId: fixture.member.accountId } : {},
        ...kind === 'stale_assignment' ? { expectedAssignmentRevision: request.expectedAssignmentRevision + 1 } : {},
        ...kind === 'stale_session' ? { expectedSessionRevision: request.expectedSessionRevision + 1 } : {},
      }
      expect(() => fixture.service.approve(fixture.ownerKey, malformed)).toThrow()
      expect(fixture.database.prepare('SELECT * FROM household_temporary_approvals').all()).toEqual([])
    })

  it.each(['forward', 'backward'])('expires the review after the clock moves %s', (direction) => {
    const review = propose()
    fixture.clock.now += direction === 'forward' ? 3600_000 : -1
    expect(fixture.service.get(fixture.memberKey, review.reviewId)).toMatchObject({ state: 'expired', canApprove: false, canActivate: false })
  })

  it.each(['preferences', 'routine', 'side_configuration', 'revoked_approval'])(
    'invalidates approvals after %s changes', (change) => {
      const review = propose()
      fixture.service.approve(fixture.ownerKey, fixture.approval(review.reviewId))
      if (change === 'preferences') fixture.database.exec('UPDATE household_personal_settings SET preferences_revision = preferences_revision + 1')
      if (change === 'routine') fixture.database.exec(`UPDATE bedtime_routines SET configuration = json_set(configuration, '$.notes', 'Changed elsewhere')`)
      if (change === 'side_configuration') fixture.database.exec('UPDATE side_settings SET name = \'Changed\'')
      if (change === 'revoked_approval') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?')
        .run(fixture.clock.now, fixture.identities.deviceIdentity(fixture.ownerKey))
      expect(fixture.service.get(fixture.memberKey, review.reviewId)).toMatchObject({ state: 'stale', canApprove: false })
      expect(() => fixture.service.approve(fixture.memberKey, fixture.approval(review.reviewId, fixture.memberKey))).toThrow()
    })

  it('allows cancellation with writes disabled, and replay cannot revive consent', () => {
    const review = propose()
    const consent = fixture.approval(review.reviewId)
    fixture.service.approve(fixture.ownerKey, consent)
    fixture.clock.enabled = false
    expect(fixture.service.get(fixture.memberKey, review.reviewId).canApprove).toBe(false)
    expect(() => fixture.service.approve(fixture.memberKey, fixture.approval(review.reviewId, fixture.memberKey))).toThrow()
    expect(fixture.service.cancel(fixture.memberKey, { ...fixture.context(fixture.memberKey), version: 1, reviewId: review.reviewId }).state).toBe('cancelled')
    expect(fixture.service.approve(fixture.ownerKey, consent).state).toBe('cancelled')
    expect(() => propose()).toThrow()
    fixture.clock.enabled = true
    expect(propose().reviewId).not.toBe(review.reviewId)
  })

  it('rolls back a failed durable write and restores SQLite durability', () => {
    const review = propose()
    const before = fixture.operating()
    const synchronous = fixture.database.pragma('synchronous', { simple: true })
    fixture.database.exec('CREATE TRIGGER fail_temporary BEFORE INSERT ON household_temporary_approvals BEGIN SELECT RAISE(ABORT, \'disk_failure\'); END')
    expect(() => fixture.service.approve(fixture.ownerKey, fixture.approval(review.reviewId))).toThrow('disk_failure')
    expect(fixture.service.get(fixture.ownerKey, review.reviewId).self.approved).toBe(false)
    expect(fixture.operating()).toEqual(before)
    expect(fixture.database.pragma('synchronous', { simple: true })).toBe(synchronous)
  })

  it('consumes approval only atomically with an owner configuration transaction', () => {
    const review = propose()
    const input = { ...fixture.context(), reviewId: review.reviewId }
    expect(() => fixture.service.approvedForCommit(fixture.ownerKey, input)).toThrow('transaction')
    expect(() => fixture.database.transaction(() => fixture.service.approvedForCommit(fixture.ownerKey, input))()).toThrow()
    for (const key of [fixture.ownerKey, fixture.memberKey]) fixture.service.approve(key, fixture.approval(review.reviewId, key))
    expect(() => fixture.database.transaction(() => {
      fixture.service.consumeForCommit(fixture.ownerKey, input)
      throw new Error('configuration_failure')
    })()).toThrow('configuration_failure')
    expect(fixture.service.get(fixture.ownerKey, review.reviewId).state).toBe('approved_for_separate_activation')
    expect(() => fixture.database.transaction(() => fixture.service.approvedForCommit(fixture.memberKey, { ...fixture.context(fixture.memberKey), reviewId: review.reviewId }))()).toThrow()
    fixture.database.transaction(() => fixture.service.consumeForCommit(fixture.ownerKey, input))()
    expect(fixture.service.get(fixture.ownerKey, review.reviewId).state).toBe('consumed')
    expect(() => fixture.database.transaction(() => fixture.service.consumeForCommit(fixture.ownerKey, input))()).toThrow()
    expect(() => fixture.service.cancel(fixture.ownerKey, { ...fixture.context(), version: 1, reviewId: review.reviewId })).toThrow()
  })

  it('does not return a record to an unrelated credential or guessed identifier', () => {
    const review = propose()
    expect(() => fixture.service.get('not-a-key', review.reviewId)).toThrow()
    expect(() => fixture.service.get(fixture.ownerKey, randomUUID())).toThrow()
    fixture.database.prepare('UPDATE household_accounts SET state = \'revoked\' WHERE id = ?').run(fixture.member.accountId)
    expect(() => fixture.service.get(fixture.memberKey, review.reviewId)).toThrow()
  })

  it('does not let a modified stored plan become approval authority', () => {
    const review = propose()
    const row = fixture.database.prepare('SELECT payload FROM household_temporary_reviews WHERE id = ?').get(review.reviewId) as { payload: string }
    const plan = JSON.parse(row.payload)
    plan.participants[0].operatingWeek = []
    fixture.database.prepare('UPDATE household_temporary_reviews SET payload = ? WHERE id = ?').run(JSON.stringify(plan), review.reviewId)
    expect(() => fixture.service.get(fixture.ownerKey, review.reviewId)).toThrow()
    expect(() => fixture.service.approve(fixture.ownerKey, fixture.approval(review.reviewId))).toThrow()
  })
})

describe('guest preparation with a solo owner', () => {
  it('excludes the invited but unassigned person and never creates a guest account', () => {
    const solo = temporaryFixture(true)
    try {
      const before = solo.operating()
      const review = solo.service.propose(solo.ownerKey, solo.proposal())
      expect(review.others).toEqual([])
      expect(() => solo.service.get(solo.memberKey, review.reviewId)).toThrow('not a participant')
      expect(solo.service.approve(solo.ownerKey, solo.approval(review.reviewId))).toMatchObject({ state: 'approved_for_separate_activation', canActivate: false })
      expect(solo.operating()).toEqual(before)
    }
    finally { solo.close() }
  })
})
