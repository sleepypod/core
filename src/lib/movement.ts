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

/**
 * Score a minute must reach to count as a movement in the charts. On a Pod 5
 * the score sits near 100 even when the wrist is still, so 200 put a bar in
 * most 5-minute buckets. Against Apple Watch wrist movement over 6 nights,
 * 15-minute buckets counting minutes >= 400 agreed best (Spearman 0.31, vs
 * 0.24 for 5-minute buckets >= 200). Charts only; summary stats keep 200.
 */
export const MOVEMENT_CHART_SCORE_MIN = 400

/** Default chart bucket sizes in seconds, by visible range. */
export const MOVEMENT_BUCKET_DAY_SECONDS = 15 * 60
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
  const availableEpochs = Math.floor(bucketSeconds / 60)
  const desired = Math.max(MIN_BUCKET_NONSTILL_FLOOR, Math.floor(bucketSeconds / 600))
  return Math.min(availableEpochs, desired)
}
