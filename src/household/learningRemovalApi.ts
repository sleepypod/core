import { z } from 'zod'
import { householdIdSchema } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import type { PersonalLearningLibrary } from './learningLibrary'
import { learningRemovalRequestSchema, learningRemovalResponseSchema } from './learningRemovalContract'

/** Mutation is performed once; delayed delivery can only read a private, content-free receipt. */
export function learningRemovalResponse(dependencies: { identities: HouseholdStore, library: PersonalLearningLibrary, enabled: () => boolean, now?: () => number }, request: Request, credential: HouseholdCredential,
  assertRequestCurrent: () => void, body: unknown) {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, '')
  const assertAccess = () => {
    if (request.signal.aborted) throw new HouseholdError('conflict', 409, 'The removal request was interrupted.')
    assertRequestCurrent()
    const session = dependencies.identities.session(credential)
    if (!request.headers.has('authorization') && request.headers.get('x-sleepypod-sleeper-id') !== session.selfSleeperId)
      throw new HouseholdError('conflict', 409, 'Reload your personal account before removing archived content.')
    if (!dependencies.enabled()) throw new HouseholdError('not_ready', 409, 'Private learning history is unavailable.')
    return session
  }
  assertAccess()
  if (url.search) throw new HouseholdError('invalid_request', 400, 'Archive removal does not accept query fields.')
  let requestId: string
  if (request.method === 'POST') {
    const input = learningRemovalRequestSchema.parse(body)
    if (path !== `/api/v1/me/learning/records/${input.recordId}/remove`)
      throw new HouseholdError('invalid_request', 400, 'Review the same archived record before removing it.')
    requestId = dependencies.library.remove(credential, input).requestId
  }
  else {
    if (!['GET', 'HEAD'].includes(request.method) || !path.startsWith('/api/v1/me/learning/requests/'))
      throw new HouseholdError('invalid_request', 400, 'Choose a saved removal receipt.')
    requestId = householdIdSchema.parse(path.slice('/api/v1/me/learning/requests/'.length))
  }
  const generatedAt = (dependencies.now ?? Date.now)()
  const read = () => {
    const session = assertAccess()
    try {
      return JSON.stringify(learningRemovalResponseSchema.parse({ version: 1, generatedAt,
        scope: { podId: session.podId, householdId: session.householdId, accountId: session.accountId,
          sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
          householdRevision: session.householdRevision, assignmentRevision: session.assignmentRevision },
        interpretation: 'archived_copy_removal_not_source_deletion', receipt: dependencies.library.removalReceipt(credential, requestId) }))
    }
    catch (error) {
      if (error instanceof z.ZodError) throw new HouseholdError('not_ready', 503, 'The saved removal receipt needs review.')
      throw error
    }
  }
  const payload = read()
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    try {
      if (read() !== payload) throw new Error('Removal access changed before delivery')
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    }
    catch { controller.error(new Error('Removal access changed before delivery')) }
  } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
    'Vary': 'Authorization, Cookie, X-Sleepypod-Sleeper-Id', 'X-Content-Type-Options': 'nosniff' } })
}
