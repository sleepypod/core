import { describe, expect, it } from 'vitest'
import { PositionDecoder, positionPacket, stopPacket, withChecksum } from '../protocol'
import { baseConfigurationSchema, basePositionSchema } from '../types'

import { telemetry } from './fixtures'
const hex = (data: Uint8Array) => Buffer.from(data).toString('hex')
describe('TriMix wire protocol', () => {
  it('matches upstream verified head/feet/flat/stop packets', () => {
    expect(hex(positionPacket('head', 20, 50))).toBe('ffffffff01002114320615020000000000008104')
    expect(hex(positionPacket('feet', 15, 50))).toBe('ffffffff0100211432051c020000000000008704')
    expect(hex(positionPacket('head', 0, 50))).toBe('ffffffff01002114320600000000000000006a04')
    expect(hex(positionPacket('feet', 0, 50))).toBe('ffffffff01002114320500000000000000006904')
    expect(hex(stopPacket())).toBe('ffffffff0500000000d700d804')
  })
  it('retains nonlinear endpoints and nonmonotonic legs', () => {
    const ticks = (motor: 'head' | 'feet', angle: number) => new DataView(positionPacket(motor, angle, 100).buffer).getUint16(10, true)
    expect(ticks('head', 60)).toBe(2253)
    expect(ticks('head', 19)).toBe(456)
    expect(ticks('head', 20)).toBe(533)
    expect(ticks('feet', 14)).toBe(566)
    expect(ticks('feet', 15)).toBe(540)
    expect(ticks('feet', 45)).toBe(1806)
  })
  it.each([-1, 60.5, 61, NaN, Infinity])('rejects invalid head angle %s', (head) => {
    expect(() => positionPacket('head', head, 50)).toThrow()
    expect(basePositionSchema.safeParse({ head, feet: 0 }).success).toBe(false)
  })
  it('rejects invalid speed, leg angle and config injection', () => {
    expect(() => positionPacket('feet', 46, 50)).toThrow()
    for (const speed of [29, 101, 30.5, NaN]) expect(() => positionPacket('head', 0, speed)).toThrow()
    expect(baseConfigurationSchema.safeParse({ Address: 'AA:BB:CC:DD:EE:FF\nquit', SplitBase: false }).success).toBe(false)
    expect(baseConfigurationSchema.safeParse({ Address: 'AA:BB:CC:DD:EE:FF', SplitBase: 'false' }).success).toBe(false)
  })
  it('decodes both sides across arbitrary byte boundaries', () => {
    const decoder = new PositionDecoder()
    const packet = telemetry()
    expect(decoder.push(packet.slice(0, 7))).toEqual([])
    const values = decoder.push(packet.slice(7))
    expect(values).toEqual([{ left: { head: 1, feet: 5 }, right: { head: 30, feet: 15 }, ticks: [190, 24, 540, 763] }])
  })
  it('recovers a valid frame after garbage and checksum corruption', () => {
    const decoder = new PositionDecoder()
    const invalid = telemetry()
    invalid[18] ^= 0xff
    expect(decoder.push(Uint8Array.from([...new Uint8Array(1000), ...invalid, ...telemetry(), ...telemetry()]))).toHaveLength(2)
  })
  it('ignores other packet types and out-of-range positions', () => {
    const payload = telemetry().slice(0, 18)
    payload[6] = 0x19
    expect(new PositionDecoder().push(withChecksum(payload))).toEqual([])
    expect(new PositionDecoder().push(telemetry([65535, 0, 0, 0]))).toEqual([])
  })
})
