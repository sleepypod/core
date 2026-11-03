import { z } from 'zod'
import { biometricsDb } from '@/src/db'
import { rejectUnknownHost } from '@/src/lib/hostAllowlist'
import {
  listWatchMotion, parseWatchMotion, saveWatchMotion, WATCH_MOTION_MAX_BYTES, WatchMotionError,
} from '@/src/biometrics/references/watch-motion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const sideQuery = z.object({ side: z.enum(['left', 'right']) })
/** ISO 8601 text or Unix milliseconds. */
const dateParam = z.string().transform((value, ctx) => {
  const date = new Date(/^\d+$/.test(value) ? Number(value) : value)
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'must be ISO 8601 or Unix milliseconds' })
    return z.NEVER
  }
  return date
})
const listQuery = z.object({ side: z.enum(['left', 'right']).optional(), startDate: dateParam.optional(), endDate: dateParam.optional() }).strict()

/** Same check as watch-upload: Next reports the 0.0.0.0 bind address in request.url, so compare Origin with Host. */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    return new URL(origin).host === request.headers.get('host')
  }
  catch {
    return false
  }
}

class TooLarge extends Error {}

/** The body as text, refusing to buffer more than the limit even without a Content-Length. */
async function readBody(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length')) > WATCH_MOTION_MAX_BYTES) throw new TooLarge()
  if (!request.body) return ''
  const chunks: Uint8Array[] = []
  let bytes = 0
  const reader = request.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > WATCH_MOTION_MAX_BYTES) {
      await reader.cancel()
      throw new TooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * One night's watch-motion-v1/v2 file from the iOS app, as-is. Stored as a
 * movement label only (see docs/biometrics-reference-imports.md).
 */
export async function POST(request: Request): Promise<Response> {
  const rejectedHost = rejectUnknownHost(request)
  if (rejectedHost) return rejectedHost
  if (!isSameOrigin(request)) return Response.json({ error: 'Cross-origin upload is not allowed' }, { status: 403 })
  const query = sideQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!query.success) return Response.json({ error: 'Specify side=left|right' }, { status: 400 })
  let body: string
  try {
    body = await readBody(request)
  }
  catch (error) {
    if (error instanceof TooLarge) return Response.json({ error: 'Upload exceeds 8 MiB' }, { status: 413 })
    return Response.json({ error: 'Upload interrupted' }, { status: 400 })
  }
  if (!body) return Response.json({ error: 'Send the watch-motion JSON file as the request body' }, { status: 400 })
  try {
    const parsed = parseWatchMotion(body)
    const { capture, status } = saveWatchMotion(biometricsDb, query.data.side, parsed)
    return Response.json({
      id: capture.id,
      side: capture.side,
      version: capture.version,
      recordedFromMs: capture.recordedFromMs,
      recordedToMs: capture.recordedToMs,
      bins: capture.bins,
      trimmedBins: parsed.trimmedBins,
      status,
    })
  }
  catch (error) {
    if (error instanceof WatchMotionError) return Response.json({ error: error.message }, { status: error.status })
    return Response.json({ error: 'Could not store the recording' }, { status: 500 })
  }
}

/** Capture metadata overlapping [startDate, endDate], oldest first. */
export async function GET(request: Request): Promise<Response> {
  const query = listQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!query.success) return Response.json({ error: 'Use side=left|right and startDate/endDate as ISO 8601 or Unix milliseconds' }, { status: 400 })
  const { side, startDate, endDate } = query.data
  if (startDate && endDate && startDate > endDate) return Response.json({ error: 'startDate must be before or equal to endDate' }, { status: 400 })
  return Response.json(listWatchMotion(biometricsDb, { side, start: startDate, end: endDate }))
}
