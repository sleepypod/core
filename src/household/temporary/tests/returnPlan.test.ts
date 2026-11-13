import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prepareTemporaryArrangement } from '../plan'
import { prepareTemporaryReturn, projectTemporaryReturn, temporaryReturnCurrent,
  type TemporaryReturnSource } from '../returnPlan'
import { temporaryFixture } from './fixture'

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error('The synthetic return fixture is incomplete')
  return value
}

/** Build explicit committed-state examples without invoking a hardware transition. */
function fixture(kind: 'guest' | 'side_swap' = 'side_swap', solo = false) {
  const storage = temporaryFixture(solo)
  try {
    const before = storage.database.transaction(() => storage.sourceReader.read(storage.owner.householdId))()
    const request = { ...storage.context(), version: 1, endsAt: storage.clock.now + 12 * 3600_000,
      ...kind === 'guest' ? { kind, residentSide: 'right', acknowledgeGuestRecordingWithheld: true } : { kind } }
    const entry = prepareTemporaryArrangement(before, storage.owner.accountId, request, storage.clock.now)
    const receipt = { version: 1, operationId: randomUUID(), reviewId: entry.reviewId,
      householdId: before.householdId, podId: before.podId, sourceDigest: entry.sourceDigest,
      committedAt: storage.clock.now + 1000, assignmentRevision: before.assignmentRevision + 1, intervalRevision: 1 }
    const source: TemporaryReturnSource = {
      version: 1, householdId: before.householdId, podId: before.podId, operationId: receipt.operationId,
      intervalRevision: 1, householdRevision: before.householdRevision + 1, assignmentRevision: receipt.assignmentRevision,
      activatedAt: receipt.committedAt, timeZone: before.timeZone, policyDigest: 'd'.repeat(64),
      history: { datasetId: before.history.datasetId, attributionRevision: before.history.attributionRevision + 1,
        sourceBindingHash: before.history.sourceBindingHash, processingHash: 'e'.repeat(64),
        mode: kind === 'guest' ? 'guest_withheld' : 'assigned', epochId: kind === 'guest' ? null : randomUUID() },
      people: entry.participants.map((person) => {
        const original = required(before.people.find(value => value.accountId === person.accountId))
        return { accountId: person.accountId, sleeperId: person.sleeperId, displayName: person.displayName,
          role: original.role, sessionRevision: original.sessionRevision + 1,
          preferencesRevision: original.preferencesRevision, draftRevision: original.draftRevision,
          currentSide: person.proposedSide, operatingWeek: structuredClone(person.operatingWeek),
          preferences: structuredClone(person.preferences) }
      }),
    }
    const owner = required(source.people.find(person => person.role === 'owner'))
    const returnRequest = { version: 1, requestId: randomUUID(), operationId: receipt.operationId,
      expectedSessionRevision: owner.sessionRevision, expectedAssignmentRevision: source.assignmentRevision,
      expectedIntervalRevision: source.intervalRevision, acknowledgeNewerRoutinesPreserved: true,
      acknowledgeSeparateActivation: true }
    const now = receipt.committedAt + 5000
    return { entry, receipt, source, owner: owner.accountId, returnRequest, now,
      prepare: () => prepareTemporaryReturn(entry, receipt, source, owner.accountId, returnRequest, now) }
  }
  finally { storage.close() }
}

