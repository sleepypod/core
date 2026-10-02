import { biometricsDb } from '@/src/db'
import { getDataPath } from '@/src/lib/dataPathCollect'
import { loadOpenRuns, recordSample, SAMPLE_INTERVAL_MS, type OpenRun } from '@/src/lib/healthHistory'

let timer: NodeJS.Timeout | null = null
let open: Map<string, OpenRun> | null = null

async function sampleOnce(): Promise<void> {
  const now = Date.now()
  const state = await getDataPath(now)
  open ??= loadOpenRuns(biometricsDb, now)
  recordSample(biometricsDb, open, state.nodes.map(n => ({ id: n.id, status: n.status, detail: n.detail })), now)
}

/**
 * Evaluate the data path once a minute and record it as System → Health's
 * 24-hour history. The first sample waits for the sensor source to settle so
 * startup doesn't record a burst of "no frames yet".
 */
export function startHealthSampler(initialDelayMs = 90_000): void {
  if (timer) return
  const tick = () => {
    sampleOnce().catch((err) => {
      console.warn('[health] sample failed:', err instanceof Error ? err.message : err)
    })
  }
  timer = setTimeout(() => {
    tick()
    timer = setInterval(tick, SAMPLE_INTERVAL_MS)
    timer.unref()
  }, initialDelayMs)
  timer.unref()
}

export function stopHealthSampler(): void {
  if (timer) {
    clearTimeout(timer)
    clearInterval(timer)
    timer = null
  }
  open = null
}
