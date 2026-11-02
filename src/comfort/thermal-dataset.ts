import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { comfortEventSchema } from './contract'
import { comfortLocalDate } from './policy'
import { median } from './signals'
import type { ThermalContext, ThermalNight } from './thermal-learning'
import { currentBedroomGuidance } from '@/src/bedroom/fusion'
import { previewReportId } from './report-evidence'
import { MAX_REPORT_ROWS, reportDigest, type PreviewSourceRow } from './report-summary'
import { previewReviewSchema } from './report-contract'
import { createHash } from 'node:crypto'
import type { PreviewEvidence } from './report-contract'

const MINIMUM_THERMAL_WINDOWS = 72
const MAXIMUM_THERMAL_GAP_MS = 10 * 60_000
const MINIMUM_NIGHT_MS = 6 * 3_600_000
const MAXIMUM_NIGHT_MS = 12 * 3_600_000
const MAXIMUM_EDGE_GAP_MS = 30 * 60_000

export interface ThermalDatasetAudit {
  nights: ThermalNight[]
  recordings: ThermalRecording[]
  proofs: { date: string, reportId: string, digest: string, reviewId: number, configuration: string }[]
  collection: { feedbackNights: number, excluded: { date: string, reason: string }[], policy: 'complete-reviewed-nights-v1' }
}

export interface ThermalRecording {
  date: string
  samples: { at: number, context: ThermalContext }[]
}

export function thermalConfiguration(evidence: PreviewEvidence, bedroomConfiguration: string | null): string {
  const { minimumF, maximumF, sensorAware, followBedtime } = evidence.policy
  return createHash('sha256').update(JSON.stringify([evidence.hardwareIdentity, evidence.presenceSourceKey,
    evidence.scheduleRevision, { minimumF, maximumF, sensorAware, followBedtime, roomAware: evidence.policy.roomAware === true }, bedroomConfiguration])).digest('hex')
}

/** Training requires the owner's review to match the retained source, including later corrections. */
function currentNightReview(database: Database.Database, side: Side, id: string, now: number): { digest: string, reviewId: number } | null {
  const row = database.prepare('SELECT id, created_at AS at, review FROM comfort_reviews WHERE side = ? AND report_id = ? ORDER BY id DESC LIMIT 1')
    .get(side, id) as { id: number, at: number, review: string } | undefined
  if (!row || row.at > now) return null
  try {
    const review = previewReviewSchema.parse({ ...JSON.parse(row.review), id: row.id, at: row.at })
    if (review.outcome !== 'reviewed' || !review.confirmedActualNight) return null
    const source = database.prepare('SELECT id, observed_at AS at, event FROM comfort_events WHERE side = ? AND report_id = ? ORDER BY id LIMIT ?')
      .all(side, id, MAX_REPORT_ROWS + 1) as PreviewSourceRow[]
    return source.length > 0 && source.length <= MAX_REPORT_ROWS && review.digest === reportDigest(source)
      ? { digest: review.digest, reviewId: row.id }
      : null
  }
  catch { return null }
}

