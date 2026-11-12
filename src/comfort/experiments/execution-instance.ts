import { sqlite } from '@/src/db'
import { getComfortOwner, getComfortRuntimeIfRunning, readComfortContext } from '../instance'
import { createComfortStore } from '../store'
import { pendingManualPause } from '../manual'
import { getTemperatureControllerIfRunning } from '@/src/temperature/instance'
import { withSideLock } from '@/src/hardware/sideLock'
import { getOccupancy } from '@/src/lib/occupancy'
import { HouseholdStore } from '@/src/household/store'
import { PersonalRuntimeAuthority } from '@/src/household/runtimeAuthority'
import { experimentDigest } from './access'
import { ExperimentExecutionIdentity } from './execution-access'
import { ExperimentExecutionHost } from './execution'

const shared = globalThis as typeof globalThis & { __sp_experimentHost?: ExperimentExecutionHost
  __sp_experimentIdentity?: ExperimentExecutionIdentity }

export function getExperimentExecutionIdentity(): ExperimentExecutionIdentity {
  if (!shared.__sp_experimentIdentity) {
    const identities = new HouseholdStore(sqlite)
    const authority = new PersonalRuntimeAuthority(sqlite, identities,
      () => process.env.SLEEPYPOD_HOUSEHOLD_PREPARATION === '1' && process.env.SLEEPYPOD_PERSONAL_RUNTIME === '1')
    shared.__sp_experimentIdentity = new ExperimentExecutionIdentity(sqlite, identities, authority, () => {
      const token = process.env.SLEEPYPOD_AUTH_TOKEN
      return token && token.length >= 32 ? experimentDigest(['owner-credential-revision', token]) : null
    })
  }
  return shared.__sp_experimentIdentity
}

/** Join the existing lifecycle; neither construction nor reads start hardware. */
export function getExperimentExecution(): ExperimentExecutionHost {
  if (!shared.__sp_experimentHost) {
    shared.__sp_experimentHost = new ExperimentExecutionHost({
      database: sqlite, now: Date.now, monotonicNow: () => performance.now(),
      enabled: () => getComfortRuntimeIfRunning()?.isRunning() === true,
      pendingManualPause, subject: principal => getExperimentExecutionIdentity().subject(principal),
      resolve: principal => getExperimentExecutionIdentity().resolve(principal),
      owner: getComfortOwner(), withSideLock,
      authority: { replacePolicy: (...arguments_) => {
        // Cold startup waits for the first firmware poll before constructing the shared authority.
        const authority = getTemperatureControllerIfRunning()
        if (!authority) throw new Error('The shared temperature authority is not running')
        return authority.replacePolicy(...arguments_)
      } },
      sample: (side, at, identity) => {
        const state = createComfortStore(sqlite).read(side)
        const { context } = readComfortContext(side, state, at, false)
        const presence = getOccupancy(side)
        const presenceAt = presence.level.sampleAt ?? null
        const known = presence.available && presenceAt !== null && Number.isSafeInteger(presenceAt)
          && presenceAt <= at && at - presenceAt < 30_000 && /^[a-f0-9]{64}$/.test(presence.level.sourceKey ?? '')
        return { at, deviceAt: context.device.observedAt, presenceAt: known ? presenceAt : null,
          targetF: context.device.targetF, powered: context.device.powered,
          occupied: known ? presence.classification === 'person' && presence.level.active : null,
          waterAdequate: context.device.waterAdequate, priming: context.device.priming,
          vibrating: context.device.vibrating, baseMoving: context.device.baseMoving,
          bindingHash: identity.bindingHash, routineHash: identity.routineHash, wakeHash: identity.wakeHash,
          // Execution must not recursively call authority.status; the separate collector reads selection provenance.
          selectedRequestId: null, attributionAmbiguous: !known }
      },
    })
  }
  return shared.__sp_experimentHost
}

export function getExperimentExecutionIfRunning(): ExperimentExecutionHost | undefined {
  return shared.__sp_experimentHost
}
