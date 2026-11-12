import { z } from 'zod'
import type { ExperimentAccess } from './access'
import type { ComfortExperimentService } from './service'
import { ExperimentError } from './service'
import { ExperimentFeedbackError, ExperimentStoreConflict } from './store'

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
  'Vary': 'Authorization, Cookie, X-Sleepypod-Sleeper-Id', 'X-Content-Type-Options': 'nosniff' }
export const MAX_EXPERIMENT_BODY_BYTES = 8 * 1024

export async function readExperimentBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new ExperimentError('invalid_request', 415, 'Send a JSON experiment request.')
  const reader = request.body?.getReader()
  if (!reader) throw new ExperimentError('invalid_request', 400, 'A JSON request is required.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  const interrupt = () => {
    void reader.cancel().catch(() => {})
  }
  request.signal.addEventListener('abort', interrupt, { once: true })
  if (request.signal.aborted) interrupt()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_EXPERIMENT_BODY_BYTES) {
        await reader.cancel()
        throw new ExperimentError('invalid_request', 413, 'This experiment request is too large.')
      }
      chunks.push(chunk.value)
    }
    if (request.signal.aborted) throw new ExperimentError('conflict', 408, 'The experiment request was interrupted.')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  }
  catch (error) {
    if (error instanceof ExperimentError) throw error
    throw new ExperimentError('invalid_request', 400, 'The request is not valid UTF-8 JSON.')
  }
  finally {
    request.signal.removeEventListener('abort', interrupt)
    reader.releaseLock()
  }
}

export function experimentErrorResponse(error: unknown): Response {
  const known = error instanceof ExperimentStoreConflict
    ? new ExperimentError('conflict', 409, error.message)
    : error instanceof ExperimentFeedbackError ? new ExperimentError('invalid_request', 400, error.message) : error
  const failure = known instanceof ExperimentError
    ? known
    : known instanceof z.ZodError
      ? new ExperimentError('invalid_request', 400, 'Check the experiment request fields.')
      : new ExperimentError('not_ready', 503, 'The experiment could not be confirmed. Refresh its saved record before retrying.')
  return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers })
}

/** Evaluate writes once; recheck authority and content before delivering any private response. */
export function experimentResponse(request: Request, body: unknown, service: ComfortExperimentService,
  authorize: () => ExperimentAccess, now = Date.now): Response {
  const url = new URL(request.url)
  const route = url.pathname.replace(/\/$/, '').match(/^\/api\/v1\/(?:comfort\/experiments|me\/comfort-experiments)(?:\/([^/]+))?(?:\/(stop|feedback))?$/)
  if (!route) throw new ExperimentError('not_found', 404, 'Choose the experiment library or one experiment.')
  const selected = route[1], action = route[2], initial = authorize()
  const initialIdentity = JSON.stringify(initial)
  const assertCurrent = () => {
    if (request.signal.aborted) throw new ExperimentError('conflict', 408, 'The experiment request was interrupted.')
    const current = authorize()
    if (JSON.stringify(current) !== initialIdentity)
      throw new ExperimentError('conflict', 409, 'Your account or assignment changed. Reload the experiment library.')
    return current
  }
  const query = [...url.searchParams]
  if (query.length && (selected || !['GET', 'HEAD'].includes(request.method) || query.length !== 1 || query[0][0] !== 'afterId'))
    throw new ExperimentError('invalid_request', 400, 'Only the library accepts a single afterId cursor.')
  const afterId = query.length ? z.string().uuid().parse(query[0][1]) : undefined
  let select: () => object
  const generatedAt = now()
  service.transaction(() => {
    assertCurrent()
    if (request.method === 'POST' && selected === 'preview' && !action) {
      const review = service.prepare(initial, body)
      select = () => ({ ...review, availability: service.overview(initial).availability })
    }
    else if (request.method === 'POST' && selected === 'confirm' && !action) {
      const saved = service.confirm(initial, body)
      select = () => service.detail(initial, saved.record.plan.id)
    }
    else if (request.method === 'POST' && selected && action) {
      if (action === 'stop') service.stop(initial, selected, body)
      else service.saveFeedback(initial, selected, body)
      select = () => service.detail(initial, selected)
    }
    else if (['GET', 'HEAD'].includes(request.method) && !action && selected !== 'preview' && selected !== 'confirm')
      select = selected ? () => service.detail(initial, selected) : () => service.overview(initial, afterId)
    else throw new ExperimentError('invalid_request', 405, 'Use GET for records, or POST to preview, confirm, stop or add feedback.')
    assertCurrent()
  }, request.method === 'POST')
  const read = () => service.transaction(() => {
    const access = assertCurrent()
    const payload = JSON.stringify({ version: 1, generatedAt, scope: access.scope, ...select() })
    assertCurrent()
    return payload
  })
  const payload = read()
  if (request.method === 'HEAD') return new Response(null, { headers })
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    try {
      if (read() !== payload) throw new Error('Experiment changed before delivery')
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    }
    catch { controller.error(new Error('Experiment access or content changed before delivery')) }
  } }, { highWaterMark: 0 }), { headers })
}
