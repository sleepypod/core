import { describe, expect, test } from 'vitest'
import {
  MIN_BUCKET_NONSTILL_FLOOR,
  MOVEMENT_BUCKET_DAY_SECONDS,
  MOVEMENT_BUCKET_WEEK_SECONDS,
  pickMinBucketNonStillEpochs,
  pickMovementBucketSeconds,
  POSITION_CHANGE_SCORE_MIN,
  RESTLESS_SCORE_MIN,
} from '../movement'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

describe('movement constants', () => {
  test('thresholds match the docs/sleep-detector.md score bands', () => {
    expect(RESTLESS_SCORE_MIN).toBe(50)
    expect(POSITION_CHANGE_SCORE_MIN).toBe(200)
  })

  test('bucket sizes match the documented day vs week defaults', () => {
    expect(MOVEMENT_BUCKET_DAY_SECONDS).toBe(5 * 60)
    expect(MOVEMENT_BUCKET_WEEK_SECONDS).toBe(30 * 60)
  })
})

describe('pickMovementBucketSeconds', () => {
  test('uses day buckets for ranges of one day or less', () => {
    expect(pickMovementBucketSeconds(60_000)).toBe(MOVEMENT_BUCKET_DAY_SECONDS)
    expect(pickMovementBucketSeconds(ONE_DAY_MS)).toBe(MOVEMENT_BUCKET_DAY_SECONDS)
  })

  test('uses week buckets for ranges longer than one day', () => {
    expect(pickMovementBucketSeconds(ONE_DAY_MS + 1)).toBe(MOVEMENT_BUCKET_WEEK_SECONDS)
    expect(pickMovementBucketSeconds(7 * ONE_DAY_MS)).toBe(MOVEMENT_BUCKET_WEEK_SECONDS)
  })
})

describe('pickMinBucketNonStillEpochs', () => {
  test('uses the floor for small day-view buckets', () => {
    expect(pickMinBucketNonStillEpochs(MOVEMENT_BUCKET_DAY_SECONDS)).toBe(MIN_BUCKET_NONSTILL_FLOOR)
  })

  test('caps at available epochs for sub-floor buckets', () => {
    expect(pickMinBucketNonStillEpochs(60)).toBe(1)
  })

  test('scales linearly above 10 min, requiring three hits in a 30-min bucket', () => {
    expect(pickMinBucketNonStillEpochs(MOVEMENT_BUCKET_WEEK_SECONDS)).toBe(3)
    expect(pickMinBucketNonStillEpochs(3600)).toBe(6)
  })
})
