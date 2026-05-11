import { describe, expect, test } from 'vitest'
import {
  MOVEMENT_BUCKET_DAY_SECONDS,
  MOVEMENT_BUCKET_WEEK_SECONDS,
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
