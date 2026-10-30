import { z } from 'zod'
import { ControlConflictError } from '@/src/controls/store'
import type Database from 'better-sqlite3'
import { authorized, sameOrigin, SESSION_COOKIE } from '@/src/auth/access'
import { bindBrowserScope, hasBrowserScope, BrowserScopeConflict } from '@/src/auth/browserScope'
import { deviceSecretSchema, householdSetupSchema } from './contract'
import type { HouseholdStore } from './store'
import { HouseholdError } from './store'
import { issuePersonalSession, personalCookie, personalCredential } from './browserSession'
import type { PersonalRuntime } from './personalRuntime'
import type { PersonalRoutineService } from './personalRoutines'
import type { ArrangementReviewService } from './arrangementReviews'
import type { PersonalHistoryApi } from './historyApi'
const MAX_BODY_BYTES = 128 * 1024
const privacyHeaders = { 'Cache-Control': 'private, no-store', 'Vary': 'Authorization, Cookie', 'X-Content-Type-Options': 'nosniff' }
async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new HouseholdError('invalid_request', 415, 'Send a JSON body.')
  const reader = request.body?.getReader()
  if (!reader)
    throw new HouseholdError('invalid_request', 400, 'A JSON body is required.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done)
      break
    bytes += chunk.value.byteLength
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new HouseholdError('invalid_request', 413, 'The request is too large.')
    }
    chunks.push(chunk.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch {
    throw new HouseholdError('invalid_request', 400, 'The request is not valid JSON.')
  }
}
export interface HouseholdHttpDependencies {
  store: HouseholdStore
  verifySoloConfiguration: (side: 'left' | 'right') => boolean
  allowPublicAttempt?: () => boolean
  personalRuntime?: PersonalRuntime
  personalRoutines?: PersonalRoutineService
  arrangementReviews?: ArrangementReviewService
  personalHistory?: PersonalHistoryApi
}
/** This namespace authorizes every route itself; personal credentials never enter legacy APIs. */
export async function householdHttp(request: Request, dependencies: HouseholdHttpDependencies): Promise<Response> {
  const { store } = dependencies
  const present = (session: ReturnType<HouseholdStore['session']>) => {
    const current = dependencies.personalRuntime?.session(session) ?? session
    const routines = dependencies.personalRoutines?.present(current) ?? current
    const arrangement = dependencies.arrangementReviews?.present(routines) ?? routines
    return dependencies.personalHistory?.present(arrangement) ?? arrangement
  }
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '')
  const method = request.method
  const reply = (body: unknown, status = 200, cookies?: string[]) => {
    const headers = new Headers(privacyHeaders)
    if (cookies) {
      for (const cookie of cookies) headers.append('Set-Cookie', cookie)
      headers.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
    }
    return Response.json(body, { status, headers })
  }
  const cookieForSecret = (secret: string, database?: Database.Database) => {
    if (!sameOrigin(request.headers)) return undefined
    const session = issuePersonalSession(store.deviceIdentity(secret))
    return [personalCookie(request, session), bindBrowserScope(request, 'personal', session, database)]
  }
  try {
    if (request.headers.has('origin') && !sameOrigin(request.headers))
      throw new HouseholdError('forbidden', 403, 'Use the same private Pod origin.')
    if (path === '/api/v1/household/setup' && method === 'POST') {
      const input = householdSetupSchema.parse(await jsonBody(request))
      if (!authorized(request.headers, method))
        throw new HouseholdError('forbidden', 403, 'The existing owner must prepare this installation.')
      if (!dependencies.verifySoloConfiguration(input.sourceSide))
        throw new HouseholdError('not_ready', 409, 'First confirm the existing solo/follow bed arrangement. Setup does not change it.')
      return store.withBrowserTransaction((database) => {
        const session = store.setup(input)
        return reply(present(session), 200, cookieForSecret(input.deviceSecret, database))
      })
    }
    if (path === '/api/v1/household/join' && method === 'POST') {
      if (dependencies.allowPublicAttempt && !dependencies.allowPublicAttempt())
        throw new HouseholdError('rate_limited', 429, 'Wait a minute before trying another invitation.')
      const input = await jsonBody(request)
      const secret = (input as {
        deviceSecret: string
      }).deviceSecret
      return store.withBrowserTransaction((database) => {
        const session = store.join(input)
        return reply(present(session), 200, cookieForSecret(secret, database))
      })
    }
    if (path === '/api/v1/household/session' && method === 'POST') {
      if (!sameOrigin(request.headers))
        throw new HouseholdError('forbidden', 403, 'Browser connection requires the same Pod origin. Native clients use a Bearer key.')
      if (dependencies.allowPublicAttempt && !dependencies.allowPublicAttempt())
        throw new HouseholdError('rate_limited', 429, 'Wait a minute before reconnecting.')
      const { token } = z.object({ token: deviceSecretSchema }).strict().parse(await jsonBody(request))
      return reply(present(store.session(token)), 200, cookieForSecret(token))
    }
    if (path === '/api/v1/household/session' && method === 'DELETE') {
      if (!sameOrigin(request.headers))
        throw new HouseholdError('forbidden', 403, 'A same-origin browser request is required.')
      const headers = new Headers(privacyHeaders)
      if (hasBrowserScope(request.headers)) bindBrowserScope(request, 'signed_out', '')
      headers.append('Set-Cookie', personalCookie(request, '', 0))
      headers.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
      return new Response(null, { status: 204, headers })
    }
    // Read potentially streamed input before resolving the current browser and
    // device identity, so revocation while uploading cannot leave stale authority.
    const mutationBody = ['POST', 'PUT', 'DELETE'].includes(method) ? await jsonBody(request) : undefined
    const credential = personalCredential(request)
    // Cookies are shared between tabs. A stale editor must never write its
    // previous person's preferences into the newly selected person's account.
    const expectedSleeper = request.headers.get('x-sleepypod-sleeper-id')
    const browserMutation = !request.headers.has('authorization') && !['GET', 'HEAD'].includes(method)
    if ((browserMutation || expectedSleeper !== null) && expectedSleeper !== store.session(credential).selfSleeperId)
      throw new HouseholdError('conflict', 409, 'The browser account changed. Reload before continuing.')
    const assertRequestCurrent = () => {
      const current = personalCredential(request)
      if (JSON.stringify(current) !== JSON.stringify(credential)
        || (expectedSleeper !== null && store.session(current).selfSleeperId !== expectedSleeper))
        throw new HouseholdError('conflict', 409, 'The browser account changed. Reload before continuing.')
    }
    if (path === '/api/v1/household/session' && method === 'GET')
      return reply(present(store.session(credential)))
    if (dependencies.personalHistory && ['GET', 'HEAD'].includes(method)
      && (path === '/api/v1/me/sleep' || /^\/api\/v1\/me\/sleep\/[^/]+$/.test(path)))
      return dependencies.personalHistory.response(request, credential, assertRequestCurrent)
    if (dependencies.arrangementReviews) {
      if (path === '/api/v1/household/arrangement' && method === 'GET')
        return reply({ version: 1, review: dependencies.arrangementReviews.latest(credential) })
      if (path === '/api/v1/household/arrangement' && method === 'POST')
        return reply(dependencies.arrangementReviews.propose(credential, mutationBody))
      if (path === '/api/v1/household/arrangement/approve' && method === 'POST')
        return reply(dependencies.arrangementReviews.approve(credential, mutationBody))
      if (path === '/api/v1/household/arrangement/cancel' && method === 'POST')
        return reply(dependencies.arrangementReviews.cancel(credential, mutationBody))
      const reviewPath = path.match(/^\/api\/v1\/household\/arrangement\/([^/]+)$/)
      if (reviewPath && method === 'GET')
        return reply(dependencies.arrangementReviews.get(credential, reviewPath[1]))
    }
    if (dependencies.personalRuntime) {
      if (path === '/api/v1/me/bed' && method === 'GET')
        return reply(await dependencies.personalRuntime.bed(credential, assertRequestCurrent))
      if (path === '/api/v1/me/controls' && method === 'POST')
        return reply(await dependencies.personalRuntime.submit(credential, mutationBody, assertRequestCurrent))
      const receiptPath = path.match(/^\/api\/v1\/me\/controls\/([^/]+)$/)
      if (receiptPath && method === 'GET') {
        const receipt = dependencies.personalRuntime.receipt(credential, receiptPath[1], assertRequestCurrent)
        return receipt ? reply(receipt) : reply({ error: { code: 'not_ready', message: 'No personal command receipt is available.' } }, 404)
      }
    }
    if (dependencies.personalRoutines) {
      if (path === '/api/v1/me/routines/review' && method === 'GET')
        return reply(dependencies.personalRoutines.review(credential, assertRequestCurrent))
      if (path === '/api/v1/me/routines/publish' && method === 'POST')
        return reply(await dependencies.personalRoutines.publish(credential, mutationBody, assertRequestCurrent))
      const publicationPath = path.match(/^\/api\/v1\/me\/routines\/publications\/([^/]+)$/)
      if (publicationPath && method === 'GET') {
        const receipt = dependencies.personalRoutines.get(credential, publicationPath[1], assertRequestCurrent)
        return receipt ? reply(receipt) : reply({ error: { code: 'not_ready', message: 'No personal publication receipt is available.' } }, 404)
      }
    }
    if (path === '/api/v1/household/invitations') {
      if (method === 'GET')
        return reply(store.invitations(credential))
      if (method === 'POST')
        return reply(store.createInvitation(credential, mutationBody))
      if (method === 'DELETE')
        return reply(store.revokeInvitation(credential, mutationBody))
    }
    if (path === '/api/v1/household/devices') {
      if (method === 'GET')
        return reply(store.devices(credential))
      if (method === 'DELETE')
        return reply(store.revokeDevice(credential, mutationBody))
    }
    if (path === '/api/v1/me/preferences') {
      if (method === 'GET')
        return reply(store.preferences(credential))
      if (method === 'PUT')
        return reply(store.updatePreferences(credential, mutationBody))
    }
    if (path === '/api/v1/me/routines') {
      if (method === 'GET')
        return reply(store.routines(credential))
      if (method === 'PUT')
        return reply(store.updateRoutines(credential, mutationBody))
    }
    return reply({ error: { code: 'not_ready', message: 'This personal operation is not available. Existing routines remain unchanged.' } }, 404)
  }
  catch (error) {
    if (error instanceof BrowserScopeConflict)
      return reply({ error: { code: 'conflict', message: error.message } }, 409)
    if (error instanceof ControlConflictError)
      return reply({ error: { code: 'conflict', message: 'This request ID already identifies a different personal command.' } }, 409)
    if (error instanceof HouseholdError)
      return reply({ error: { code: error.code, message: error.message } }, error.status)
    if (error instanceof z.ZodError)
      return reply({ error: { code: 'invalid_request', message: 'Check the fields and reload the current account context.' } }, 400)
    // Do not echo SQLite, validation inputs, secrets or another person's records.
    return reply({ error: { code: 'not_ready', message: 'The operation could not be confirmed. Reconnect and check its saved result before retrying.' } }, 503)
  }
}
