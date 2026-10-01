import type { TempUnit } from '@/src/lib/tempUtils'
import { displayToSetpointF } from '@/src/lib/tempUtils'
import { getCaller } from './caller'

/** Resolve the unit a tool should use: explicit argument, else device setting. */
export async function resolveUnit(requested: TempUnit | undefined): Promise<TempUnit> {
  if (requested) return requested
  const settings = await getCaller().settings.getAll({})
  return settings.device.temperatureUnit === 'C' ? 'C' : 'F'
}

/** Convert a caller-supplied temperature into the integer °F the hardware takes. */
export function toSetpointF(value: number, unit: TempUnit): number {
  const f = displayToSetpointF(value, unit)
  if (f === null) throw new Error('Temperature is required')
  return Math.round(f)
}
