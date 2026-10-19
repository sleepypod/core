import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { changeRecordingPolicy, DEFAULT_RECORDING_POLICY, recordingPolicySchema, type RecordingChange, type RecordingPolicy } from './recordingPolicy'

/** Shared with Python and the archiver. Only explicit user changes write this file. */
export function recordingPolicyPath(): string {
  return process.env.SP_RECORDING_POLICY_FILE || path.join(path.dirname(process.env.DATABASE_URL?.replace(/^file:/, '') || './sleepypod.dev.db'), 'recording-policy.json')
}
const globalState = globalThis as typeof globalThis & {
  __recordingPolicy?: { path: string, readAt: number, policy: RecordingPolicy }
}

export function getRecordingPolicy(now = Date.now(), fresh = false): RecordingPolicy {
  const file = recordingPolicyPath()
  const cached = globalState.__recordingPolicy
  if (!fresh && cached?.path === file && now >= cached.readAt && now - cached.readAt < 1000) return cached.policy
  let policy: RecordingPolicy
  try {
    policy = recordingPolicySchema.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ file, 'utf8')))
  }
  catch (error) {
    // Missing on first install; malformed/unreadable settings must not silently
    // re-enable recording after the user has disabled it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    policy = { ...DEFAULT_RECORDING_POLICY }
  }
  globalState.__recordingPolicy = { path: file, readAt: now, policy }
  return policy
}

export function setRecordingPolicy(change: RecordingChange, now = Date.now()): RecordingPolicy {
  // Synchronous read-modify-rename: concurrent mutations in this process cannot
  // lose unrelated settings. Atomic rename keeps sidecar readers consistent.
  const previous = getRecordingPolicy(now, true)
  const next = changeRecordingPolicy(previous, change, now)
  if (JSON.stringify(previous) === JSON.stringify(next)) return next
  const file = recordingPolicyPath()
  mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(/* turbopackIgnore: true */ temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o644, flag: 'wx' })
    renameSync(/* turbopackIgnore: true */ temporary, file)
  }
  finally {
    try {
      unlinkSync(/* turbopackIgnore: true */ temporary)
    }
    catch {
      // Rename already removed the temporary file on success. On failure,
      // preserve the original write error rather than masking it with cleanup.
    }
  }
  globalState.__recordingPolicy = { path: file, readAt: now, policy: next }
  return next
}
