import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { BedtimeDraft } from '@/src/lib/bedtimeRoutines'
import { MAX_TEMPORARY_ARRANGEMENT_MS, prepareTemporaryArrangement, projectTemporaryArrangement,
  temporaryPlanCurrent, temporarySourceSchema, type TemporarySource } from '../plan'

const now = Date.UTC(2026, 10, 12, 20)
const night = (temperature: number, notes: string): BedtimeDraft => ({
  power: { onTime: '22:00', offTime: '07:15', onTemperature: temperature, enabled: true, endAction: 'maintain' }, temperatures: [],
  alarm: { time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 20, alarmTemperature: 105, enabled: true,
    wakeWindow: 0, snoozeDuration: 540, snoozeTaper: 30 }, notes,
})
function fixture(solo = false) {
  const owner = randomUUID(), member = randomUUID()
  const source: TemporarySource = {
    version: 1, householdId: randomUUID(), podId: randomUUID(), householdRevision: 5, assignmentRevision: 3,
    effectiveAt: now - 86400_000, mode: solo ? 'solo-anywhere' : 'assigned', sourceSide: 'left',
    bedMode: solo ? 'solo-left' : 'two', unusedZoneMode: solo ? 'follow' : 'off', timeZone: 'America/Los_Angeles',
    policyDigest: 'a'.repeat(64), history: { datasetId: randomUUID(), epochId: randomUUID(), attributionRevision: 4,
      startsAt: now - 3600_000, epochHash: 'b'.repeat(64), sourceBindingHash: 'c'.repeat(64) },
    people: [
      { accountId: owner, sleeperId: randomUUID(), displayName: 'Owner', role: 'owner', sessionRevision: 2, preferencesRevision: 3, draftRevision: 4,
        assignment: solo ? 'solo' : 'right', operatingWeek: [{ dayOfWeek: 'sunday', draft: night(70, 'private owner routine') }],
        preferences: { displayUnit: 'F', preferredTemperatureF: 70, comfort: 'warm_sleeper', shareWakeTime: false, cloudAnalysisConsent: false } },
      { accountId: member, sleeperId: randomUUID(), displayName: 'Partner', role: 'member', sessionRevision: 4, preferencesRevision: 5, draftRevision: 6,
        assignment: solo ? 'unassigned' : 'left', operatingWeek: solo ? [] : [{ dayOfWeek: 'saturday', draft: night(82, 'private partner routine') }],
        preferences: { displayUnit: 'F', preferredTemperatureF: 82, comfort: 'cold_sleeper', shareWakeTime: false, cloudAnalysisConsent: false } },
    ],
  }
  const request = { version: 1, requestId: randomUUID(), expectedSessionRevision: 2, expectedAssignmentRevision: 3,
    endsAt: now + 12 * 3600_000, kind: 'side_swap' }
  return { source, owner, member, request }
}

