import { describe, expect, it } from 'vitest'
import fixtures from '../fixtures/personal-routines-v1.json'
import { personalRoutineReviewSchema, personalRoutinePublishSchema, personalRoutineReceiptSchema } from '../routineContract'
import { householdErrorSchema } from '../contract'

describe('frozen personal routine publication contract', () => {
  it('decodes complete reviews and separates a durable save from scheduler confirmation', () => {
    for (const fixture of [fixtures.readyReview, fixtures.untouchedReview])
      expect(personalRoutineReviewSchema.parse(fixture)).toEqual(fixture)
    expect(personalRoutinePublishSchema.parse(fixtures.publishRequest)).toEqual(fixtures.publishRequest)
    for (const fixture of [fixtures.saved, fixtures.schedulerPending, fixtures.schedulerUnconfirmed])
      expect(personalRoutineReceiptSchema.parse(fixture)).toEqual(fixture)
    expect(householdErrorSchema.parse(fixtures.missingReceipt)).toEqual(fixtures.missingReceipt)
    expect(fixtures.readyReview.liveWeek[0].draft.alarm.snoozeDuration).toBe(540)
    expect(fixtures.readyReview.draftWeek[0].draft.alarm.snoozeDuration).toBe(540)
  })

  it('rejects caller-selected sides, absent acknowledgments and extended validity', () => {
    const input = fixtures.publishRequest
    expect(personalRoutinePublishSchema.safeParse({ ...input, side: 'right' }).success).toBe(false)
    expect(personalRoutinePublishSchema.safeParse({ ...input, confirmReplaceLiveWeek: undefined }).success).toBe(false)
    expect(personalRoutinePublishSchema.safeParse({ ...input, acknowledgeCurrentTargetEffect: false }).success).toBe(false)
    expect(personalRoutinePublishSchema.safeParse({ ...input, expiresAt: input.issuedAt + 60_001 }).success).toBe(false)
    expect(personalRoutineReceiptSchema.safeParse({ ...fixtures.saved, physicalVerification: 'verified' }).success).toBe(false)
  })
})
