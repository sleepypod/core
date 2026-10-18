import { mkdtemp, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { biometricsDb } from '@/src/db'
import { AnalysisExportTooLargeError, analysisWindowSchema, liveDatabaseBytes, planAnalysisExport } from '@/src/biometrics/analysis-export'
import { analysisBundleTarBytes, analysisExportChunks, podIdentity, readBuildInfo, snapshotBiometricsDatabase, type AnalysisBundle } from '@/src/biometrics/analysis-export-bundle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// One export at a time: each holds a database snapshot on tmpfs (RAM) until it finishes.
let inflight = false
const EXPORT_WATCHDOG_MS = (() => {
  const raw = Number(process.env.ANALYSIS_EXPORT_WATCHDOG_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000
})()

/**
 * Stream an analysis snapshot as an uncompressed tar: a consistent backup of
 * biometrics.db, the RAW archives for the window (raw=1, the default) and
 * manifest.json with every file's SHA-256. Read-only: the backup goes through
 * a read-only connection into os.tmpdir() (tmpfs on the pod) and is deleted
 * when the stream ends, fails or the client disconnects.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams
  const raw = query.get('raw') ?? '1'
  const parsed = raw === '0' || raw === '1'
    ? analysisWindowSchema.safeParse({ start: query.get('start') ?? '', end: query.get('end') ?? '', includeRaw: raw === '1' })
    : null
  if (!parsed?.success) {
    const detail = parsed ? parsed.error.issues.map(issue => issue.message).join('; ') : 'raw must be 0 or 1'
    return Response.json({ error: `Specify start and end as ISO 8601 or epoch ms, at most 14 days apart, and raw=0|1: ${detail}` }, { status: 400 })
  }
  if (inflight) return Response.json({ error: 'Another analysis export is in progress, retry later' }, { status: 429, headers: { 'Retry-After': '60' } })
  inflight = true

  let directory: string | undefined
  const release = async () => {
    const target = directory
    directory = undefined
    try {
      if (target) await rm(target, { recursive: true, force: true })
    }
    finally { inflight = false }
  }

  let bundle: AnalysisBundle
  try {
    const plan = await planAnalysisExport(parsed.data)
    const source = biometricsDb.$client.name
    const neededBytes = await liveDatabaseBytes(source)
    const space = await statfs(tmpdir())
    if (neededBytes > space.bavail * space.bsize) {
      await release()
      return Response.json({ error: `Not enough free space in ${tmpdir()} for a ${neededBytes}-byte database snapshot` }, { status: 507 })
    }
    directory = await mkdtemp(path.join(tmpdir(), 'sp-analysis-export-'))
    const [snapshot, build] = await Promise.all([snapshotBiometricsDatabase(source, directory), readBuildInfo()])
    bundle = { generatedAtMs: Date.now(), window: plan.window, database: { path: snapshot.path, bytes: snapshot.bytes },
      archives: plan.archives, build, pod: podIdentity(), schema: snapshot.schema }
  }
  catch (error) {
    await release()
    if (error instanceof AnalysisExportTooLargeError) return Response.json({ error: error.message }, { status: 413 })
    console.error('analysis export:', error)
    return Response.json({ error: 'Analysis export failed' }, { status: 500 })
  }

  const chunks = analysisExportChunks(bundle)
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let finished = false
  // Runs once on completion, failure, cancel, client abort or the watchdog.
  // chunks.return() closes any open file handle before the snapshot is removed.
  const finish = async () => {
    if (finished) return
    finished = true
    if (watchdog) clearTimeout(watchdog)
    request.signal.removeEventListener('abort', onAbort)
    try {
      await chunks.return(undefined)
    }
    finally { await release() }
  }
  const onAbort = () => void finish()
  request.signal.addEventListener('abort', onAbort, { once: true })
  // The client may have gone while the snapshot was being taken; the abort
  // event has then already fired, so clean up now instead of streaming.
  if (request.signal.aborted) {
    await finish()
    return new Response(null, { status: 499 })
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      watchdog = setTimeout(() => {
        controller.error(new Error('Analysis export exceeded its time limit'))
        void finish()
      }, EXPORT_WATCHDOG_MS)
    },
    async pull(controller) {
      try {
        const next = await chunks.next()
        if (next.done) {
          await finish()
          controller.close()
        }
        else controller.enqueue(next.value)
      }
      catch (error) {
        await finish()
        controller.error(error)
      }
    },
    async cancel() {
      await finish()
    },
  })
  const { startMs, endMs } = bundle.window
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-tar',
      'Content-Disposition': `attachment; filename="sleepypod-analysis-${startMs}-${endMs}.tar"`,
      'Content-Length': String(analysisBundleTarBytes(bundle)),
      // no-transform: a proxy that recompresses the tar would break Content-Length and the manifest hashes.
      'Cache-Control': 'no-store, no-transform',
    },
  })
}
