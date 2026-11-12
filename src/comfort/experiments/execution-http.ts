import { z } from 'zod'
import type { ExperimentAccess } from './access'
import type { ExperimentExecutionHost } from './execution'
import type { ExperimentPrincipal } from './execution-principal'
import { ExperimentError } from './service'
import { experimentExecutionCancellationSchema, experimentExecutionConfirmationSchema,
  experimentExecutionRecoverySchema, experimentExecutionStatusSchema } from './execution-contract'

const routePattern = /^\/api\/v1\/(?:comfort\/experiments|me\/comfort-experiments)\/([^/]+)\/execution(?:\/(preview|confirm|cancel|recover))?$/
const identifier = z.string().uuid()
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
  'Vary': 'Authorization, Cookie, X-Sleepypod-Sleeper-Id', 'X-Content-Type-Options': 'nosniff' }

export function isExperimentExecutionRequest(request: Request) {
  return routePattern.test(new URL(request.url).pathname.replace(/\/$/, ''))
}

/** Await side locks outside SQLite transactions; the host commits each mutation with fresh authorization. */
export async function experimentExecutionResponse(request: Request, body: unknown, host: ExperimentExecutionHost,
  authorize: () => { access: ExperimentAccess, principal: ExperimentPrincipal }, now = Date.now): Promise<Response> {
  const url = new URL(request.url), route = url.pathname.replace(/\/$/, '').match(routePattern)
  if (!route) throw new ExperimentError('not_found', 404, 'Choose an experiment execution record.')
  if ([...url.searchParams].length) throw new ExperimentError('invalid_request', 400, 'Execution does not accept query parameters.')
  const planId = identifier.parse(route[1]), action = route[2]
  if (action ? request.method !== 'POST' : !['GET', 'HEAD'].includes(request.method))
    throw new ExperimentError('invalid_request', 405, 'Read execution with GET; use POST for a reviewed action.')
  const initial = authorize(), identity = JSON.stringify(initial)
  const assertCurrent = () => {
    if (request.signal.aborted) throw new ExperimentError('conflict', 408, 'The execution request was interrupted. Read its saved state.')
    if (JSON.stringify(authorize()) !== identity)
      throw new ExperimentError('conflict', 409, 'Your account or assignment changed. Read its current execution state.')
  }
  assertCurrent()
  // Check ownership before attempting any qualification read, cancellation or recovery.
  if (host.describe(initial.principal, planId).record.plan.context.subjectKey !== initial.access.subjectKey)
    throw new ExperimentError('conflict', 409, 'The authenticated experiment identity changed.')
  let reviewId: string | undefined
  if (action === 'preview') {
    z.object({}).strict().parse(body)
    reviewId = (await host.prepare(initial.principal, planId, assertCurrent)).id
  }
  else if (action === 'confirm') {
    const input = experimentExecutionConfirmationSchema.parse(body)
    await host.confirm(initial.principal, input.reviewId, input.planHash, assertCurrent, planId)
  }
  else if (action === 'cancel') {
    const input = experimentExecutionCancellationSchema.parse(body)
    await host.cancel(initial.principal, input.admissionId, assertCurrent, planId)
  }
  else if (action === 'recover') {
    const input = experimentExecutionRecoverySchema.parse(body)
    await host.recover(initial.principal, planId, input.admissionId, input.applicationId, assertCurrent)
  }
  assertCurrent()
  const generatedAt = now()
  const read = () => {
    assertCurrent()
    const { record, grant, applications, running } = host.describe(initial.principal, planId)
    const review = reviewId ? host.prepared(initial.principal, planId, reviewId) : null
    if (review && (now() < review.createdAt || now() >= review.expiresAt))
      throw new ExperimentError('conflict', 409, 'The execution review expired. Prepare a new review.')
    // Qualification paths, source records, credential digests and device IDs stay on the server.
    const payload = JSON.stringify(experimentExecutionStatusSchema.parse({ version: 1, generatedAt, scope: initial.access.scope, planId,
      planStatus: record.status, controllerRunning: running,
      state: !grant ? 'not_admitted' : grant.revokedAt !== null ? 'revoked' : now() >= grant.endsAt ? 'ended' : 'admitted',
      review: review
        ? { id: review.id, planHash: review.planHash, createdAt: review.createdAt,
            expiresAt: review.expiresAt, sides: review.zones.map(zone => zone.side) }
        : null,
      admission: grant
        ? { id: grant.review.id, admittedAt: grant.admittedAt, endsAt: grant.endsAt,
            revokedAt: grant.revokedAt, reason: grant.reason, sides: grant.review.zones.map(zone => zone.side) }
        : null,
      applications: applications.map(application => ({ id: application.reservation.id,
        side: application.reservation.side, requestedTargetF: application.reservation.targetF,
        attemptedAt: application.reservation.reservedAt, outcome: application.outcome,
        acknowledgment: application.outcome === 'acknowledged' ? 'accepted_not_physically_verified' : 'unconfirmed',
        finishedAt: application.finishedAt, resolution: application.resolution })) }))
    assertCurrent()
    return payload
  }
  const payload = read()
  if (request.method === 'HEAD') return new Response(null, { headers })
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    try {
      if (read() !== payload) throw new Error('Execution changed before delivery')
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    }
    catch { controller.error(new Error('Experiment execution access or content changed before delivery')) }
  } }, { highWaterMark: 0 }), { headers })
}
