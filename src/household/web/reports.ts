import { householdSessionSchema, type HouseholdSession } from '../contract'
import type { PersonalWebTransport } from './client'
import { MorningReportBrowserWorkspace } from '@/src/reports/browserWorkspace'
import { reportIdSchema } from '@/src/reports/morning'

/** Uses only the signed-in person's transport, never the owner's report library. */
export function personalReportWorkspace(session: HouseholdSession, client: PersonalWebTransport) {
  const scope = (value: HouseholdSession) => ({ podId: value.podId, householdId: value.householdId, accountId: value.accountId,
    sleeperId: value.selfSleeperId, sessionRevision: value.sessionRevision, householdRevision: value.householdRevision, assignmentRevision: value.assignmentRevision })
  const anchor = scope(session)
  return new MorningReportBrowserWorkspace({
    async access(signal) {
      if (signal.aborted) throw new Error('Report read interrupted.')
      const current = householdSessionSchema.parse(await client.read('household/session'))
      if (signal.aborted || !current.capabilities.personalReports || JSON.stringify(scope(current)) !== JSON.stringify(anchor)) throw new Error('Personal report account changed.')
      return { scope: scope(current), revision: JSON.stringify(scope(current)) }
    },
    async read(id, signal) {
      if (signal.aborted) throw new Error('Report read interrupted.')
      const response = await client.read(id === null ? 'me/reports' : `me/reports/${reportIdSchema.parse(id)}`)
      if (signal.aborted) throw new Error('Report read interrupted.')
      return response
    },
  })
}
