/**
 * Who is in bed now: each side's away mode and the bed mode, read the way
 * the scheduler reads them (jobManager awayModes), for alarm code outside it.
 */
import { db } from '@/src/db'
import { deviceSettings, sideSettings } from '@/src/db/schema'
import type { BedState } from '@/src/lib/singleSleeper'

export async function readAwayModes(): Promise<BedState> {
  const rows = await db.select({ side: sideSettings.side, awayMode: sideSettings.awayMode }).from(sideSettings)
  const [config] = await db.select({ bedMode: deviceSettings.bedMode, unusedZoneMode: deviceSettings.unusedZoneMode }).from(deviceSettings).limit(1)
  return { ...Object.fromEntries(rows.map(r => [r.side, { awayMode: r.awayMode }])), ...config }
}
