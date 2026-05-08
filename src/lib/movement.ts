/**
 * Movement-stat thresholds. Anchored to docs/sleep-detector.md score table:
 * 0–50 still, 50–200 fidgeting, 200–500 limb shift, 500+ major postural change
 * (De Koninck 1992: ~10 major shifts/night).
 *
 * One movement row = one 60-s epoch, so a row meeting RESTLESS_SCORE_MIN ≈
 * one minute of restlessness; a row meeting POSITION_CHANGE_SCORE_MIN ≈ one
 * postural shift.
 */
export const RESTLESS_SCORE_MIN = 50
export const POSITION_CHANGE_SCORE_MIN = 200

/** Default chart bucket sizes in seconds, by visible range. */
export const MOVEMENT_BUCKET_DAY_SECONDS = 5 * 60
export const MOVEMENT_BUCKET_WEEK_SECONDS = 30 * 60

export function pickMovementBucketSeconds(rangeMs: number): number {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000
  return rangeMs > ONE_DAY_MS ? MOVEMENT_BUCKET_WEEK_SECONDS : MOVEMENT_BUCKET_DAY_SECONDS
}
