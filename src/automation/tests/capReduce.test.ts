import { describe, expect, it } from 'vitest'
import { zoneTriple } from '../capReduce'

describe('zoneTriple', () => {
  it('returns null for a scalar (Pod 3) frame', () => {
    expect(zoneTriple([42])).toBeNull()
  })

  it('returns null below six sensor channels', () => {
    expect(zoneTriple([10, 20, 30])).toBeNull()
  })

  it('pairs six channels into head/torso/legs means', () => {
    expect(zoneTriple([10, 20, 30, 40, 50, 60])).toEqual([15, 35, 55])
  })

  it('drops the two reference channels on a full capSense2 frame', () => {
    expect(zoneTriple([10, 20, 30, 40, 50, 60, 999, 999])).toEqual([15, 35, 55])
  })
})
