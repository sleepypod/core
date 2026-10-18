import { createHash } from 'node:crypto'
import { z } from 'zod'
import { candidateFileSchema, type Candidate } from './fit'

/** Axis keys are override paths; a comma-joined key varies several paths
 * together (for example both breathing ratios), each value then an array. */
export const gridSchema = z.record(z.string().min(1).max(400), z.array(z.unknown()).min(1).max(20))
  .refine(grid => Object.keys(grid).length > 0 && Object.keys(grid).length <= 8, 'Use 1-8 grid axes')

/** Sized to finish under 15 minutes on a 10-core laptop for the seven frozen
 * nights (tuning + validation is about 28 night-hours per candidate). HR error
 * depends only on the two heart-rate parameters; the breathing ratios and
 * minimumWindows axis is varied jointly so the grid still covers them. */
export const DEFAULT_GRID = {
  'heart_rate.trackingToleranceBpm': [10, 15, 20],
  'heart_rate.trackingHistoryLength': [3, 5, 8],
  'breathing_rate.intervalLowerRatio,breathing_rate.intervalUpperRatio,hrv_index.minimumWindows': [[0.5, 1.5, 10], [0.4, 1.7, 20]],
} satisfies z.input<typeof gridSchema>

// Keep sign and decimal point so -1 and 1 stay distinct ids.
const label = (value: unknown) => String(value).replace(/^-/, 'm').replace(/[^A-Za-z0-9.]/g, '_')
const short = (path: string) => ({
  'heart_rate.trackingToleranceBpm': 'tol', 'heart_rate.trackingHistoryLength': 'hist',
  'breathing_rate.intervalLowerRatio': 'brlo', 'breathing_rate.intervalUpperRatio': 'brhi',
  'hrv_index.harmonicTolerance': 'harm', 'hrv_index.minimumWindows': 'mw',
} as Record<string, string>)[path] ?? (path.split('.').at(-1) ?? path).replace(/[^A-Za-z0-9_.-]/g, '_')

export function expandGrid(raw: unknown): Candidate[] {
  const grid = gridSchema.parse(raw)
  const axes = Object.entries(grid).map(([key, values]) => {
    const paths = key.split(',')
    return values.map((value) => {
      const parts = paths.length === 1 ? [value] : value
      if (!Array.isArray(parts) || parts.length !== paths.length) throw new Error(`Grid axis ${key} needs ${paths.length} values per entry`)
      return paths.map((path, index) => ({ path, value: parts[index] }))
    })
  })
  let combos: Array<Array<{ path: string, value: unknown }>> = [[]]
  for (const axis of axes) combos = combos.flatMap(combo => axis.map(level => [...combo, ...level]))
  if (combos.length > 500) throw new Error('Grid expands to more than 500 candidates')
  const seen = new Map<string, number>()
  const candidates = combos.map((overrides) => {
    let id = overrides.map(row => `${short(row.path)}${label(row.value)}`).join('-').replace(/^[^A-Za-z0-9]+/, '')
    // Long combinations keep a readable prefix plus a hash of the exact overrides.
    if (id.length > 80) id = `${id.slice(0, 67)}-${createHash('sha256').update(JSON.stringify(overrides)).digest('hex').slice(0, 12)}`
    const repeat = seen.get(id) ?? 0
    seen.set(id, repeat + 1)
    return { id: repeat ? `${id.slice(0, 76)}-${repeat + 1}` : id, overrides }
  })
  return candidateFileSchema.parse(candidates)
}