/** Join one morning check-in to actual, quiet occupied observations from that side. */
export function thermalDatasetAudit(database: Database.Database, side: Side, now: number): ThermalDatasetAudit {
  const reports = database.prepare('SELECT local_date AS date, comfort FROM comfort_feedback WHERE side = ? ORDER BY local_date DESC LIMIT 90')
    .all(side) as { date: string, comfort: string }[]
  const rows = database.prepare('SELECT observed_at AS at, report_id AS reportId, event FROM comfort_events WHERE side = ? AND observed_at >= ? AND observed_at <= ? AND json_extract(event, \'$.thermalContext\') IS NOT NULL ORDER BY observed_at LIMIT 50000')
    .all(side, now - 90 * 86400000, now) as { at: number, reportId: string | null, event: string }[]
  const nights = new Map<string, { identity: string, configuration: string, id: string, start: number, end: number, minimumTarget: number, maximumTarget: number, samples: Map<number, { at: number, context: ThermalContext }> }>()
  const ambiguous = new Set<string>()
  for (const row of rows) {
    let value: unknown
    try {
      value = JSON.parse(row.event)
    }
    catch {
      continue
    }
    const parsed = comfortEventSchema.safeParse(value)
    if (!parsed.success) continue
    const event = parsed.data, preview = event.preview, context = event.thermalContext
    if (!preview || !context || event.kind !== 'preview' || event.session !== preview.session || event.at !== row.at
      || previewReportId(preview) !== row.reportId || preview.environment !== 'production' || !preview.buildRevision || !preview.hardwareIdentity
      || preview.end >= now || event.at < preview.start || event.at > preview.end
      || preview.presence !== 'occupied' || !preview.presenceSourceKey || !preview.mechanicallyQuiet
      || !preview.deviceFresh || preview.manualPaused || (!event.eligible && !event.thermalObservation)) continue
    if (event.thermalObservation && (!currentBedroomGuidance(preview.bedroom, event.at)
      || preview.bedroom?.configuration !== event.thermalObservation.bedroomConfiguration)) continue
    const date = comfortLocalDate(preview.end, preview.timezone)
    const sleepEnd = event.thermalObservation?.sleepWindowEnd ?? preview.end
    if (sleepEnd <= preview.start || sleepEnd > preview.end || event.at >= sleepEnd) continue
    // A sensor, schedule, deployment or assignment change makes one night label ambiguous.
    const identity = JSON.stringify([preview.session, preview.start, preview.end, preview.timezone,
      preview.hardwareIdentity, preview.buildRevision, preview.scheduleRevision, preview.presenceSourceKey,
      event.thermalObservation?.bedroomConfiguration ?? preview.bedroom?.configuration ?? null, sleepEnd])
    const configuration = thermalConfiguration(preview, event.thermalObservation?.bedroomConfiguration ?? preview.bedroom?.configuration ?? null)
    const group = nights.get(date) ?? { identity, configuration, id: previewReportId(preview), start: preview.start, end: sleepEnd,
      minimumTarget: context.targetF, maximumTarget: context.targetF, samples: new Map() }
    if (group.identity !== identity) ambiguous.add(date)
    group.minimumTarget = Math.min(group.minimumTarget, context.targetF)
    group.maximumTarget = Math.max(group.maximumTarget, context.targetF)
    // At most one observation per five minutes so high-rate recording cannot dominate a night.
    group.samples.set(Math.floor(event.at / 300000), { at: event.at, context })
    nights.set(date, group)
  }
  const excluded: ThermalDatasetAudit['collection']['excluded'] = []
  const proofs: ThermalDatasetAudit['proofs'] = []
  const recordings: ThermalRecording[] = []
  const accepted = reports.flatMap((feedback): ThermalNight[] => {
    const reject = (reason: string): ThermalNight[] => {
      excluded.push({ date: feedback.date, reason })
      return []
    }
    const night = nights.get(feedback.date)
    if (!night) return reject('No qualified overnight thermal observations match this check-in.')
    if (ambiguous.has(feedback.date)) return reject('The sensor, schedule, software or room configuration changed during this night.')
    if (!['warm', 'cold', 'comfortable'].includes(feedback.comfort)) return reject('The comfort check-in is unavailable.')
    const duration = night.end - night.start
    if (duration < MINIMUM_NIGHT_MS || duration > MAXIMUM_NIGHT_MS) return reject('The overnight window is outside the six-to-twelve-hour training range.')
    if (night.samples.size < MINIMUM_THERMAL_WINDOWS) return reject('Fewer than six hours of thermal observations were recorded.')
    // Buckets limit sample weight; only actual timestamps establish coverage and gaps.
    const samples = [...night.samples.values()].sort((first, second) => first.at - second.at)
    const firstSample = samples[0], lastSample = samples.at(-1)
    if (!firstSample || !lastSample || lastSample.at - firstSample.at < MINIMUM_NIGHT_MS
      || firstSample.at - night.start > MAXIMUM_EDGE_GAP_MS || night.end - lastSample.at > MAXIMUM_EDGE_GAP_MS
      || lastSample.at - firstSample.at < duration * 0.9
      || samples.some((sample, index) => index > 0 && sample.at - samples[index - 1].at > MAXIMUM_THERMAL_GAP_MS)) {
      return reject('The recording does not cover the complete overnight window without large gaps.')
    }
    const observedMs = samples.reduce((total, sample, index) => total + (index === 0 ? 0 : Math.min(300000, sample.at - samples[index - 1].at)), 0)
    if (observedMs < duration * 0.9) return reject('Less than 90% of the overnight window has thermal observations.')
    const contexts = samples.map(sample => sample.context)
    const targets = contexts.map(context => context.targetF)
    // A large overnight curve or wake warming makes one whole-night comfort label ambiguous.
    if (night.maximumTarget - night.minimumTarget > 2) return reject('Several different temperature targets make one morning check-in ambiguous.')
    const review = currentNightReview(database, side, night.id, now)
    if (!review) return reject('Review this night and confirm it was an actual overnight session before training.')
    proofs.push({ date: feedback.date, reportId: night.id, configuration: night.configuration, ...review })
    recordings.push({ date: feedback.date, samples })
    return [{ date: feedback.date, correction: feedback.comfort === 'warm' ? -1 : feedback.comfort === 'cold' ? 1 : 0,
      targetF: median(targets), waterF: median(contexts.map(context => context.waterF)),
      roomF: median(contexts.map(context => context.roomF)), humidity: median(contexts.map(context => context.humidity)) }]
  })
  return { nights: accepted, recordings, proofs, collection: { feedbackNights: reports.length, excluded, policy: 'complete-reviewed-nights-v1' } }
}

export function thermalDataset(database: Database.Database, side: Side, now: number): ThermalNight[] {
  return thermalDatasetAudit(database, side, now).nights
}
