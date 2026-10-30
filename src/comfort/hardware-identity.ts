import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Hash the embedded storage identity; development hosts never receive a random qualification identity. */
export function readComfortHardwareIdentity(): string | null {
  for (const path of ['/sys/block/mmcblk0/device/cid', '/sys/block/mmcblk0/device/serial']) {
    try {
      const value = readFileSync(/* turbopackIgnore: true */ path, 'utf8').trim()
      if (/^(?:0x)?[a-f0-9]+$/i.test(value) && !/^(?:0x)?(?:0+|f+)$/i.test(value)) {
        return createHash('sha256').update(JSON.stringify(['comfort-pod-v1', path, value])).digest('hex')
      }
    }
    catch { /* Unavailable hardware cannot qualify. */ }
  }
  return null
}
