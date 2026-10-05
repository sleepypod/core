import { withChecksum } from '../protocol'

export function telemetry(ticks = [190, 24, 540, 763]): Uint8Array {
  const payload = new Uint8Array(18)
  payload.set([255, 255, 255, 255, 1, 0, 0x22, 0x14])
  const view = new DataView(payload.buffer)
  ticks.forEach((value, i) => view.setUint16(9 + i * 2, value, true))
  return withChecksum(payload)
}
