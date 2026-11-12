import type { HouseholdSession } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import type { PersonalRuntimeAuthority } from './runtimeAuthority'
import { personalExperimentAccess } from '@/src/comfort/experiments/execution-access'
import type { ComfortExperimentService } from '@/src/comfort/experiments/service'
import { experimentErrorResponse, experimentResponse } from '@/src/comfort/experiments/http'

export class PersonalExperimentApi {
  constructor(private readonly identities: HouseholdStore, private readonly authority: PersonalRuntimeAuthority,
    private readonly experiments: ComfortExperimentService, private readonly now = Date.now) {}

  present(session: HouseholdSession): HouseholdSession {
    return { ...session, capabilities: { ...session.capabilities, comfortExperiments: true } }
  }

  response(request: Request, credential: HouseholdCredential, body: unknown, assertRequestCurrent: () => void) {
    const authorize = () => {
      assertRequestCurrent()
      const session = this.identities.session(credential)
      if (!request.headers.has('authorization') && request.headers.get('x-sleepypod-sleeper-id') !== session.selfSleeperId)
        throw new HouseholdError('conflict', 409, 'Reload your personal account before opening experiments.')
      const bed = this.authority.resolveSession(session)
      return personalExperimentAccess(session, bed)
    }
    try {
      return experimentResponse(request, body, this.experiments, authorize, this.now)
    }
    catch (error) {
      if (error instanceof HouseholdError) throw error
      return experimentErrorResponse(error)
    }
  }
}
