import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { rejectUnknownHost } from '@/src/lib/hostAllowlist'
import { WATCH_IMPORT_TIMEOUT_MS, WATCH_UPLOAD_TIMEOUT_MS } from '@/src/utils/watchUploadLimits'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const MAX_BYTES = 512 * 1024 * 1024
const options = z.object({ side: z.enum(['left', 'right']), days: z.coerce.number().int().min(1).max(90).default(30) })
const resultSchema = z.object({ stages: z.number(), vitals: z.number(), breathing: z.number(), hrv: z.number(), rejectedStageBatches: z.number(),
  matchedStages: z.number(), matchedVitals: z.number(), matchedBreathing: z.number(), matchedHrv: z.number() })
const shared = globalThis as typeof globalThis & { watchUploadBusy?: boolean }

/**
 * Next builds request.url from the bind address (http://0.0.0.0:3000 on the pod), so a browser's Origin
 * never matches it. Compare against the Host the browser actually sent, as /api/mcp does.
 */
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

/** Raw export.zip/export.xml body, streamed to flash. Uses the same importer as the CLI. */
export async function POST(request: Request): Promise<Response> {
  // proxy.ts skips this route so Next streams the body instead of truncating it at 10 MB.
  const rejectedHost = rejectUnknownHost(request)
  if (rejectedHost) return rejectedHost
  if (!isSameOrigin(request)) return Response.json({ error: 'Cross-origin upload is not allowed' }, { status: 403 })
  const parsed = options.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return Response.json({ error: 'Specify side=left|right and days=1..90' }, { status: 400 })
  if (!request.body) return Response.json({ error: 'Send export.zip or export.xml as the request body' }, { status: 400 })
  const declaredBytes = Number(request.headers.get('content-length'))
  if (declaredBytes > MAX_BYTES) return Response.json({ error: 'Upload exceeds 512 MiB' }, { status: 413 })
  if (shared.watchUploadBusy) return Response.json({ error: 'Another Watch import is running; retry when it finishes' }, { status: 409 })
  shared.watchUploadBusy = true
  let signal = AbortSignal.any([request.signal, AbortSignal.timeout(WATCH_UPLOAD_TIMEOUT_MS)])
  let directory: string | undefined
  let tooLarge = false
  try {
    // /tmp is RAM-backed on the pod. Large Health exports belong on persistent storage.
    const staging = process.env.WATCH_UPLOAD_DIR ?? '/persistent/sleepypod-data/watch-upload'
    await mkdir(staging, { recursive: true })
    directory = await mkdtemp(path.join(staging, 'import-'))
    const filename = path.join(directory, 'health-export')
    const file = await open(filename, 'wx', 0o600)
    let bytes = 0
    try {
      await request.body.pipeTo(new WritableStream<Uint8Array>({
        async write(chunk) {
          bytes += chunk.byteLength
          if (bytes > MAX_BYTES) {
            tooLarge = true
            throw new Error('Upload exceeds 512 MiB')
          }
          await file.writeFile(chunk)
        },
      }), { signal })
    }
    finally {
      await file.close()
    }
    if (bytes === 0) return Response.json({ error: 'The uploaded file is empty' }, { status: 400 })
    if (declaredBytes > 0 && bytes !== declaredBytes) {
      return Response.json({ error: `Upload incomplete: the pod received ${bytes} of ${declaredBytes} bytes. Nothing was imported; retry the upload.` }, { status: 400 })
    }
    signal = AbortSignal.any([request.signal, AbortSignal.timeout(WATCH_IMPORT_TIMEOUT_MS)])
    const { side, days } = parsed.data
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('python3', [path.resolve('scripts/import-watch-health.py'), filename,
        '--pod', `http://127.0.0.1:${process.env.PORT ?? '3000'}`, '--side', side, '--days', String(days), '--json'], { signal })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      // Drain errors without disclosing Health contents or internal paths to callers.
      child.stderr.resume()
      let processError: Error | undefined
      child.on('error', (error) => {
        processError = error
      })
      child.on('close', code => code === 0 ? resolve(output) : reject(processError ?? new Error('Import failed')))
    })
    return Response.json(resultSchema.parse(JSON.parse(stdout)))
  }
  catch {
    return Response.json({ error: tooLarge
      ? 'Upload exceeds 512 MiB'
      : signal.aborted
        ? 'Import interrupted. Some batches may have been saved; retrying the same export is safe.'
        : 'Import failed. Use an Apple Health export.zip or export.xml. Some batches may have been saved; retrying is safe.' }, { status: tooLarge ? 413 : signal.aborted ? 408 : 422 })
  }
  finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
    finally { shared.watchUploadBusy = false }
  }
}
