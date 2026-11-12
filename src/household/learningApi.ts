import { z } from 'zod'
import { householdIdSchema, type HouseholdSession } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import type { PersonalLearningLibrary } from './learningLibrary'
import { learningArchiveLimits } from './learningArchiveContract'
import { learningArchivePageSchema, learningRecordDetailSchema, learningRecordPageSchema, parseLearningSearch } from './learningApiContract'
import { learningRemovalResponse } from './learningRemovalApi'

export class PersonalLearningApi {
  constructor(private readonly dependencies: { identities: HouseholdStore, library: PersonalLearningLibrary, enabled: () => boolean, now?: () => number }) {}

  present(session: HouseholdSession): HouseholdSession {
    return { ...session, capabilities: { ...session.capabilities, personalLearningArchive: this.dependencies.enabled(),
      personalLearningRemoval: this.dependencies.enabled() } }
  }

  /** Personal output is checked again on delivery; account switches and revocation withdraw queued bytes. */
  response(request: Request, credential: HouseholdCredential, assertRequestCurrent: () => void, body?: unknown): Response {
    const url = new URL(request.url), path = url.pathname.replace(/\/$/, '')
    if (path.startsWith('/api/v1/me/learning/requests/') || path.endsWith('/remove'))
      return learningRemovalResponse(this.dependencies, request, credential, assertRequestCurrent, body)
    const generatedAt = (this.dependencies.now ?? Date.now)()
    let select: () => object
    let schema: z.ZodType
    try {
      if (path === '/api/v1/me/learning/archives' || path === '/api/v1/me/learning/records') {
        const parsed = parseLearningSearch(url.searchParams, path.endsWith('/records'))
        if ('archiveId' in parsed) {
          select = () => ({ query: parsed, ...this.dependencies.library.records(credential, parsed.archiveId, parsed.after, parsed.limit) })
          schema = learningRecordPageSchema
        }
        else {
          select = () => ({ query: parsed, ...this.dependencies.library.archives(credential, parsed.before, parsed.limit) })
          schema = learningArchivePageSchema
        }
      }
      else {
        if (url.search || !path.startsWith('/api/v1/me/learning/records/')) throw new Error('Record details do not accept query fields')
        const recordId = householdIdSchema.parse(path.slice('/api/v1/me/learning/records/'.length))
        select = () => this.dependencies.library.detail(credential, recordId)
        schema = learningRecordDetailSchema
      }
    }
    catch {
      throw new HouseholdError('invalid_request', 400, 'Choose a private archive and a page size between 1 and 50, using each query field once.')
    }
    const read = () => {
      if (request.signal.aborted) throw new HouseholdError('conflict', 409, 'The learning request was interrupted.')
      assertRequestCurrent()
      const session = this.dependencies.identities.session(credential)
      if (!request.headers.has('authorization') && request.headers.get('x-sleepypod-sleeper-id') !== session.selfSleeperId)
        throw new HouseholdError('conflict', 409, 'Reload your personal account before reading learning history.')
      if (!this.dependencies.enabled()) throw new HouseholdError('not_ready', 409, 'Private learning history is unavailable.')
      const serialized = JSON.stringify(schema.parse({ version: 1, generatedAt, scope: { podId: session.podId, householdId: session.householdId,
        accountId: session.accountId, sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
        assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision },
      interpretation: 'historical_custody_not_training_approval', ...select() }))
      if (Buffer.byteLength(serialized) > 2 * learningArchiveLimits.recordBytes + 64 * 1024)
        throw new HouseholdError('not_ready', 503, 'This private learning record is too large to deliver.')
      return serialized
    }
    let payload: string
    try {
      payload = read()
    }
    catch (error) {
      if (error instanceof z.ZodError) throw new HouseholdError('not_ready', 503, 'Private learning is unavailable until its stored records are checked.')
      throw error
    }
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      try {
        if (read() !== payload) throw new Error('Private learning changed before delivery')
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      }
      catch { controller.error(new Error('Private learning access or records changed before delivery')) }
    } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
      'Vary': 'Authorization, Cookie, X-Sleepypod-Sleeper-Id', 'X-Content-Type-Options': 'nosniff' } })
  }
}
