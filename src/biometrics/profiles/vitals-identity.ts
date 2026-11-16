import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as bioSchema from '@/src/db/biometrics-schema'
import type { ActualVitals } from '@/src/lib/stage-model-set'
import { vitalsConfiguration } from './vital-summary-provenance'

const { biometricProcessingRuns: runs, vitals } = bioSchema
type BioDb = BetterSQLite3Database<typeof bioSchema>

function parse(identity: string): ActualVitals {
  const [engine, profile] = identity.split(':')
  return { engine, profile }
}

/**
 * The engine and profile that produced a side's vitals in [start, end], from each row's processing
 * run. Several identities (a profile change or update mid-night) are `mixed`, as is a night only
 * partly recorded; a night with no recorded run is `unknown`; null means the window has no vitals.
 */
export function nightVitalsIdentity(bioDb: BioDb, side: 'left' | 'right', start: Date, end: Date): ActualVitals | null {
  const groups = bioDb.select({ identity: sql<string | null>`${vitalsConfiguration}` })
    .from(vitals)
    .leftJoin(runs, and(eq(vitals.processingRunId, runs.id), eq(vitals.side, runs.side)))
    .where(and(eq(vitals.side, side), gte(vitals.timestamp, start), lte(vitals.timestamp, end)))
    .groupBy(sql`1`)
    .limit(2)
    .all()
  if (groups.length === 0) return null
  if (groups.length > 1) return 'mixed'
  return groups[0].identity === null ? 'unknown' : parse(groups[0].identity)
}

/** What the side's vitals are produced with now: its latest live processing run. */
export function currentVitalsIdentity(bioDb: BioDb, side: 'left' | 'right'): ActualVitals {
  const row = bioDb.select({ identity: sql<string | null>`${vitalsConfiguration}` })
    .from(runs)
    .where(and(eq(runs.side, side), eq(runs.kind, 'live')))
    .orderBy(desc(runs.startedAtMs))
    .limit(1)
    .get()
  return row?.identity ? parse(row.identity) : 'unknown'
}
