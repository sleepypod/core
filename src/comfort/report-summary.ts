import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { comfortEventSchema } from './contract'
import { comfortLocalDate } from './policy'
import { previewReportId } from './report-evidence'
import { previewSummarySchema, type PreviewSummary, type PreviewEvidence } from './report-contract'

export const MIN_OCCUPIED_OBSERVATION_MS = 14_400_000
export const MAX_REPORT_ROWS = 20_000
export const REPORT_RETENTION_MS = 30 * 86_400_000
export interface PreviewSourceRow { id: number, at: number, event: string }
export class PreviewReportError extends Error {
  constructor(message: string, readonly code: 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED') { super(message) }
}

export function reportDigest(rows: PreviewSourceRow[]): string {
  const hash = createHash('sha256')
  for (const row of rows) hash.update(JSON.stringify([row.id, row.at, row.event]))
  return hash.digest('hex')
}
function range(values: number[]) {
  return values.length ? { minimum: Math.min(...values), maximum: Math.max(...values) } : null
}
function qualified(value: PreviewEvidence) {
  return value.presence === 'occupied' && value.deviceFresh && value.mechanicallyQuiet && value.presenceSourceKey !== null
}

/** Counts recorded observations, not inferred sleep minutes or continuous sensor coverage. */
export async function summarizePreview(id: string, rows: PreviewSourceRow[], now: number) {
  if (!rows.length) throw new PreviewReportError('Preview report source is no longer retained.', 'NOT_FOUND')
  if (rows.length > MAX_REPORT_ROWS) throw new PreviewReportError('Preview report exceeds the inspection limit. Export and investigate its journal before review.', 'PRECONDITION_FAILED')
  const observations = []
  const issues = new Set<string>()
  const configs = new Set<string>()
  const runs = new Set<string>()
  const builds = new Set<string>()
  const reasons = new Map<string, number>()
  const gaps: PreviewSummary['gaps'] = []
  let previous: (PreviewSourceRow & { evidence: PreviewEvidence }) | undefined
  let occupiedObservationMs = 0
  let occupiedCount = 0
  let sensorReadyCount = 0
  let deviceFreshCount = 0
  let manualPauseCount = 0
  for (const [index, row] of rows.entries()) {
    const event = comfortEventSchema.parse(JSON.parse(row.event))
    const evidence = event.preview
    if (!evidence || event.kind !== 'preview' || event.session !== evidence.session || previewReportId(evidence) !== id
      || event.at !== row.at || row.at < evidence.start || row.at >= evidence.end || row.at > now) {
      throw new PreviewReportError('Preview observations have inconsistent identity or timestamps.', 'PRECONDITION_FAILED')
    }
    if (evidence.environment !== 'production') issues.add('Some observations came from a test, development or unidentified runtime.')
    if (!evidence.buildRevision) issues.add('Some observations have no recorded build identity.')
    else builds.add(evidence.buildRevision)
    if (previous && row.at <= previous.at) issues.add('The observation clock repeated or moved backward; inspect before counting this night.')
    if (previous && row.at - previous.at > 90_000) gaps.push({ from: previous.at, to: row.at })
    if (previous && row.at > previous.at && row.at - previous.at <= 90_000
      && evidence.runId === previous.evidence.runId && evidence.presenceSourceKey === previous.evidence.presenceSourceKey
      && qualified(evidence) && qualified(previous.evidence)) occupiedObservationMs += row.at - previous.at
    previous = { ...row, evidence }
    configs.add(JSON.stringify([evidence.scheduleRevision, evidence.policy, evidence.bedroom?.configuration ?? null]))
    runs.add(evidence.runId)
    if (evidence.presence === 'occupied') occupiedCount++
    if (evidence.sensorReady) sensorReadyCount++
    if (evidence.deviceFresh) deviceFreshCount++
    if (evidence.manualPaused) manualPauseCount++
    reasons.set(event.message, (reasons.get(event.message) ?? 0) + 1)
    observations.push({ id: row.id, at: row.at, eligible: event.eligible, proposedF: event.proposedF,
      reportedF: event.reportedF, message: event.message, evidence })
    // Journal reads must yield so a larger report does not monopolize the Pod event loop.
    if (index % 256 === 255) await setImmediate()
  }
  const first = observations[0]
  const last = observations.at(-1)
  if (!last) throw new PreviewReportError('Preview report is empty.', 'NOT_FOUND')
  const { session, start, end, timezone } = first.evidence
  const metadata = { session, start, end, timezone }
  if (first.at - start > 90_000) gaps.unshift({ from: start, to: first.at })
  if (Math.min(now, end) - last.at > 90_000) gaps.push({ from: last.at, to: Math.min(now, end) })
  if (first.at < now - REPORT_RETENTION_MS) issues.add('Some source observations exceed the journal retention window.')
  if (occupiedObservationMs < MIN_OCCUPIED_OBSERVATION_MS) issues.add('Fewer than four hours of fresh, mechanically quiet occupied-side observation intervals were recorded.')
  if (observations.length < 2 || first.at === last.at || occupiedCount === 0) issues.add('No repeated occupied-side observations are available for owner confirmation.')
  const summary = previewSummarySchema.parse({
    id, digest: reportDigest(rows), metadata, localDate: comfortLocalDate(start, timezone),
    state: now < end ? 'collecting' : 'closed', firstAt: first.at, lastAt: last.at,
    observationCount: observations.length, occupiedObservationMs, minimumOccupiedObservationMs: MIN_OCCUPIED_OBSERVATION_MS, occupiedCount, sensorReadyCount, deviceFreshCount, manualPauseCount,
    eligibleCount: observations.filter(event => event.eligible).length,
    proposedRangeF: range(observations.flatMap(event => event.proposedF === null ? [] : [event.proposedF])),
    reportedRangeF: range(observations.flatMap(event => event.reportedF === null ? [] : [event.reportedF])),
    reasons: [...reasons].map(([message, count]) => ({ message, count })).sort((first, second) => second.count - first.count).slice(0, 20),
    gaps: gaps.slice(0, 20), gapCount: gaps.length, configurations: configs.size, runs: runs.size, builds: [...builds].sort(),
    issues: [...issues], reviewable: now >= end && issues.size === 0,
  })
  return { summary, observations }
}