describe('private temporary arrangement planning', () => {
  it('moves each actual operating week with its person without changing the source', () => {
    const { source, owner, request } = fixture()
    const before = structuredClone(source)
    const plan = prepareTemporaryArrangement(source, owner, request, now)
    expect(plan.participants.find(value => value.accountId === owner)).toMatchObject({
      assignmentAtReview: 'right', proposedSide: 'left', operatingWeek: before.people[0].operatingWeek,
      originalOperatingWeek: before.people[0].operatingWeek, approvalRequired: true,
    })
    expect(plan.participants.find(value => value.accountId !== owner)).toMatchObject({ proposedSide: 'right',
      operatingWeek: before.people[1].operatingWeek, approvalRequired: true })
    expect(plan).toMatchObject({ guestSide: null, recordingPolicy: 'reviewed_assignments_after_new_epoch',
      learningPolicy: 'paused_until_reviewed_return', sharedActionPolicy: 'quiet_until_reviewed_return',
      returnPolicy: 'fresh_review_never_automatic_reversion' })
    expect(source).toEqual(before)
  })

  it('prepares a guest interval in solo mode without inventing a second personal sleeper', () => {
    const { source, owner, member, request } = fixture(true)
    const plan = prepareTemporaryArrangement(source, owner, { ...request, kind: 'guest', residentSide: 'right', acknowledgeGuestRecordingWithheld: true }, now)
    expect(plan.participants).toHaveLength(1)
    expect(plan.participants[0]).toMatchObject({ accountId: owner, assignmentAtReview: 'solo', proposedSide: 'right' })
    expect(plan).toMatchObject({ guestSide: 'left', recordingPolicy: 'withhold_personal_records_for_guest_interval' })
    expect(() => projectTemporaryArrangement(plan, member, source, now)).toThrow('not a participant')
    expect(source.mode).toBe('solo-anywhere')
    expect(source.people[1].assignment).toBe('unassigned')
  })

  it('requires the absent partner’s review and preserves their original week for a guest proposal', () => {
    const { source, owner, member, request } = fixture()
    const plan = prepareTemporaryArrangement(source, owner, { ...request, kind: 'guest', residentSide: 'right', acknowledgeGuestRecordingWithheld: true }, now)
    const review = projectTemporaryArrangement(plan, member, source, now)
    expect(review.self).toMatchObject({ proposedSide: null, operatingWeek: [], originalOperatingWeek: source.people[1].operatingWeek, approvalRequired: true })
    expect(review).toMatchObject({ canActivate: false, effect: 'review_only_bed_unchanged', state: 'review_only' })
  })

  it('returns only the viewer’s private routine and preferences', () => {
    const { source, owner, member, request } = fixture()
    const plan = prepareTemporaryArrangement(source, owner, request, now)
    for (const [account, own, other] of [[owner, 'owner', 'partner'], [member, 'partner', 'owner']]) {
      const review = projectTemporaryArrangement(plan, account, source, now)
      expect(JSON.stringify(review)).toContain(`private ${own} routine`)
      expect(JSON.stringify(review)).not.toContain(`private ${other} routine`)
      expect(Object.keys(review.others[0]).sort()).toEqual(['approvalRequired', 'displayName', 'proposedSide'])
      expect(review).not.toHaveProperty('source')
      expect(review).not.toHaveProperty('participants')
      expect(review).not.toHaveProperty('sourceDigest')
    }
  })

  it('rejects another coordinator, unassigned side swaps and incomplete guest consent', () => {
    const { source, owner, member, request } = fixture()
    expect(() => prepareTemporaryArrangement(source, member, request, now)).toThrow('current owner')
    const solo = fixture(true)
    expect(() => prepareTemporaryArrangement(solo.source, solo.owner, solo.request, now)).toThrow('two people')
    expect(() => prepareTemporaryArrangement(source, owner, { ...request, kind: 'guest', residentSide: 'left' }, now)).toThrow()
    expect(() => prepareTemporaryArrangement(source, owner, { ...request, residentSide: 'left' }, now)).toThrow()
  })

  it.each(['expired', 'too_long', 'stale_session', 'stale_assignment', 'future_arrangement', 'future_history', 'not_a_number'])(
    'refuses %s without producing a proposal', (change) => {
      const { source, owner, request } = fixture()
      const input = { ...request }
      if (change === 'expired') input.endsAt = now
      if (change === 'too_long') input.endsAt = now + MAX_TEMPORARY_ARRANGEMENT_MS + 1
      if (change === 'stale_session') input.expectedSessionRevision += 1
      if (change === 'stale_assignment') input.expectedAssignmentRevision += 1
      if (change === 'future_arrangement') source.effectiveAt = now + 1
      if (change === 'future_history') source.history.startsAt = now
      if (change === 'not_a_number') input.endsAt = Number.NaN
      expect(() => prepareTemporaryArrangement(source, owner, input, now)).toThrow()
    })

  it.each(['policy', 'dataset', 'epoch', 'preferences', 'draft', 'week', 'timezone', 'household_revision', 'assignment_revision', 'source_binding'])(
    'invalidates a plan after %s changes', (change) => {
      const { source, owner, request } = fixture()
      const plan = prepareTemporaryArrangement(source, owner, request, now)
      expect(temporaryPlanCurrent(plan, source, now)).toBe(true)
      if (change === 'policy') source.policyDigest = 'd'.repeat(64)
      if (change === 'dataset') source.history.datasetId = randomUUID()
      if (change === 'epoch') source.history.epochHash = 'd'.repeat(64)
      if (change === 'preferences') source.people[1].preferences.preferredTemperatureF += 1
      if (change === 'draft') source.people[1].draftRevision += 1
      if (change === 'week') source.people[1].operatingWeek[0].draft.notes = 'Newer private edit'
      if (change === 'timezone') source.timeZone = 'America/New_York'
      if (change === 'household_revision') source.householdRevision += 1
      if (change === 'assignment_revision') source.assignmentRevision += 1
      if (change === 'source_binding') source.history.sourceBindingHash = 'd'.repeat(64)
      expect(temporaryPlanCurrent(plan, source, now)).toBe(false)
      expect(projectTemporaryArrangement(plan, owner, source, now).state).toBe('stale')
    })

  it('treats account and routine enumeration order as the same source', () => {
    const { source, owner, request } = fixture()
    source.people[0].operatingWeek.push({ dayOfWeek: 'monday', draft: night(70, 'second night') })
    const plan = prepareTemporaryArrangement(source, owner, request, now)
    source.people[0].operatingWeek.reverse()
    source.people.reverse()
    expect(temporaryPlanCurrent(plan, source, now)).toBe(true)
  })

  it('bounds the review separately from the intended end and never reverts on expiry', () => {
    const { source, owner, request } = fixture()
    const plan = prepareTemporaryArrangement(source, owner, request, now)
    expect(plan.expiresAt).toBe(now + 3600_000)
    expect(temporaryPlanCurrent(plan, source, now - 1)).toBe(false)
    expect(temporaryPlanCurrent(plan, source, plan.expiresAt)).toBe(false)
    expect(projectTemporaryArrangement(plan, owner, source, request.endsAt)).toMatchObject({
      canActivate: false, state: 'stale', returnPolicy: 'fresh_review_never_automatic_reversion', effect: 'review_only_bed_unchanged',
    })
    const short = prepareTemporaryArrangement(source, owner, { ...request, endsAt: now + 60_000 }, now)
    expect(short.expiresAt).toBe(now + 60_000)
  })

  it.each(['household', 'pod', 'session', 'sleeper'])('refuses a saved review under changed %s identity', (change) => {
    const { source, owner, request } = fixture()
    const plan = prepareTemporaryArrangement(source, owner, request, now)
    if (change === 'household') source.householdId = randomUUID()
    if (change === 'pod') source.podId = randomUUID()
    if (change === 'session') source.people[0].sessionRevision += 1
    if (change === 'sleeper') source.people[0].sleeperId = randomUUID()
    expect(() => projectTemporaryArrangement(plan, owner, source, now)).toThrow('current personal account')
  })

  it.each(['digest', 'participant', 'expiry', 'source', 'policy'])('rejects a modified stored %s rather than displaying a forged plan', (change) => {
    const { source, owner, request } = fixture()
    const plan = prepareTemporaryArrangement(source, owner, request, now)
    if (change === 'digest') plan.sourceDigest = 'f'.repeat(64)
    if (change === 'participant') plan.participants[0].proposedSide = null
    if (change === 'expiry') plan.expiresAt += 1
    if (change === 'source') plan.source.policyDigest = 'f'.repeat(64)
    if (change === 'policy') Object.assign(plan, { learningPolicy: 'active' })
    expect(temporaryPlanCurrent(plan, source, now)).toBe(false)
    expect(() => projectTemporaryArrangement(plan, owner, source, now)).toThrow('fresh temporary-arrangement')
  })

  it('rejects impossible side membership and a private operating week on an unassigned account', () => {
    const { source } = fixture()
    source.people[1].assignment = 'right'
    expect(temporarySourceSchema.safeParse(source).success).toBe(false)
    const solo = fixture(true)
    solo.source.people[1].operatingWeek = source.people[1].operatingWeek
    expect(temporarySourceSchema.safeParse(solo.source).success).toBe(false)
  })
})
