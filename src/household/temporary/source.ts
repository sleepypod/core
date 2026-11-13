import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/schema'
import { readBedtimeRoutineState } from '@/src/server/bedtimeRoutineTransaction'
import { householdIdSchema, personPreferencesSchema } from '../contract'
import { attributionEpochSchema } from '../historyContract'
import type { PersonHistorySource } from '../historySource'
import { arrangementDigest, arrangementPolicyDigest } from '../arrangementTransitionState'
import { HouseholdError } from '../store'
import { temporarySourceSchema, type TemporarySource } from './plan'

const unavailable = () => new HouseholdError('not_ready', 409,
  'The current arrangement, routines or recording source needs review before preparing a temporary change.')
interface HouseholdRow {
  id: string
  pod_id: string
  revision: number
  assignment_revision: number
  mode: 'solo-anywhere' | 'assigned'
  source_side: 'left' | 'right'
  effective_at: number
}
interface AccountRow {
  id: string
  sleeper_id: string
  display_name: string
  role: 'owner' | 'member'
  assigned_side: 'left' | 'right' | null
  session_revision: number
  preferences: string | null
  preferences_revision: number | null
  routines_revision: number | null
}
interface EpochRow {
  id: string
  starts_at: number
  mode: string
  assignments: string
  revoked_at: number | null
}

/** Read only persisted state. The caller holds the same transaction as the review/approval. */
export class TemporaryArrangementSource {
  constructor(private database: Database.Database, private historySource: PersonHistorySource, private now = Date.now) {}

  read(householdId: string): TemporarySource {
    householdIdSchema.parse(householdId)
    if (!this.database.inTransaction) throw new Error('Read temporary arrangement state inside its review transaction')
    const household = this.database.prepare('SELECT * FROM households WHERE id = ?').get(householdId) as HouseholdRow | undefined
    const devices = this.database.prepare('SELECT bed_mode, unused_zone_mode, timezone FROM device_settings ORDER BY id LIMIT 2').all() as {
      bed_mode: string
      unused_zone_mode: string
      timezone: string
    }[]
    const physical = devices[0]
    if (!household || devices.length !== 1 || !physical || household.effective_at > this.now()) throw unavailable()
    const accounts = this.database.prepare(`SELECT account.id, account.sleeper_id, account.display_name, account.role,
      account.assigned_side, account.session_revision, settings.preferences, settings.preferences_revision, settings.routines_revision
      FROM household_accounts account LEFT JOIN household_personal_settings settings ON settings.account_id = account.id
      WHERE account.household_id = ? AND account.state = 'active' ORDER BY account.id`).all(householdId) as AccountRow[]
    const store = drizzle(this.database, { schema })
    const live = (['left', 'right'] as const).map((side) => {
      const current = readBedtimeRoutineState(store, side)
      if (!current.canCreate) throw unavailable()
      return { side, records: current.records }
    })
    const people = accounts.map((account) => {
      const assignment = household.mode === 'solo-anywhere'
        ? account.role === 'owner' ? 'solo' as const : 'unassigned' as const
        : account.assigned_side
      if (assignment === null || (household.mode === 'solo-anywhere' && account.assigned_side !== null)
        || account.preferences === null || account.preferences_revision === null || account.routines_revision === null
        || (assignment !== 'unassigned' && account.preferences_revision <= 1)) throw unavailable()
      const side = assignment === 'solo' ? household.source_side : assignment
      const week = side === 'unassigned' ? [] : live.find(value => value.side === side)?.records
      if (!week) throw unavailable()
      return { accountId: account.id, sleeperId: account.sleeper_id, displayName: account.display_name, role: account.role,
        sessionRevision: account.session_revision, preferencesRevision: account.preferences_revision, draftRevision: account.routines_revision,
        assignment, preferences: personPreferencesSchema.parse(JSON.parse(account.preferences)),
        operatingWeek: week.map(value => ({ dayOfWeek: value.snapshot.dayOfWeek, draft: value.snapshot.draft })) }
    })
    const history = this.history(household, people)
    return temporarySourceSchema.parse({ version: 1, householdId, podId: household.pod_id,
      householdRevision: household.revision, assignmentRevision: household.assignment_revision, effectiveAt: household.effective_at,
      mode: household.mode, sourceSide: household.source_side, bedMode: physical.bed_mode, unusedZoneMode: physical.unused_zone_mode,
      timeZone: physical.timezone, people, history,
      policyDigest: arrangementDigest({ policy: arrangementPolicyDigest(this.database), live,
        sides: this.database.prepare('SELECT * FROM side_settings ORDER BY side').all() }) })
  }

  private history(household: HouseholdRow, people: TemporarySource['people']) {
    const binding = this.database.prepare('SELECT dataset_id FROM household_history_sources WHERE household_id = ?')
      .get(household.id) as { dataset_id: string } | undefined
    if (!binding) throw unavailable()
    const verified = this.historySource.verify(household.id, binding.dataset_id)
    const epochs = this.database.prepare(`SELECT * FROM household_attribution_epochs
      WHERE household_id = ? AND dataset_id = ? AND ends_at IS NULL ORDER BY starts_at LIMIT 2`)
      .all(household.id, verified.datasetId) as EpochRow[]
    const epoch = epochs[0]
    const solo = household.mode === 'solo-anywhere'
    if (epochs.length !== 1 || !epoch || epoch.revoked_at !== null || epoch.starts_at >= this.now()
      || epoch.mode !== (solo ? 'solo_merged' : 'assigned')) throw unavailable()
    const assignments = attributionEpochSchema.shape.assignments.parse(JSON.parse(epoch.assignments))
    const participants = people.filter(value => value.assignment !== 'unassigned')
    if (assignments.length !== participants.length || participants.some(person => !assignments.some(value =>
      value.sleeperId === person.sleeperId && value.recordedSide === (solo ? household.source_side : person.assignment)))) throw unavailable()
    const state = this.database.prepare('SELECT attribution_revision FROM household_history_state WHERE household_id = ?')
      .get(household.id) as { attribution_revision: number } | undefined
    if (!state) throw unavailable()
    return { datasetId: verified.datasetId, attributionRevision: state.attribution_revision,
      epochId: epoch.id, startsAt: epoch.starts_at, epochHash: arrangementDigest(epoch), sourceBindingHash: arrangementDigest(verified) }
  }
}
