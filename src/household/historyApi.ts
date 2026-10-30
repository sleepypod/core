import type { HouseholdSession } from './contract'
import { z } from 'zod'
import { householdIdSchema } from './contract'
import type { HouseholdCredential, HouseholdStore } from './store'
import { HouseholdError } from './store'
import type { PersonHistoryStore } from './personHistory'
import { parsePersonalHistorySearch, personalHistoryDetailSchema, personalHistoryPageSchema } from './historyApiContract'

interface Dependencies {
  identities: HouseholdStore
  history: PersonHistoryStore
  enabled: () => boolean
  now?: () => number
}
const scope = (session: HouseholdSession) => ({
  podId: session.podId, householdId: session.householdId, accountId: session.accountId,
  sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
  householdRevision: session.householdRevision, assignmentRevision: session.assignmentRevision,
})

/** Read attributed records only. This cannot claim legacy rows, ingest Health or control hardware. */
export class PersonalHistoryApi {
  constructor(private readonly dependencies: Dependencies) {}

  present(session: HouseholdSession): HouseholdSession {
    return { ...session, capabilities: { ...session.capabilities, personalHistory: this.dependencies.enabled() } }
  }

  response(request: Request, credential: HouseholdCredential, assertRequestCurrent: () => void): Response {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/$/, '')
    const detailId = path === '/api/v1/me/sleep' ? null : householdIdSchema.parse(path.slice('/api/v1/me/sleep/'.length))
    let query: ReturnType<typeof parsePersonalHistorySearch> | null
    try {
      if (detailId !== null && url.search) throw new Error('Detail queries do not accept selectors')
      query = detailId === null ? parsePersonalHistorySearch(url.searchParams) : null
    }
    catch { throw new HouseholdError('invalid_request', 400, 'Choose a history kind and a UTC millisecond range of at most 90 days.') }
    const generatedAt = (this.dependencies.now ?? Date.now)()
    const read = () => {
      if (request.signal.aborted) throw new HouseholdError('conflict', 409, 'The history request was interrupted.')
      assertRequestCurrent()
      const session = this.dependencies.identities.session(credential)
      // A browser must pin its own account even for a read; another tab can change cookies.
      if (!request.headers.has('authorization') && request.headers.get('x-sleepypod-sleeper-id') !== session.selfSleeperId)
        throw new HouseholdError('conflict', 409, 'Reload your personal account before reading history.')
      if (!this.dependencies.enabled()) throw new HouseholdError('not_ready', 409, 'Personal history is not enabled on this controller.')
      const common = { version: 1, scope: scope(session), generatedAt, source: 'pod', interpretation: 'recordings_not_confirmed_sleep' }
      if (query) {
        const page = this.dependencies.history.records(credential, query)
        const range = { startsAt: query.startsAt, endsAt: query.endsAt, kind: query.kind, limit: query.limit }
        return personalHistoryPageSchema.parse({ ...common, attributionRevision: page.attributionRevision,
          query: range, intervalSelection: 'overlap_full_records', records: page.records, nextCursor: page.nextCursor })
      }
      if (detailId === null) throw new HouseholdError('invalid_request', 400, 'Select a personal history record.')
      const detail = this.dependencies.history.detail(credential, detailId)
      if (!detail.record) throw new HouseholdError('not_ready', 404, 'This personal record is unavailable.')
      return personalHistoryDetailSchema.parse({ ...common, attributionRevision: detail.attributionRevision, record: detail.record })
    }
    let payload: string
    try {
      payload = JSON.stringify(read())
    }
    catch (error) {
      if (error instanceof z.ZodError) throw new HouseholdError('not_ready', 503, 'Personal history is unavailable. Refresh after the recording store is checked.')
      throw error
    }
    // Do not enqueue private output before delivery. Re-reading also catches source
    // invalidation/epoch revocation after selection, not just device revocation.
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          if (JSON.stringify(read()) !== payload) throw new Error('History changed before delivery')
          controller.enqueue(new TextEncoder().encode(payload))
          controller.close()
        }
        catch { controller.error(new Error('Personal history access or records changed before delivery')) }
      },
    }, { highWaterMark: 0 }), { headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
      'Vary': 'Authorization, Cookie, X-Sleepypod-Sleeper-Id', 'X-Content-Type-Options': 'nosniff',
    } })
  }
}
