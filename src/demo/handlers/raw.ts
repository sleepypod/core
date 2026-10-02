import type { DemoHandlers, RouterOutputs } from '../types'
import { HOUR, hashSeed, randomBetween, seededRandom } from '../util'

type RawFile = RouterOutputs['raw']['files'][number]

const TOTAL_BYTES = 7_516_192_768 // ~7 GB /persistent partition
const OTHER_USED_BYTES = 1_932_735_283

// Firmware rotates RAW files roughly every 2 hours; keep two days' worth.
let files: RawFile[] = Array.from({ length: 24 }, (_, i) => {
  const rand = seededRandom(hashSeed(`raw:${i}`))
  const seq = 4180 - i
  return {
    name: `${seq.toString(16).toUpperCase().padStart(8, '0')}.RAW`,
    sizeBytes: i === 0 ? 31_457_280 : Math.round(randomBetween(rand, 118, 136) * 1024 * 1024),
    modifiedAt: new Date(Date.now() - i * 2 * HOUR - (i === 0 ? 0 : 7 * 60_000)).toISOString(),
  }
})

export const raw: DemoHandlers<'raw'> = {
  files: () => files,

  deleteFile: (input) => {
    if (files[0]?.name === input.filename) {
      return { deleted: false, message: 'Cannot delete the active (newest) RAW file' }
    }
    if (!files.some(f => f.name === input.filename)) return { deleted: false, message: 'File not found' }
    files = files.filter(f => f.name !== input.filename)
    return { deleted: true, message: `Deleted ${input.filename}` }
  },

  diskUsage: () => {
    const rawBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
    const usedBytes = OTHER_USED_BYTES + rawBytes
    return {
      totalBytes: TOTAL_BYTES,
      usedBytes,
      availableBytes: TOTAL_BYTES - usedBytes,
      rawFileCount: files.length,
      rawBytes,
    }
  },
}
