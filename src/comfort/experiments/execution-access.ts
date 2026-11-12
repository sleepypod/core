import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import type { HouseholdSession } from '@/src/household/contract'
import type { HouseholdStore } from '@/src/household/store'
import { type HouseholdCredential } from '@/src/household/store'
import type { PersonalRuntimeAuthority } from '@/src/household/runtimeAuthority'
import { type ResolvedPersonalBed } from '@/src/household/runtimeAuthority'
import { experimentDigest, legacyExperimentAccess, type ExperimentAccess } from './access'
import { experimentPrincipalSchema, type ExperimentPrincipal } from './execution-principal'

function personalIdentity(session: HouseholdSession) {
  return { kind: 'personal', podId: session.podId, householdId: session.householdId,
    accountId: session.accountId, sleeperId: session.selfSleeperId }
}

export function personalExperimentAccess(session: HouseholdSession, bed: ResolvedPersonalBed): ExperimentAccess {
  const identity = personalIdentity(session)
  return { subjectKey: experimentDigest(identity),
    scope: { ...identity, sessionRevision: session.sessionRevision, assignmentRevision: session.assignmentRevision,
      householdRevision: session.householdRevision },
    binding: { ...identity, configurationRevision: bed.scope.configurationRevision, assignmentRevision: session.assignmentRevision },
    routineSide: bed.routineSide, ready: bed.availability === 'ready' }
}

export interface ExperimentExecutionAccess { access: ExperimentAccess, zones: Side[] }

/** Recheck account, device and assignment from persisted state at every scheduled dispatch. */
export class ExperimentExecutionIdentity {
  constructor(private readonly database: Database.Database, private readonly identities: HouseholdStore,
    private readonly authority: PersonalRuntimeAuthority, private readonly ownerRevision: () => string | null) {}

  legacyPrincipal(): ExperimentPrincipal {
    const access = legacyExperimentAccess(this.database), scope = access.scope as { installationId: string }
    const reference = experimentPrincipalSchema.parse({ kind: 'legacy', installationId: scope.installationId,
      credentialRevision: this.ownerRevision() })
    this.subject(reference)
    return reference
  }

  personalPrincipal(credential: HouseholdCredential): ExperimentPrincipal {
    const reference: ExperimentPrincipal = { kind: 'personal',
      deviceId: typeof credential === 'string' ? this.identities.deviceIdentity(credential) : credential.deviceId }
    this.subject(reference)
    return reference
  }

  private legacyAccess(principal: Extract<ExperimentPrincipal, { kind: 'legacy' }>): ExperimentAccess {
    if (principal.credentialRevision !== this.ownerRevision()
      || this.database.prepare('SELECT id FROM household_privacy_boundary LIMIT 1').get())
      throw new Error('The original owner authorization is no longer available')
    const access = legacyExperimentAccess(this.database)
    if ((access.scope as { installationId: string }).installationId !== principal.installationId)
      throw new Error('The original solo arrangement changed')
    return access
  }

  /** Cancellation needs a current account, not an unchanged bed arrangement or active service. */
  subject(input: ExperimentPrincipal): string {
    const principal = experimentPrincipalSchema.parse(input)
    return principal.kind === 'legacy'
      ? this.legacyAccess(principal).subjectKey
      : experimentDigest(personalIdentity(this.identities.session({ deviceId: principal.deviceId })))
  }

  resolve(input: ExperimentPrincipal): ExperimentExecutionAccess {
    const principal = experimentPrincipalSchema.parse(input)
    if (principal.kind === 'legacy') {
      const access = this.legacyAccess(principal)
      if (!access.ready)
        throw new Error('The original solo arrangement changed')
      return { access, zones: ['left', 'right'] }
    }
    const session = this.identities.session({ deviceId: principal.deviceId }), bed = this.authority.resolveSession(session)
    const access = personalExperimentAccess(session, bed)
    if (!access.ready || !bed.zones.length) throw new Error('The personal device or assignment is unavailable')
    return { access, zones: bed.zones }
  }
}
