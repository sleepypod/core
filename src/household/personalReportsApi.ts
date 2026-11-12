import type { HouseholdSession } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import { reportErrorResponse, reportResponse } from '@/src/reports/http'
import type { MorningReportStore } from '@/src/reports/store'

export class PersonalReportsApi {
  constructor(private readonly identities: HouseholdStore, private readonly reports: MorningReportStore, private readonly now = Date.now) {}

  present(session: HouseholdSession): HouseholdSession {
    return { ...session, capabilities: { ...session.capabilities, personalReports: true } }
  }

  response(request: Request, credential: HouseholdCredential, body: unknown, assertRequestCurrent: () => void) {
    const authorize = () => {
      assertRequestCurrent()
      const session = this.identities.session(credential)
      if (!request.headers.has('authorization') && request.headers.get('x-sleepypod-sleeper-id') !== session.selfSleeperId)
        throw new HouseholdError('conflict', 409, 'Reload your personal account before opening reports.')
      return {
        identity: { kind: 'personal' as const, podId: session.podId, householdId: session.householdId,
          accountId: session.accountId, sleeperId: session.selfSleeperId },
        scope: { podId: session.podId, householdId: session.householdId, accountId: session.accountId, sleeperId: session.selfSleeperId,
          sessionRevision: session.sessionRevision, householdRevision: session.householdRevision, assignmentRevision: session.assignmentRevision },
      }
    }
    try {
      return reportResponse(request, body, this.reports, authorize, this.now)
    }
    catch (error) {
      if (error instanceof HouseholdError) throw error
      return reportErrorResponse(error)
    }
  }
}
