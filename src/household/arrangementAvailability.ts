import type Database from 'better-sqlite3'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import type { HouseholdSession } from './contract'
import type { ArrangementReview } from './arrangementContract'

/** Deployment opt-in enables the attended workflow, never a startup side change. */
export function arrangementActivationEnabled(environment: Readonly<Record<string, string | undefined>>) {
  return ['SLEEPYPOD_HOUSEHOLD_PREPARATION', 'SLEEPYPOD_PERSONAL_RUNTIME', 'SLEEPYPOD_PERSONAL_ROUTINES',
    'SLEEPYPOD_PERSONAL_HISTORY', 'SLEEPYPOD_ARRANGEMENT_REVIEW', 'SLEEPYPOD_ARRANGEMENT_ACTIVATION']
    .every(name => environment[name] === '1')
}

/** Availability is a read-only software capability. Commit still requires fresh physical evidence. */
export function arrangementCanStart(database: Database.Database, session: HouseholdSession, enabled: boolean) {
  if (!enabled || session.role !== 'owner' || session.arrangement.mode !== 'solo-anywhere') return false
  try {
    if (new HardwareAdmissionStore(database).read().holdId !== null) return false
    return !database.prepare(`SELECT id FROM household_arrangement_transitions
      WHERE household_id = ? AND state IN ('held', 'committed') AND recovery IS NULL LIMIT 1`)
      .get(session.householdId)
  }
  catch { return false }
}

export function arrangementCanActivateReview(session: HouseholdSession, review: ArrangementReview, available: boolean) {
  return available && review.householdId === session.householdId && review.podId === session.podId
    && review.sleeperId === session.selfSleeperId && review.assignmentRevision === session.assignmentRevision
    && review.state === 'approved_for_separate_activation' && review.self.approved && review.partner.approved
}
