import type { z } from 'zod'
import { householdIdSchema, type HouseholdSession } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import type { HouseholdQuietStore } from './quiet'
import { quietReadResponseSchema, quietWriteResponseSchema } from './quietContract'

export class HouseholdQuietApi {
  constructor(private readonly dependencies: { identities: HouseholdStore, quiet: HouseholdQuietStore, now?: () => number }) {}

  present(session: HouseholdSession): HouseholdSession {
    return { ...session, capabilities: { ...session.capabilities, householdQuiet: true } }
  }

  /** Recheck identity and shared state at delivery; a delayed response cannot clear a newer partner request. */
  response(request: Request, credential: HouseholdCredential, body: unknown, assertRequestCurrent: () => void) {
    const url = new URL(request.url), path = url.pathname.replace(/\/$/, '')
    const assertAccess = () => {
      if (request.signal.aborted) throw new HouseholdError('conflict', 409, 'The quiet request was interrupted.')
      assertRequestCurrent()
      const session = this.dependencies.identities.session(credential)
      if (!request.headers.has('authorization') && request.headers.get('x-sleepypod-sleeper-id') !== session.selfSleeperId)
        throw new HouseholdError('conflict', 409, 'Reload your personal account before changing shared quiet time.')
      return session
    }
    assertAccess()
    if (url.search) throw new HouseholdError('invalid_request', 400, 'Quiet requests do not accept query fields.')
    let select: () => object, schema: z.ZodType
    if (path === '/api/v1/me/quiet' && request.method === 'POST') {
      const receipt = this.dependencies.quiet.write(credential, body)
      select = () => ({ receipt: this.dependencies.quiet.receipt(credential, receipt.requestId) })
      schema = quietWriteResponseSchema
    }
    else if (path === '/api/v1/me/quiet' && ['GET', 'HEAD'].includes(request.method)) {
      select = () => this.dependencies.quiet.read(credential)
      schema = quietReadResponseSchema
    }
    else if (path.startsWith('/api/v1/me/quiet/requests/') && ['GET', 'HEAD'].includes(request.method)) {
      const requestId = householdIdSchema.parse(path.slice('/api/v1/me/quiet/requests/'.length))
      select = () => ({ receipt: this.dependencies.quiet.receipt(credential, requestId) })
      schema = quietWriteResponseSchema
    }
    else throw new HouseholdError('invalid_request', 400, 'Choose quiet status or one saved request.')
    const generatedAt = (this.dependencies.now ?? Date.now)()
    const read = () => {
      const session = assertAccess()
      return JSON.stringify(schema.parse({ version: 1, generatedAt,
        scope: { podId: session.podId, householdId: session.householdId, accountId: session.accountId,
          sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
          assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision }, ...select() }))
    }
    const payload = read()
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      try {
        if (read() !== payload) throw new Error('Quiet status or access changed before delivery')
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      }
      catch { controller.error(new Error('Quiet status or access changed before delivery')) }
    } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
      'Vary': 'Authorization, Cookie, X-Sleepypod-Sleeper-Id', 'X-Content-Type-Options': 'nosniff' } })
  }
}
