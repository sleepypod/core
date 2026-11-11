import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { coolingLeaseSchema, type CoolingLease } from './cooling'

/** Both records are committed before any command; a reused feedback ID never starts twice. */
export function createCoolingStore(database: Database.Database) {
  const selectLease = database.prepare('SELECT record FROM temporary_cooling WHERE side=?')
  const read = (side: Side): CoolingLease | null => {
    const row = selectLease.get(side) as { record: string } | undefined
    if (!row) return null
    const lease = coolingLeaseSchema.parse(JSON.parse(row.record))
    if (lease.side !== side) throw new Error('Cooling side does not match its record')
    return lease
  }
  const write = (side: Side, value: CoolingLease | null) => {
    if (!value) {
      database.prepare('DELETE FROM temporary_cooling WHERE side=?').run(side)
      return
    }
    const lease = coolingLeaseSchema.parse(value)
    if (lease.side !== side) throw new Error('Cooling side does not match its record')
    database.prepare('INSERT INTO temporary_cooling (side,record) VALUES (?,?) ON CONFLICT(side) DO UPDATE SET record=excluded.record')
      .run(side, JSON.stringify(lease))
  }
  const begin = database.transaction((value: CoolingLease) => {
    const lease = coolingLeaseSchema.parse(value)
    if (lease.phase !== 'prepared' || read(lease.side)) throw new Error('A cooling request already exists')
    database.prepare('INSERT INTO comfort_moments (id,side,recorded_at,record) VALUES (?,?,?,?)').run(
      lease.id, lease.side, lease.startedAt, JSON.stringify({ version: 1, feeling: 'too_hot', source: 'owner_manual',
        attribution: 'physical_zone_only', scope: lease.scope, requestedTargetF: lease.targetF,
        priorTargetF: lease.fromTargetF, expiresAt: lease.expiresAt, physicalVerification: 'unverified' }))
    write(lease.side, lease)
  })
  return { read, write, begin }
}
