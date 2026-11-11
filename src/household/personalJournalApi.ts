import type { z } from 'zod'
import { householdIdSchema, type HouseholdSession } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import type { PersonalJournalStore } from './personalJournal'
import { parsePersonalJournalQuery, personalJournalReadResponseSchema, personalJournalWriteResponseSchema } from './personalJournalContract'
import { parsePersonalJournalPatternsQuery, personalJournalPatterns, personalJournalPatternsResponseSchema } from './personalJournalPatterns'

export class PersonalJournalApi {
  constructor(private readonly dependencies: { identities: HouseholdStore, journal: PersonalJournalStore, enabled: () => boolean, now?: () => number }) {}

  present(session: HouseholdSession): HouseholdSession {
    const enabled = this.dependencies.enabled()
    return { ...session, capabilities: { ...session.capabilities, personalJournal: enabled, personalJournalPatterns: enabled } }
  }

  /** A save happens once; response delivery only revalidates identity and reads its metadata-only receipt. */
  response(request: Request, credential: HouseholdCredential, body: unknown, assertRequestCurrent: () => void) {
    const url = new URL(request.url), path = url.pathname.replace(/\/$/, '')
    const assertAccess = () => {
      if (request.signal.aborted) throw new HouseholdError('conflict', 409, 'The check-in request was interrupted.')
      assertRequestCurrent()
      const session = this.dependencies.identities.session(credential)
      if (!request.headers.has('authorization') && request.headers.get('x-sleepypod-sleeper-id') !== session.selfSleeperId)
        throw new HouseholdError('conflict', 409, 'Reload your personal account before opening check-ins.')
      if (!this.dependencies.enabled()) throw new HouseholdError('not_ready', 409, 'Personal check-ins are unavailable.')
      return session
    }
    assertAccess()
    let select: () => object, schema: z.ZodType
    if (path === '/api/v1/me/journal' && request.method === 'POST') {
      if (url.search) throw new HouseholdError('invalid_request', 400, 'Check-in saves do not accept query fields.')
      const receipt = this.dependencies.journal.write(credential, body)
      select = () => ({ receipt: this.dependencies.journal.receipt(credential, receipt.requestId) })
      schema = personalJournalWriteResponseSchema
    }
    else {
      try {
        if (!['GET', 'HEAD'].includes(request.method)) throw new Error('Unsupported method')
        if (path === '/api/v1/me/journal/patterns') {
          const query = parsePersonalJournalPatternsQuery(url.searchParams)
          select = () => ({ query, ...personalJournalPatterns(this.dependencies.journal.list(credential, query.from, query.through), generatedAt) })
          schema = personalJournalPatternsResponseSchema
        }
        else if (path === '/api/v1/me/journal') {
          const query = parsePersonalJournalQuery(url.searchParams)
          select = () => ({ query, currentTimeZone: this.dependencies.journal.currentTimeZone(), entries: 'date' in query
            ? [this.dependencies.journal.read(credential, query.date)]
            : this.dependencies.journal.list(credential, query.from, query.through) })
          schema = personalJournalReadResponseSchema
        }
        else {
          if (url.search || !path.startsWith('/api/v1/me/journal/requests/')) throw new Error('Invalid receipt route')
          const requestId = householdIdSchema.parse(path.slice('/api/v1/me/journal/requests/'.length))
          select = () => ({ receipt: this.dependencies.journal.receipt(credential, requestId) })
          schema = personalJournalWriteResponseSchema
        }
      }
      catch { throw new HouseholdError('invalid_request', 400, 'Choose one check-in date, a range of at most 90 dates, or a saved request.') }
    }
    const generatedAt = (this.dependencies.now ?? Date.now)()
    const read = () => {
      const session = assertAccess()
      try {
        return JSON.stringify(schema.parse({ version: 1, generatedAt, scope: { podId: session.podId, householdId: session.householdId,
          accountId: session.accountId, sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
          assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision },
        interpretation: 'personal_self_report_not_sleep_measurement', ...select() }))
      }
      catch (error) {
        if (error instanceof HouseholdError) throw error
        throw new HouseholdError('not_ready', 503, 'The saved check-in needs review before it can be displayed.')
      }
    }
    const payload = read()
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      try {
        if (read() !== payload) throw new Error('Personal check-in or access changed before delivery')
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      }
      catch { controller.error(new Error('Personal check-in or access changed before delivery')) }
    } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
      'Vary': 'Authorization, Cookie, X-Sleepypod-Sleeper-Id', 'X-Content-Type-Options': 'nosniff' } })
  }
}
