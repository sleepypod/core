import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { DeviceStatus } from '@/src/hardware/types'
import type { ControlAction } from '@/src/controls/contract'
import type { HouseholdCredential, HouseholdStore } from './store'
import { HouseholdError } from './store'
import type { HouseholdSession } from './contract'
import { personalBedSchema, type PersonalBed } from './bedContract'
import { PersonalControlService } from './personalControls'
import { PersonalRuntimeAuthority } from './runtimeAuthority'

type Side = 'left' | 'right'
export interface PersonalObservation { observedAt: number, status: DeviceStatus }
export interface PersonalRuntimeDependencies {
  database: Database.Database
  identities: HouseholdStore
  enabled: () => boolean
  observe: () => Promise<PersonalObservation | null>
  requestedTarget: (side: Side) => number | null
  execute: (action: ControlAction) => Promise<unknown>
  now?: () => number
  runId?: string
}

/** One process-wide instance owns receipts; each request pins its own browser scope. */
export class PersonalRuntime {
  readonly authority: PersonalRuntimeAuthority
  private readonly controls: PersonalControlService
  private readonly now: () => number

  constructor(private readonly dependencies: PersonalRuntimeDependencies) {
    this.now = dependencies.now ?? Date.now
    this.authority = new PersonalRuntimeAuthority(dependencies.database, dependencies.identities, dependencies.enabled)
    this.controls = new PersonalControlService({ database: dependencies.database, runId: dependencies.runId ?? randomUUID(),
      authenticate: credential => this.authority.principal(credential), authorize: credential => this.authority.authorize(credential),
      execute: dependencies.execute, now: this.now })
  }

  session(session: HouseholdSession) { return this.authority.present(session) }

  async bed(credential: HouseholdCredential, assertRequestCurrent: () => void): Promise<PersonalBed> {
    assertRequestCurrent()
    const before = this.authority.resolve(credential)
    let observation: PersonalObservation | null = null
    if (before.availability === 'ready') {
      try {
        observation = await this.dependencies.observe()
      }
      catch { /* An unavailable observation is not a cached temperature. */ }
    }
    assertRequestCurrent()
    const current = this.authority.resolve(credential)
    if (JSON.stringify(before.scope) !== JSON.stringify(current.scope) || before.availability !== current.availability)
      throw new HouseholdError('conflict', 409, 'Your account or bed configuration changed while reading. Reload your personal view.')
    const age = observation ? this.now() - observation.observedAt : Number.NaN
    const fresh = observation !== null && Number.isSafeInteger(observation.observedAt) && observation.observedAt > 0 && age >= 0 && age < 15_000
    const freshObservation = fresh ? observation : null
    const status = freshObservation?.status ?? null
    // Construct explicitly from authorized zones: no other-side vitals, gesture,
    // Wi-Fi, alarms, room identity or raw diagnostics pass through this endpoint.
    const result: PersonalBed = {
      version: 1, scope: current.scope, arrangement: current.session.arrangement.mode, availability: current.availability,
      routing: { temperature: current.zones, power: current.zones, vibrationCancellation: current.zones,
        scheduledVibration: current.routineSide ? [current.routineSide] : [], routines: current.routineSide },
      observation: { state: status ? 'fresh' : 'unavailable', observedAt: freshObservation?.observedAt ?? null,
        water: status?.waterLevel ?? 'unknown', priming: status?.isPriming ?? null },
      zones: current.zones.map((side) => {
        const measured = status ? (side === 'left' ? status.leftSide : status.rightSide) : null
        let requestedTargetF: number | null = null
        try {
          requestedTargetF = this.dependencies.requestedTarget(side)
        }
        catch { /* An unreadable intent is not evidence of a requested value. */ }
        return { side, measuredTemperatureF: measured?.currentTemperature ?? null, reportedTargetF: measured?.targetTemperature ?? null,
          reportedPowered: measured ? (measured.targetLevel === 0 ? false : measured.heatingDuration > 0 ? true : null) : null,
          requestedTargetF }
      }),
      physicalVerification: 'unverified',
    }
    return personalBedSchema.parse(result)
  }

  submit(credential: HouseholdCredential, input: unknown, assertRequestCurrent: () => void) {
    return this.controls.submit(credential, input, assertRequestCurrent)
  }

  receipt(credential: HouseholdCredential, requestId: string, assertRequestCurrent: () => void) {
    assertRequestCurrent()
    return this.controls.get(credential, requestId)
  }
}
