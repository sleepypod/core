import { decode } from 'cbor-x'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAlarmPayload } from '../alarmPayload'

describe('encodeAlarmPayload', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits the exact non-record CBOR wire representation expected by firmware', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_720_000_000_000)

    const hex = encodeAlarmPayload({
      vibrationIntensity: 42,
      vibrationPattern: 'double',
      duration: 5,
    })

    expect(hex).toBe('b9000462706c182a6264750a62706966646f75626c656274741a66851e00')
    expect(decode(Buffer.from(hex, 'hex'))).toEqual({
      pl: 42,
      du: 10,
      pi: 'double',
      tt: 1_720_000_000,
    })
  })

  it('preserves durations at and above the firmware minimum', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_720_000_999_999)

    const decoded = decode(Buffer.from(encodeAlarmPayload({
      vibrationIntensity: 100,
      vibrationPattern: 'rise',
      duration: 37,
    }), 'hex'))

    expect(decoded).toEqual({ pl: 100, du: 37, pi: 'rise', tt: 1_720_000_999 })
  })
})
