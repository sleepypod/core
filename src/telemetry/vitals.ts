import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { isMechanicallyQualifiedVital } from '@/src/biometrics/mechanical/eligibility'
import { readMechanicalSnapshot } from '@/src/biometrics/mechanical/snapshot'
import { finite, sample } from './sample'

export function readHomeVitals(database: Database.Database, side: Side, now: number) {
  const empty = () => sample('qualified_live_bcg', null, 300_000, now,
    { heartRate: null, breathingRate: null, hrv: null })
  try {
    return database.transaction(() => {
      const row = database.prepare('SELECT id, timestamp, heart_rate, breathing_rate, hrv FROM vitals WHERE side=? ORDER BY timestamp DESC, id DESC LIMIT 1')
        .get(side) as { id: number, timestamp: number, heart_rate: unknown, breathing_rate: unknown, hrv: unknown } | undefined
      if (!row) return empty()
      const reading = sample('qualified_live_bcg', row.timestamp * 1000, 300_000, now,
        { heartRate: finite(row.heart_rate, 0), breathingRate: finite(row.breathing_rate, 0), hrv: finite(row.hrv, 0) },
        isMechanicallyQualifiedVital(database, row.id, now))
      const context = reading.available ? readMechanicalSnapshot(database, now)?.state : null
      return { ...reading,
        expiresAt: context && reading.expiresAt ? Math.min(reading.expiresAt, context.validUntilMs) : reading.expiresAt,
        variabilityMetric: 'window_ibi_variability_v1' }
    })()
  }
  catch { return empty() }
}
