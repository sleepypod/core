import { HEAD_TICKS, FEET_TICKS } from './angleTables'

export function withChecksum(payload: Uint8Array): Uint8Array {
  const packet = new Uint8Array(payload.length + 2)
  packet.set(payload)
  new DataView(packet.buffer).setUint16(payload.length, payload.reduce((sum, b) => sum + b, 0) & 0xffff, true)
  return packet
}

export function positionPacket(motor: 'head' | 'feet', angle: number, feedRate: number): Uint8Array {
  const table = motor === 'head' ? HEAD_TICKS : FEET_TICKS
  if (!Number.isInteger(angle) || angle < 0 || angle >= table.length
    || !Number.isInteger(feedRate) || feedRate < 30 || feedRate > 100) {
    throw new RangeError('Invalid base angle or feed rate')
  }
  const payload = new Uint8Array(18)
  payload.set([255, 255, 255, 255, 1, 0, 0x21, 0x14, feedRate, motor === 'head' ? 6 : 5])
  new DataView(payload.buffer).setUint16(10, table[angle], true)
  return withChecksum(payload)
}

export function stopPacket(): Uint8Array {
  return withChecksum(Uint8Array.from([255, 255, 255, 255, 5, 0, 0, 0, 0, 215, 0]))
}

function angleFor(ticks: number, table: readonly number[]): number {
  return table.reduce((best, value, angle) => Math.abs(value - ticks) < Math.abs(table[best] - ticks) ? angle : best, 0)
}

export interface BaseTelemetry {
  left: { head: number, feet: number }
  right: { head: number, feet: number }
  ticks: number[]
}

/** Bounded streaming decoder. Resynchronize one byte at a time after corruption. */
export class PositionDecoder {
  private bytes: number[] = []

  push(data: Uint8Array): BaseTelemetry[] {
    const positions: BaseTelemetry[] = []
    for (const byte of data) {
      this.bytes.push(byte)
      if (this.bytes.length < 20) continue
      const packet = Uint8Array.from(this.bytes)
      const view = new DataView(packet.buffer)
      const sum = packet.slice(0, 18).reduce((s, b) => s + b, 0) & 0xffff
      if (view.getUint32(0) !== 0xffffffff || sum !== view.getUint16(18, true)) {
        this.bytes.shift()
        continue
      }
      this.bytes = []
      if (packet[6] !== 0x22) continue
      const ticks = [9, 11, 13, 15].map(offset => view.getUint16(offset, true))
      // Implausible/out-of-calibration values are unknown, never clamped to flat.
      if (ticks[0] > 1806 || ticks[2] > 1806 || ticks[1] > 2253 || ticks[3] > 2253) continue
      positions.push({
        left: { head: angleFor(ticks[1], HEAD_TICKS), feet: angleFor(ticks[0], FEET_TICKS) },
        right: { head: angleFor(ticks[3], HEAD_TICKS), feet: angleFor(ticks[2], FEET_TICKS) },
        ticks,
      })
    }
    return positions
  }
}
