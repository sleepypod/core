import type { HouseholdSession } from '../../contract'
import type { TemporaryReview } from '../../temporary/contract'
import routines from '../../fixtures/personal-routines-v1.json' with { type: 'json' }
import preparation from '../../fixtures/preparation-v1.json' with { type: 'json' }

/** Synthetic personal content shared by unit and browser scenarios, never production data. */
export function temporaryReviewFixture(session: HouseholdSession, reviewId: string, now: number,
  kind: 'guest' | 'side_swap' = 'guest', residentSide: 'left' | 'right' = 'right'): TemporaryReview {
  return {
    version: 1, reviewId, kind, householdId: session.householdId, podId: session.podId, sleeperId: session.selfSleeperId,
    assignmentRevision: session.assignmentRevision, timeZone: 'America/Los_Angeles', createdAt: now,
    reviewExpiresAt: now + 3_600_000, intendedEnd: now + 43_200_000, state: 'awaiting_approval',
    self: { displayName: 'Example sleeper', assignmentAtReview: 'solo', proposedSide: residentSide,
      originalOperatingWeek: structuredClone(routines.readyReview.draftWeek) as TemporaryReview['self']['operatingWeek'],
      operatingWeek: structuredClone(routines.readyReview.draftWeek) as TemporaryReview['self']['operatingWeek'],
      preferences: { ...preparation.preferences.preferences, preferredTemperatureF: 70 } as TemporaryReview['self']['preferences'],
      approvalRequired: true, approved: false },
    others: [], guestSide: kind === 'guest' ? residentSide === 'right' ? 'left' : 'right' : null,
    recordingPolicy: kind === 'guest' ? 'withhold_personal_records_for_guest_interval' : 'reviewed_assignments_after_new_epoch',
    learningPolicy: 'paused_until_reviewed_return', sharedActionPolicy: 'quiet_until_reviewed_return', returnPolicy: 'fresh_review_never_automatic_reversion',
    canApprove: true, canCancel: true, canActivate: false, effect: 'review_only_bed_unchanged',
  }
}
