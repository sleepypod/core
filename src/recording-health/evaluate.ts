import type { DataPathState, NodeId } from '@/src/lib/dataPath'
import type { HealthHistory } from '@/src/lib/healthHistory'
import type { RecordingCheck, RecordingHealth } from './contract'
import { PRESENCE_BREAK_REVIEW_COUNT, type PresenceBreakAssessment } from './fragmentation'

export const RECORDING_CHECK_MAX_AGE_MS = 60_000
export const MINIMUM_RECORDING_FREE_BYTES = 256 * 1024 * 1024
const required: Array<{ id: NodeId, title: string, nextStep: string }> = [
  { id: 'sensor-cap', title: 'Presence sensor', nextStep: 'Open recording diagnostics and check the cover connection and presence calibration.' },
  { id: 'sensor-piezo', title: 'Heartbeat and movement signal', nextStep: 'Check the sensor connection in recording diagnostics. Missing signal cannot establish sleep stages.' },
  { id: 'sleep-detector', title: 'Recording processor', nextStep: 'Open recording diagnostics to inspect the sleep detector before another night.' },
  { id: 'piezo-processor', title: 'Vitals processor', nextStep: 'Open recording diagnostics to inspect why heart rate and breathing estimates are not updating.' },
  { id: 'database', title: 'Configuration database', nextStep: 'Open database diagnostics. Preserve a backup before maintenance.' },
]

