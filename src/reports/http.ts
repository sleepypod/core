import { z } from 'zod'
import { reportIdSchema } from './morning'
import { ReportError, type MorningReportStore, type ReportScope } from './store'

export const MAX_REPORT_REQUEST_BYTES = 400 * 1024
const revision = z.uuid().transform(value => value.toLowerCase()).nullable()
const saveBody = z.object({ expectedRevision: revision, document: z.unknown() }).strict()
const deleteBody = z.object({ expectedRevision: revision }).strict()
const privateHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
  'Vary': 'Authorization, Cookie, X-Sleepypod-Sleeper-Id', 'X-Content-Type-Options': 'nosniff' }
export interface ReportAccess { identity: ReportScope, scope: object }

export async function readReportBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new ReportError('invalid_request', 415, 'Send a JSON report request.')
  const reader = request.body?.getReader()
  if (!reader) throw new ReportError('invalid_request', 400, 'A JSON body is required.')
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
      if (bytes > MAX_REPORT_REQUEST_BYTES || request.signal.aborted) {
        await reader.cancel()
        throw new ReportError('invalid_request', bytes > MAX_REPORT_REQUEST_BYTES ? 413 : 408, 'The report upload is too large or was interrupted.')
      }
      chunks.push(chunk.value)
    }
    if (request.signal.aborted) throw new ReportError('invalid_request', 408, 'The report upload was interrupted.')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  }
  catch (error) {
    if (error instanceof ReportError) throw error
    throw new ReportError('invalid_request', 400, 'The request is not valid UTF-8 JSON.')
  }
  finally {
    request.signal.removeEventListener('abort', interrupt)
    reader.releaseLock()
  }
}

export function reportErrorResponse(error: unknown): Response {
  const failure = error instanceof ReportError
    ? error
    : error instanceof z.ZodError
      ? new ReportError('invalid_request', 400, 'Check the report request fields.')
      : new ReportError('unavailable', 503, 'The shared report library is unavailable. Refresh before retrying.')
  return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers: privateHeaders })
}

/** Writes happen once. Delivery rechecks account authority and the current saved revision without replaying writes. */
export function reportResponse(request: Request, body: unknown, store: MorningReportStore, authorize: () => ReportAccess, now = Date.now): Response {
  const url = new URL(request.url), route = url.pathname.replace(/\/$/, '').match(/^\/api\/v1\/(?:me\/)?reports(?:\/([^/]+))?$/)
  if (!route || url.search) throw new ReportError('invalid_request', 400, 'Select the report library or one report without query fields.')
  const reportId = route[1] ? reportIdSchema.parse(route[1]) : null
  const initial = authorize()
  const check = () => {
    if (request.signal.aborted) throw new ReportError('conflict', 408, 'The report request was interrupted.')
    const current = authorize()
    if (JSON.stringify(current) !== JSON.stringify(initial)) throw new ReportError('conflict', 409, 'Your report account changed. Reload before continuing.')
    return current
  }
  check()
  if (request.method === 'PUT' && reportId) {
    const input = saveBody.parse(body)
    store.save(initial.identity, reportId, input.document, input.expectedRevision)
  }
  else if (request.method === 'DELETE' && reportId) store.remove(initial.identity, reportId, deleteBody.parse(body).expectedRevision)
  else if (!['GET', 'HEAD'].includes(request.method)) throw new ReportError('invalid_request', 405, 'Use GET for the library, or PUT/DELETE for one report.')
  const generatedAt = now()
  const read = () => {
    const access = check()
    const selected = reportId ? store.read(access.identity, reportId) : { reports: store.list(access.identity) }
    check()
    return JSON.stringify({ version: 1, generatedAt, scope: access.scope, ...selected })
  }
  const payload = read()
  if (request.method === 'HEAD') return new Response(null, { headers: privateHeaders })
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    try {
      if (read() !== payload) throw new Error('Report changed before delivery')
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    }
    catch { controller.error(new Error('Report access or saved content changed before delivery')) }
  } }, { highWaterMark: 0 }), { headers: privateHeaders })
}
