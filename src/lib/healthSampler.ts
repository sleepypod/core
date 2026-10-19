import { getRecordingPolicy } from '@/src/lib/recordingStore'
import { biometricsDb } from '@/src/db'
import { getDataPath } from '@/src/lib/dataPathCollect'
import { loadOpenRuns, recordSample, SAMPLE_INTERVAL_MS, type OpenRun } from '@/src/lib/healthHistory'

const shared = globalThis as typeof globalThis & {
  __healthSampler?: { timer: NodeJS.Timeout | null, open: Map<string, OpenRun> | null }
}
const sampler = shared.__healthSampler ??= { timer: null, open: null }

async function sampleOnce(): Promise<void> {
  const now = Date.now()
  if (!getRecordingPolicy(now).healthHistory) {
    sampler.open = new Map()
    return
  }
  const state = await getDataPath(now)
  // A setting may change while the asynchronous probe is in flight.
  if (!getRecordingPolicy(Date.now(), true).healthHistory) {
    sampler.open = new Map()
    return
  }
  sampler.open ??= loadOpenRuns(biometricsDb, now)
  recordSample(biometricsDb, sampler.open, state.nodes.map(n => ({ id: n.id, status: n.status, detail: n.detail })), now)
}

/**
 * Evaluate the data path once a minute and record it as System → Health's
 * 24-hour history. The first sample waits for the sensor source to settle so
 * startup doesn't record a burst of "no frames yet".
 */
export function startHealthSampler(initialDelayMs = 90_000): void {
  if (sampler.timer) return
  const tick = () => {
    sampleOnce().catch((err) => {
      console.warn('[health] sample failed:', err instanceof Error ? err.message : err)
    })
  }
  sampler.timer = setTimeout(() => {
    tick()
    sampler.timer = setInterval(tick, SAMPLE_INTERVAL_MS)
    sampler.timer.unref()
  }, initialDelayMs)
  sampler.timer.unref()
}

export function stopHealthSampler(): void {
  if (sampler.timer) {
    clearTimeout(sampler.timer)
    clearInterval(sampler.timer)
    sampler.timer = null
  }
  sampler.open = null
}
