import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { temporaryFixture } from './fixture'

let fixture: ReturnType<typeof temporaryFixture>
beforeEach(() => {
  fixture = temporaryFixture()
})
afterEach(() => fixture.close())
const read = () => fixture.database.transaction(() => fixture.sourceReader.read(fixture.owner.householdId))()

describe('temporary arrangement persisted source', () => {
  it('requires a consistent transaction and uses actual weeks rather than private drafts', () => {
    expect(() => fixture.sourceReader.read(fixture.owner.householdId)).toThrow('transaction')
    const before = fixture.operating()
    const result = read()
    const owner = result.people.find(person => person.accountId === fixture.owner.accountId)
    expect(owner).toMatchObject({ assignment: 'right', preferences: { preferredTemperatureF: 70 } })
    expect(owner?.operatingWeek[0].draft.notes).toBe('Owner private week')
    expect(JSON.stringify(result)).not.toContain('Unpublished private draft')
    expect(result.history.datasetId).toBe(fixture.source.identity.datasetId)
    expect(result.history.epochId).toBe(fixture.epoch.epochId)
    expect(fixture.operating()).toEqual(before)
  })

  it.each(['dataset', 'binding', 'future_binding', 'epoch', 'revoked_epoch', 'wrong_sleeper', 'wrong_zone', 'epoch_mode',
    'history_revision', 'physical_mode', 'timezone', 'preferences', 'unreviewed_preferences', 'missing_settings', 'future_arrangement'])(
    'refuses %s without inventing a source or changing data', (change) => {
      const database = fixture.database
      if (change === 'dataset') fixture.source.biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())
      if (change === 'binding') database.exec('DELETE FROM household_history_sources')
      if (change === 'future_binding') database.prepare('UPDATE household_history_sources SET bound_at = ?').run(fixture.clock.now + 1)
      if (change === 'epoch') database.exec('DELETE FROM household_attribution_epochs')
      if (change === 'revoked_epoch') database.prepare('UPDATE household_attribution_epochs SET revoked_at = ?').run(fixture.clock.now)
      if (change === 'wrong_sleeper' || change === 'wrong_zone') {
        const row = database.prepare('SELECT assignments FROM household_attribution_epochs').get() as { assignments: string }
        const assignments = JSON.parse(row.assignments)
        if (change === 'wrong_sleeper') assignments[0].sleeperId = randomUUID()
        else assignments[0].recordedSide = 'left'
        database.prepare('UPDATE household_attribution_epochs SET assignments = ?').run(JSON.stringify(assignments))
      }
      if (change === 'epoch_mode') database.exec('UPDATE household_attribution_epochs SET mode = \'solo_merged\'')
      if (change === 'history_revision') database.exec('DELETE FROM household_history_state')
      if (change === 'physical_mode') database.exec('UPDATE device_settings SET bed_mode = \'solo-left\'')
      if (change === 'timezone') database.exec('UPDATE device_settings SET timezone = \'not-a-timezone\'')
      if (change === 'preferences') database.exec('UPDATE household_personal_settings SET preferences = \'{}\'')
      if (change === 'unreviewed_preferences') database.exec('UPDATE household_personal_settings SET preferences_revision = 1')
      if (change === 'missing_settings') database.prepare('DELETE FROM household_personal_settings WHERE account_id = ?').run(fixture.member.accountId)
      if (change === 'future_arrangement') database.prepare('UPDATE households SET effective_at = ?').run(fixture.clock.now + 1)
      const before = fixture.operating()
      expect(() => read()).toThrow()
      expect(fixture.operating()).toEqual(before)
    })

  it('withdraws approvals but permits cancellation when a recording source becomes unavailable', () => {
    const review = fixture.service.propose(fixture.ownerKey, fixture.proposal())
    fixture.service.approve(fixture.ownerKey, fixture.approval(review.reviewId))
    fixture.source.biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())
    expect(fixture.service.get(fixture.memberKey, review.reviewId)).toMatchObject({ state: 'stale', canApprove: false })
    expect(() => fixture.service.approve(fixture.memberKey, fixture.approval(review.reviewId, fixture.memberKey))).toThrow()
    expect(fixture.service.cancel(fixture.memberKey, { ...fixture.context(fixture.memberKey), version: 1, reviewId: review.reviewId }).state).toBe('cancelled')
  })

  it('keeps pending personal enrollment outside solo operating and attribution state', () => {
    const solo = temporaryFixture(true)
    try {
      const result = solo.database.transaction(() => solo.sourceReader.read(solo.owner.householdId))()
      expect(result.people.find(person => person.role === 'member')).toMatchObject({ assignment: 'unassigned', operatingWeek: [] })
      expect(result).toMatchObject({ mode: 'solo-anywhere', bedMode: 'solo-left', unusedZoneMode: 'follow' })
    }
    finally { solo.close() }
  })
})
