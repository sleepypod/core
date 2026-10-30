import { requireAccess } from './access'

interface PrivateResponseOptions {
  /** A download can acquire a stricter policy while its source is being read. */
  additionalAccess?: () => Response | null
  onCancel?: () => void
}

function privateHeaders(response: Response): Headers {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'private, no-store')
  const vary = (headers.get('Vary') ?? '').split(',').map(value => value.trim()).filter(Boolean)
  for (const identity of ['Authorization', 'Cookie']) {
    if (!vary.some(value => value.toLowerCase() === identity.toLowerCase())) vary.push(identity)
  }
  headers.set('Vary', vary.join(', '))
  return headers
}

/** Recheck after awaited work and at each output boundary, including an awaited read. */
export function privateApiResponse(request: Request, response: Response, options: PrivateResponseOptions = {}): Response {
  const access = () => request.signal.aborted
    ? Response.json({ error: 'Request interrupted' }, { status: 408 })
    : requireAccess(request) ?? options.additionalAccess?.() ?? null
  const rejected = access()
  if (rejected) {
    options.onCancel?.()
    void response.body?.cancel().catch(() => {})
    return new Response(rejected.body, { status: rejected.status, headers: privateHeaders(rejected) })
  }
  if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers: privateHeaders(response) })

  const reader = response.body.getReader()
  let settled = false
  let abort: () => void
  const finish = () => {
    settled = true
    request.signal.removeEventListener('abort', abort)
  }
  const cancelSource = (reason?: unknown) => {
    if (settled) return
    finish()
    options.onCancel?.()
    void reader.cancel(reason).catch(() => {}).finally(() => reader.releaseLock())
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (settled) return
        controller.error(new Error('Private response interrupted'))
        cancelSource()
      }
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
    },
    async pull(controller) {
      try {
        if (access()) throw new Error('Private response access changed')
        const chunk = await reader.read()
        if (settled) return
        if (access()) throw new Error('Private response access changed')
        if (chunk.done) {
          finish()
          reader.releaseLock()
          controller.close()
        }
        else controller.enqueue(chunk.value)
      }
      catch (error) {
        if (settled) return
        controller.error(error)
        cancelSource(error)
      }
    },
    cancel: cancelSource,
  }, { highWaterMark: 0 })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: privateHeaders(response) })
}