describe('reviewed temporary arrangement return', () => {
  it('carries each resident current operating week back to their original side, leaving unpublished drafts alone', () => {
    const state = fixture(), owner = required(state.source.people.find(person => person.role === 'owner'))
    owner.operatingWeek[0].draft.power.onTemperature = 72
    owner.operatingWeek[0].draft.notes = 'Newer owner week'
    owner.preferences.preferredTemperatureF = 72
    owner.preferencesRevision += 1
    owner.draftRevision += 1
    const unchanged = structuredClone(state.source), plan = state.prepare()
    const returned = required(plan.participants.find(person => person.accountId === owner.accountId))
    expect(returned).toMatchObject({ currentSide: 'left', returnSide: 'right', routineSource: 'current_person_week',
      differsFromBeforeVisit: true, preferences: { preferredTemperatureF: 72 } })
    expect(returned.operatingWeek).toEqual(owner.operatingWeek)
    expect(JSON.stringify(plan.participants)).not.toContain('Unpublished private draft')
    expect(state.source).toEqual(unchanged)
    expect(plan.returnArrangement).toEqual({ mode: 'assigned', sourceSide: 'left', bedMode: 'two', unusedZoneMode: 'off' })
  })

  it('restores an absent partner preserved operating week without substituting the guest zone settings', () => {
    const state = fixture('guest'), plan = state.prepare()
    const partner = required(state.source.people.find(person => person.role === 'member'))
    const returned = required(plan.participants.find(person => person.accountId === partner.accountId))
    expect(partner.operatingWeek).toEqual([])
    expect(returned).toMatchObject({ currentSide: null, returnSide: 'left', routineSource: 'preserved_absent_person_week', differsFromBeforeVisit: false })
    expect(returned.operatingWeek).toEqual(required(state.entry.participants.find(person => person.accountId === partner.accountId)).originalOperatingWeek)
    expect(returned.operatingWeek[0].draft.notes).toBe('Partner private week')
  })

  it('returns a solo resident to the original merged source, keeping an invited unassigned person out of attribution', () => {
    const state = fixture('guest', true), plan = state.prepare()
    expect(plan.participants).toHaveLength(1)
    expect(plan.participants[0]).toMatchObject({ currentSide: 'right', returnSide: 'left', returnAssignment: 'solo' })
    expect(plan.returnArrangement).toEqual({ mode: 'solo-anywhere', sourceSide: 'left', bedMode: 'solo-left', unusedZoneMode: 'follow' })
  })

  it('provides a fresh return review both before and after the intended end without restoring automatically', () => {
    const state = fixture(), before = state.prepare()
    expect(before.intendedEndPassed).toBe(false)
    const later = state.entry.request.endsAt + 5 * 86400_000
    const after = prepareTemporaryReturn(state.entry, state.receipt, state.source, state.owner, state.returnRequest, later)
    expect(after.intendedEndPassed).toBe(true)
    expect(after.expiresAt).toBe(later + 3600_000)
    expect(projectTemporaryReturn(after, state.owner, state.source, later)).toMatchObject({ canActivate: false,
      effect: 'review_only_bed_unchanged', learningPolicy: 'remain_paused_pending_separate_qualification',
      recordingPolicy: 'new_reviewed_epoch_after_return', sharedActionPolicy: 'retain_each_person_quiet_request' })
    expect(temporaryReturnCurrent(after, state.source, after.expiresAt)).toBe(false)
    expect(temporaryReturnCurrent(after, state.source, later - 1)).toBe(false)
  })

  it('projects only the authenticated person week and preferences', () => {
    const state = fixture(), plan = state.prepare()
    const owner = projectTemporaryReturn(plan, state.owner, state.source, state.now)
    expect(JSON.stringify(owner)).toContain('Owner private week')
    expect(JSON.stringify(owner)).not.toContain('Partner private week')
    expect(owner).not.toHaveProperty('source')
    expect(owner).not.toHaveProperty('entry')
    expect(owner).not.toHaveProperty('receipt')
    expect(owner.others[0]).not.toHaveProperty('accountId')
    expect(owner.others[0]).not.toHaveProperty('preferences')
    const partner = required(state.source.people.find(person => person.role === 'member'))
    const theirs = projectTemporaryReturn(plan, partner.accountId, state.source, state.now)
    expect(JSON.stringify(theirs)).toContain('Partner private week')
    expect(JSON.stringify(theirs)).not.toContain('Owner private week')
  })

  it('uses canonical ordering rather than treating a query order change as a new private source', () => {
    const state = fixture(), plan = state.prepare()
    state.source.people.reverse()
    expect(temporaryReturnCurrent(plan, state.source, state.now)).toBe(true)
  })

  it.each(['week', 'preferences', 'draft', 'policy', 'processing', 'timezone', 'revision'])('withdraws an already prepared return after a %s change', (field) => {
    const state = fixture(), plan = state.prepare(), owner = required(state.source.people.find(person => person.role === 'owner'))
    if (field === 'week') owner.operatingWeek[0].draft.power.onTemperature = 73
    if (field === 'preferences') owner.preferencesRevision += 1
    if (field === 'draft') owner.draftRevision += 1
    if (field === 'policy') state.source.policyDigest = 'f'.repeat(64)
    if (field === 'processing') state.source.history.processingHash = 'f'.repeat(64)
    if (field === 'timezone') state.source.timeZone = 'America/New_York'
    if (field === 'revision') state.source.assignmentRevision += 1
    expect(temporaryReturnCurrent(plan, state.source, state.now)).toBe(false)
    expect(projectTemporaryReturn(plan, state.owner, state.source, state.now).state).toBe('stale')
  })

  it.each(['household', 'pod', 'sleeper', 'session', 'account'])('refuses reading a return under changed %s identity', (field) => {
    const state = fixture(), plan = state.prepare(), owner = required(state.source.people.find(person => person.role === 'owner'))
    if (field === 'household') state.source.householdId = randomUUID()
    if (field === 'pod') state.source.podId = randomUUID()
    if (field === 'sleeper') owner.sleeperId = randomUUID()
    if (field === 'session') owner.sessionRevision += 1
    if (field === 'account') owner.accountId = randomUUID()
    expect(() => projectTemporaryReturn(plan, state.owner, state.source, state.now)).toThrow('current personal account')
  })

  it.each(['digest', 'week', 'returnSide', 'learning', 'expiry'])('rejects a modified persisted %s field', (field) => {
    const state = fixture(), plan = state.prepare()
    if (field === 'digest') plan.sourceDigest = 'f'.repeat(64)
    if (field === 'week') plan.participants[0].operatingWeek[0].draft.notes = 'Forged'
    if (field === 'returnSide') plan.participants[0].returnSide = plan.participants[1].returnSide
    if (field === 'learning') Object.assign(plan, { learningPolicy: 'active' })
    if (field === 'expiry') plan.expiresAt += 1
    expect(temporaryReturnCurrent(plan, state.source, state.now)).toBe(false)
    expect(() => projectTemporaryReturn(plan, state.owner, state.source, state.now)).toThrow('current temporary arrangement')
  })

  it.each(['receipt', 'dataset', 'binding', 'epoch', 'interval', 'side', 'session', 'membership', 'recording', 'committedAt'])('rejects an incoherent %s at preparation', (field) => {
    const state = fixture(), owner = required(state.source.people.find(person => person.role === 'owner'))
    if (field === 'receipt') state.receipt.sourceDigest = 'f'.repeat(64)
    if (field === 'dataset') state.source.history.datasetId = randomUUID()
    if (field === 'binding') state.source.history.sourceBindingHash = 'f'.repeat(64)
    if (field === 'epoch') state.source.history.epochId = state.entry.source.history.epochId
    if (field === 'interval') state.source.operationId = randomUUID()
    if (field === 'side') {
      state.source.people.forEach((person) => {
        person.currentSide = person.currentSide === 'left' ? 'right' : 'left'
      })
    }
    if (field === 'session') owner.sessionRevision -= 1
    if (field === 'membership') state.source.people[1].accountId = randomUUID()
    if (field === 'recording') {
      state.source.history.mode = 'guest_withheld'
      state.source.history.epochId = null
    }
    if (field === 'committedAt') state.receipt.committedAt = state.entry.expiresAt
    expect(state.prepare).toThrow()
  })

  it('does not let a partner or unknown account prepare a return', () => {
    const state = fixture(), partner = required(state.source.people.find(person => person.role === 'member'))
    for (const accountId of [partner.accountId, randomUUID()]) {
      expect(() => prepareTemporaryReturn(state.entry, state.receipt, state.source, accountId, state.returnRequest, state.now))
        .toThrow('current household owner')
    }
  })

  it('rejects future activation, mismatched review revisions and absent acknowledgments', () => {
    const state = fixture()
    expect(() => prepareTemporaryReturn(state.entry, state.receipt, state.source, state.owner, state.returnRequest, state.receipt.committedAt)).toThrow()
    for (const changed of [{ expectedIntervalRevision: 2 }, { expectedSessionRevision: 99 },
      { expectedAssignmentRevision: 99 }, { acknowledgeNewerRoutinesPreserved: false }, { acknowledgeSeparateActivation: false }]) {
      expect(() => prepareTemporaryReturn(state.entry, state.receipt, state.source, state.owner, { ...state.returnRequest, ...changed }, state.now)).toThrow()
    }
  })
})
