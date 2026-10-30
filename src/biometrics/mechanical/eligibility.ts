import type Database from 'better-sqlite3'
import { parseVitalEvidence, VITAL_EVIDENCE_QUERY } from './vital-evidence'
import { readMechanicalSnapshot } from './snapshot'

/** Only fresh, proven live rows in the current quiet interval may drive rules.
 * Historical/legacy observations remain visible but never acquire new proof. */
export function isMechanicallyQualifiedVital(database: Database.Database, id: number, now: number): boolean {
  try {
    return database.transaction(() => {
      const snapshot = readMechanicalSnapshot(database, now)
      const state = snapshot?.state
      if (!state || state.reasons.length || !state.spanId || state.confirmedThroughMs === null
        || now >= state.validUntilMs || state.confirmedThroughMs > now) return false
      const { timestampMs, proof } = parseVitalEvidence(database.prepare(`${VITAL_EVIDENCE_QUERY} WHERE v.id=? LIMIT 1`).get(id))
      if (timestampMs > now || now - timestampMs > 300_000) return false
      return proof.epoch === state.epoch && proof.spanId === state.spanId && proof.endMs <= state.confirmedThroughMs
        && snapshot.spans.some(span => span.id === proof.spanId && span.epoch === proof.epoch
          && span.startMs <= proof.startMs && span.endMs >= proof.endMs)
    })()
  }
  catch { return false }
}
