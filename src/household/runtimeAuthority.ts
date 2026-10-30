import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { HouseholdSession } from './contract'
import type { HouseholdCredential, HouseholdStore } from './store'
import { HouseholdError } from './store'
import type { PersonalControlAuthority, PersonalControlPrincipal } from './personalControls'
import type { PersonalBed } from './bedContract'

type Side = 'left' | 'right'
interface HouseholdConfiguration {
  mode: 'solo-anywhere' | 'assigned'
  source_side: Side
  assignment_revision: number
}
interface PhysicalConfiguration {
  bed_mode: string
  unused_zone_mode: string
  timezone: string | null
}
interface AssignedAccount { id: string, sleeper_id: string, role: string, assigned_side: Side | null }
export interface ResolvedPersonalBed {
  scope: PersonalControlAuthority['scope']
  availability: PersonalBed['availability']
  zones: Side[]
  routineSide: Side | null
  session: HouseholdSession
}

/** Derive authority from the current database, never a side selected by the client. */
export class PersonalRuntimeAuthority {
  constructor(private readonly database: Database.Database, private readonly identities: HouseholdStore,
    private readonly enabled: () => boolean) {}

  principal(credential: HouseholdCredential): PersonalControlPrincipal {
    const session = this.identities.session(credential)
    return { accountId: session.accountId, podId: session.podId, householdId: session.householdId, sleeperId: session.selfSleeperId }
  }

  resolve(credential: HouseholdCredential): ResolvedPersonalBed {
    return this.resolveSession(this.identities.session(credential))
  }

  /** Session presentation and dispatch share the same fresh configuration check. */
  resolveSession(session: HouseholdSession): ResolvedPersonalBed {
    const household = this.database.prepare('SELECT mode, source_side, assignment_revision FROM households WHERE id = ?').get(session.householdId) as HouseholdConfiguration | undefined
    const physical = this.database.prepare('SELECT bed_mode, unused_zone_mode, timezone FROM device_settings ORDER BY id LIMIT 1').get() as PhysicalConfiguration | undefined
    const accounts = this.database.prepare('SELECT id, sleeper_id, role, assigned_side FROM household_accounts WHERE household_id = ? AND state = \'active\' ORDER BY id').all(session.householdId) as AssignedAccount[]
    const modes = this.database.prepare('SELECT side, away_mode FROM side_settings ORDER BY side').all()
    const configurationRevision = createHash('sha256').update(JSON.stringify({ household, physical, accounts, modes })).digest('hex')
    const result: ResolvedPersonalBed = {
      scope: { podId: session.podId, householdId: session.householdId, sleeperId: session.selfSleeperId,
        sessionRevision: session.sessionRevision, assignmentRevision: session.assignmentRevision, configurationRevision },
      availability: 'configuration_changed', zones: [], routineSide: null, session,
    }
    if (!this.enabled()) return { ...result, availability: 'runtime_disabled' }
    const self = accounts.find(account => account.id === session.accountId && account.sleeper_id === session.selfSleeperId)
    if (!household || !self || household.assignment_revision !== session.assignmentRevision || !physical
      || !['solo-anywhere', 'assigned'].includes(household.mode) || !['left', 'right'].includes(household.source_side)) return result
    if (household.mode === 'solo-anywhere') {
      if (session.role !== 'owner') return { ...result, availability: 'unassigned' }
      const owner = accounts.filter(account => account.role === 'owner')
      if (owner.length !== 1 || owner[0].id !== self.id || accounts.some(account => account.assigned_side !== null)
        || physical.bed_mode !== `solo-${household.source_side}` || physical.unused_zone_mode !== 'follow') return result
      return { ...result, availability: 'ready', zones: ['left', 'right'], routineSide: household.source_side }
    }
    if (accounts.length !== 2 || new Set(accounts.map(account => account.assigned_side)).size !== 2
      || accounts.some(account => !['left', 'right'].includes(account.assigned_side ?? '')) || physical.bed_mode !== 'two') return result
    const assigned = self.assigned_side
    if (!assigned) return { ...result, availability: 'unassigned' }
    return { ...result, availability: 'ready', zones: [assigned], routineSide: assigned }
  }

  authorize(credential: HouseholdCredential): PersonalControlAuthority {
    const result = this.resolve(credential)
    if (result.availability !== 'ready')
      throw new HouseholdError(result.availability === 'unassigned' ? 'forbidden' : 'not_ready', result.availability === 'unassigned' ? 403 : 409,
        'Your personal bed controls are unavailable. Review the current assignment and controller configuration.')
    return { scope: result.scope, zones: result.zones }
  }

  present(session: HouseholdSession): HouseholdSession {
    return { ...session, capabilities: { ...session.capabilities, personalControls: this.resolveSession(session).availability === 'ready' } }
  }
}