/** Readiness is a current pipeline check, never a claim that sleep was measured accurately. */
export function evaluateRecordingHealth(input: {
  now: number
  path: DataPathState | null
  history: HealthHistory | null
  storage: { availableBytes: number, totalBytes: number } | null
  recordingDatabaseReadable: boolean | null
  presenceBreaks?: PresenceBreakAssessment | null
}): RecordingHealth {
  const { now, path, history, storage } = input
  const current = path !== null && Number.isSafeInteger(path.at) && path.at <= now
    && path.at >= now - RECORDING_CHECK_MAX_AGE_MS
  const checks: RecordingCheck[] = required.map(({ id, title, nextStep }) => {
    const node = current ? path.nodes.find(item => item.id === id) : undefined
    const missingOutput = id !== 'database' && node?.status === 'ok' && node.lastOutputAt === null
    const invalidOutput = missingOutput || (node?.lastOutputAt != null
      && (!Number.isSafeInteger(node.lastOutputAt) || node.lastOutputAt < 0 || node.lastOutputAt > now))
    const unknown = !node || invalidOutput || node.status === 'unknown'
    const attention = node?.status === 'stale' || node?.status === 'down'
    return { id, title, state: unknown ? 'unknown' : attention ? 'attention' : 'ok',
      detail: unknown ? 'No trustworthy current check is available.' : node.detail,
      nextStep: unknown || attention ? nextStep : null,
      observedAt: unknown ? null : path?.at ?? null }
  })

  // DataPath checks the configuration database. Confirm the distinct recording
  // database too; a healthy configuration DB does not establish recording health.
  checks.push({ id: 'recording-database', title: 'Saved recording access',
    state: input.recordingDatabaseReadable === null ? 'unknown' : input.recordingDatabaseReadable ? 'ok' : 'attention',
    detail: input.recordingDatabaseReadable === null
      ? 'The recording database has not been checked.'
      : input.recordingDatabaseReadable ? 'The sleep-record table answers a read query.' : 'The sleep-record table could not be read.',
    nextStep: input.recordingDatabaseReadable === true ? null : 'Open database diagnostics and preserve existing recordings before repairs.',
    observedAt: input.recordingDatabaseReadable === null ? null : now })

  const storageKnown = storage !== null && Number.isSafeInteger(storage.availableBytes) && Number.isSafeInteger(storage.totalBytes)
    && storage.totalBytes > 0 && storage.availableBytes >= 0 && storage.availableBytes <= storage.totalBytes
  const lowStorage = storageKnown && (storage.availableBytes < MINIMUM_RECORDING_FREE_BYTES || storage.availableBytes / storage.totalBytes < 0.05)
  checks.push({ id: 'storage', title: 'Recording storage', state: !storageKnown ? 'unknown' : lowStorage ? 'attention' : 'ok',
    detail: !storageKnown
      ? 'Free space on the recording filesystem is unavailable.'
      : `${Math.floor(storage.availableBytes / 1024 / 1024)} MB available on the recording filesystem.${lowStorage ? ' Less than 256 MB or 5% remains.' : ''}`,
    nextStep: storageKnown && !lowStorage ? null : 'Open Storage to review backups and removable files. No recordings are deleted automatically by this check.',
    observedAt: storageKnown ? now : null })

  const historyCurrent = history !== null && Number.isSafeInteger(history.to) && history.to <= now
    && history.to >= now - RECORDING_CHECK_MAX_AGE_MS
  const presence = historyCurrent ? history.checks.find(check => check.id === 'sensor-cap') : undefined
  const disruptions = historyCurrent
    ? history.incidents.filter(incident => incident.checkId === 'sensor-cap'
      && incident.start >= now - 24 * 3_600_000 && incident.start <= now).length
    : 0
  const repeated = disruptions >= 2
  const knownHistory = presence?.healthyShare != null && history?.recordedSince != null
    && Number.isSafeInteger(history.recordedSince) && history.recordedSince <= history.to && history.recordedSince >= history.from
  const signalDetail = repeated
    ? `${disruptions} presence-signal interruptions were recorded in the last 24 hours. Recording gaps may follow; this does not prove time awake or out of bed.`
    : knownHistory
      ? `${disruptions} presence-signal interruptions in the available monitoring history. Unmonitored time remains unknown.`
      : 'Not enough monitoring history to assess repeated interruptions.'
  const breaks = input.presenceBreaks
  const breaksCurrent = breaks != null && Number.isSafeInteger(breaks.observedAt)
    && breaks.observedAt <= now && breaks.observedAt >= now - RECORDING_CHECK_MAX_AGE_MS && breaks.status !== 'unavailable'
  const assessed = breaksCurrent ? breaks.sides.filter(side => side.records > 0) : []
  const clustered = assessed.some(side => side.mostInOneHour >= PRESENCE_BREAK_REVIEW_COUNT)
  const breaksKnown = breaksCurrent && breaks.status === 'read' && assessed.length > 0
  const breakDetail = !breaksCurrent
    ? 'Completed-record presence review is unavailable.'
    : assessed.length === 0
      ? 'No usable completed presence intervals in the last 24 hours.'
      : assessed.map(side => `${side.side === 'left' ? 'Left' : 'Right'} recording stream, usable completed intervals: ${side.shortBreaks} short reported breaks (30–120 seconds), up to ${side.mostInOneHour} in one hour.`).join(' ')
  const clocks = [knownHistory || repeated ? history?.to : null, breaksCurrent ? breaks.observedAt : null]
    .filter((clock): clock is number => clock != null)
  checks.push({ id: 'presence-history', title: 'Recent presence interruptions',
    state: repeated || clustered ? 'attention' : knownHistory && breaksKnown ? 'ok' : 'unknown',
    detail: `${signalDetail} ${breakDetail}${breaksCurrent && breaks.status === 'partial' ? ' Some interval evidence was excluded or exceeded the review limit.' : ''}${clustered ? ' Repeated short breaks warrant review; genuine exits and inconsistent sensing can look alike.' : ''} Only completed records are reviewed; an unfinished night is not included. In solo-anywhere mode one recording stream can combine both zones. Reported presence is not measured sleep or uninterrupted sensor coverage.`,
    nextStep: repeated || clustered
      ? 'Compare the recording gaps with your actual time in bed in Sleep and System → Health history. If they disagree, inspect the cover connection and presence calibration; this check changes neither.'
      : knownHistory && breaksKnown ? null : 'Check again after a completed night; use recording diagnostics if a source remains unavailable.',
    observedAt: clocks.length ? Math.min(...clocks) : null })

  const state = checks.some(check => check.state === 'attention')
    ? 'attention'
    : checks.some(check => check.state === 'unknown') ? 'unknown' : 'ready'
  const expiresAt = Math.min(now + RECORDING_CHECK_MAX_AGE_MS,
    ...checks.flatMap(check => check.observedAt === null ? [] : [check.observedAt + RECORDING_CHECK_MAX_AGE_MS]))
  return { apiVersion: 1, generatedAt: now, expiresAt, state, historicalWindowHours: 24, checks,
    summary: state === 'attention'
      ? 'Recording needs attention'
      : state === 'unknown' ? 'Recording checks are incomplete' : 'Recording checks are ready' }
}
