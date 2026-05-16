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

/**
 * Density gate for the movement bucket chart: a bucket is rendered only if at
 * least this many of its epochs cross RESTLESS_SCORE_MIN ("real activity").
 * Filters phantom-session flicker (1-3 stray epochs/bucket) without affecting
 * real sessions (~6-10 non-still epochs in 30 min, per the doc score table).
 *
 * Scales with bucket width so a sparse signal in a wide bucket is still cut,
 * while a narrow 5-min day-view bucket needs only 2 hits to qualify.
 */
export const MIN_BUCKET_NONSTILL_FLOOR = 2

export function pickMinBucketNonStillEpochs(bucketSeconds: number): number {
  return Math.max(MIN_BUCKET_NONSTILL_FLOOR, Math.floor(bucketSeconds / 600))
}
