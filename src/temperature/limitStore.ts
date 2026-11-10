import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { comfortLimitConfigSchema, comfortLimitVersionSchema, defaultComfortLimit, type ComfortLimitConfig } from './limits'

export class ComfortLimitConflict extends Error {}

/** No row means a migration-safe disabled limit. Unreadable/corrupt rows never mean disabled. */
export function createComfortLimitStore(database: Database.Database) {
  const select = database.prepare('SELECT revision, config FROM temperature_limits WHERE side = ?')
  const read = (side: Side) => {
    const row = select.get(side) as { revision: number, config: string } | undefined
    return comfortLimitVersionSchema.parse(row
      ? { revision: row.revision, config: JSON.parse(row.config) }
      : { revision: 0, config: defaultComfortLimit })
  }
  const save = database.transaction((side: Side, expectedRevision: number, config: ComfortLimitConfig) => {
    const current = read(side)
    if (current.revision !== expectedRevision) throw new ComfortLimitConflict('The comfort limit changed. Refresh before saving.')
    const version = comfortLimitVersionSchema.parse({ revision: current.revision + 1, config: comfortLimitConfigSchema.parse(config) })
    database.prepare(`INSERT INTO temperature_limits (side, revision, config) VALUES (?, ?, ?)
      ON CONFLICT(side) DO UPDATE SET revision = excluded.revision, config = excluded.config`)
      .run(side, version.revision, JSON.stringify(version.config))
    return version
  })
  return { read, save }
}
