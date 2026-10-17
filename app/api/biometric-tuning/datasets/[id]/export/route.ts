import { NextResponse } from 'next/server'
import { z } from 'zod'
import { biometricsDb } from '@/src/db'
import { coordinatorRequest } from '@/src/biometrics/backtest/coordinator-service'
import type { CoordinatorResults } from '@/src/biometrics/backtest/coordinator-tasks'
import { datasetBundleChunks, datasetBundleTarBytes, retainedRawDirectory } from '@/src/biometrics/backtest/dataset-export'

// One export at a time: each one reads every retained archive of the dataset
// twice (verification, then streaming). A stalled client must not latch it.
let inflight = false
const EXPORT_WATCHDOG_MS = (() => {
  const raw = Number(process.env.DATASET_EXPORT_WATCHDOG_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000
})()

function errorResponse(error: unknown) {
  // Match on the code, not the class: the coordinator's reply is rebuilt as a
  // ReferenceInputError that need not be the same class instance this route
  // imports once Next has bundled both.
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'NOT_FOUND' || code === 'DATASET_RELEASED') return NextResponse.json({ error: 'Dataset not found or released' }, { status: 404 })
  if (code === 'DATASET_CORRUPT') return NextResponse.json({ error: `DATASET_CORRUPT: ${(error as Error).message}` }, { status: 409 })
  if (code === 'WORKER_UNAVAILABLE') return NextResponse.json({ error: (error as Error).message }, { status: 503 })
  return NextResponse.json({ error: 'Dataset export failed' }, { status: 500 })
}

/**
 * Stream one frozen calibration dataset as an uncompressed tar: bundle.json
 * (index with every file's SHA-256), manifest.json, snapshot.json and the
 * retained raw/<sha256>.RAW.gz archives it references. Nothing else is read.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'Invalid dataset id' }, { status: 400 })
  if (inflight) return NextResponse.json({ error: 'Another dataset export is in progress, retry later' }, { status: 429, headers: { 'Retry-After': '60' } })
  inflight = true
  let prepared: CoordinatorResults['exportDataset']
  let directory: string
  try {
    prepared = await coordinatorRequest(biometricsDb, { type: 'exportDataset', input: { id } })
    directory = retainedRawDirectory(biometricsDb)
  }
  catch (error) {
    inflight = false
    return errorResponse(error)
  }

  const chunks = datasetBundleChunks(prepared.index, { manifest: prepared.manifestText, snapshot: prepared.snapshotText }, directory)
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const release = () => {
    if (watchdog) clearTimeout(watchdog)
    inflight = false
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      watchdog = setTimeout(() => {
        controller.error(new Error('Dataset export exceeded its time limit'))
        void chunks.return(undefined).finally(release)
      }, EXPORT_WATCHDOG_MS)
    },
    async pull(controller) {
      try {
        const next = await chunks.next()
        if (next.done) {
          release()
          controller.close()
        }
        else controller.enqueue(next.value)
      }
      catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel() {
      await chunks.return(undefined).finally(release)
    },
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-tar',
      'Content-Disposition': `attachment; filename="calibration-dataset-${id}.tar"`,
      'Content-Length': String(datasetBundleTarBytes(prepared.index)),
      'Cache-Control': 'no-store',
      'X-Dataset-Content-Hash': prepared.index.dataset.contentHash,
    },
  })
}
