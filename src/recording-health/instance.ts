import { statfs } from 'node:fs/promises'
import { biometricsDb } from '@/src/db'
import { getObservedDataPath } from '@/src/lib/dataPathCollect'
import { readHistory, type HealthHistory } from '@/src/lib/healthHistory'
import { evaluateRecordingHealth } from './evaluate'
import type { RecordingHealth } from './contract'
import { readPresenceBreaks } from './fragmentation-read'

const globals = globalThis as typeof globalThis & {
  __sp_recordingHealth?: { saved?: RecordingHealth, pending?: Promise<RecordingHealth> }
}

/** A shared, bounded read. No cleanup, calibration, service restart or hardware mutation. */
export async function getRecordingHealth(): Promise<RecordingHealth> {
  const state = globals.__sp_recordingHealth ??= {}
  const now = Date.now()
  if (state.saved && now >= state.saved.generatedAt && now < state.saved.expiresAt && now - state.saved.generatedAt < 15_000) return state.saved
  if (state.pending) return state.pending
  state.pending = collect().then((report) => {
    state.saved = report
    return report
  }).finally(() => { state.pending = undefined })
  return state.pending
}

async function collect(): Promise<RecordingHealth> {
  const database = biometricsDb.$client
  const [path, filesystem] = await Promise.allSettled([
    getObservedDataPath(),
    // Inspect the actual SQLite file's filesystem; never silently use the root disk.
    database.name && database.name !== ':memory:' ? statfs(database.name) : Promise.reject(new Error('No recording filesystem')),
  ])
  const now = Date.now()
  let history: HealthHistory | null = null
  let recordingDatabaseReadable = false
  try {
    database.prepare('SELECT id FROM sleep_records LIMIT 1').get()
    recordingDatabaseReadable = true
  }
  catch { /* A read failure is an actionable result; never create missing tables here. */ }
  try {
    history = readHistory(biometricsDb, now)
  }
  catch { /* Missing history is unknown, not zero interruptions. */ }
  const storage = filesystem.status === 'fulfilled'
    ? {
        availableBytes: filesystem.value.bavail * filesystem.value.bsize,
        totalBytes: filesystem.value.blocks * filesystem.value.bsize,
      }
    : null
  return evaluateRecordingHealth({ now, storage, history, recordingDatabaseReadable,
    presenceBreaks: readPresenceBreaks(database, now),
    path: path.status === 'fulfilled' ? path.value : null })
}
