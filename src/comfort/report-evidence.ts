import { createHash } from 'node:crypto'
import type { ComfortContext, ComfortState } from './policy'
import { DEVICE_MAX_AGE_MS, PRESENCE_MAX_AGE_MS, VITAL_MAX_AGE_MS } from './policy'
import { previewEvidenceSchema, type PreviewEvidence } from './report-contract'

export type PreviewOrigin = Pick<PreviewEvidence, 'environment' | 'buildRevision' | 'hardwareIdentity'>
const CALIBRATED_FRAME_MAX_AGE_MS = 30_000

/** Side is selected by the authenticated route/store; session identity contains no credentials. */
export function previewReportId(evidence: Pick<PreviewEvidence, 'session' | 'start' | 'end' | 'timezone'>): string {
  return createHash('sha256').update(JSON.stringify([evidence.session, evidence.start, evidence.end, evidence.timezone])).digest('hex')
}

function fresh(observedAt: number | null, now: number, maximumAge: number): boolean {
  return observedAt !== null && Number.isSafeInteger(observedAt) && observedAt <= now && now - observedAt <= maximumAge
}

/** Preserve what this evaluation actually saw; no elapsed sleep or physical success is inferred. */
export function capturePreviewEvidence(state: ComfortState, raw: ComfortContext, decisionBaselineF: number | null,
  timezone: string, runId: string, origin: PreviewOrigin): PreviewEvidence | undefined {
  const { window, now, presence, signals } = raw
  if (state.config.mode !== 'preview' || !window?.phases || window.start > now || window.end <= now) return undefined
  const calibrated = presence.available && fresh(presence.observedAt, now, PRESENCE_MAX_AGE_MS)
  const entry = presence.entry
  const sourceMatches = calibrated && entry && fresh(entry.measuredAt, now, CALIBRATED_FRAME_MAX_AGE_MS)
    && entry.state === (presence.occupied ? 'present' : 'absent')
  const parsed = previewEvidenceSchema.safeParse({
    format: 1, runId, ...origin, session: window.session, start: window.start, end: window.end, timezone,
    scheduleRevision: window.phases.revision,
    policy: { minimumF: state.config.minimumF, maximumF: state.config.maximumF, sensorAware: state.config.sensorAware === true,
      followBedtime: state.config.followBedtime === true, roomAware: state.config.roomAware === true, offsetF: state.offsetF },
    bedroom: state.config.roomAware ? raw.bedroom ?? null : null,
    scheduledBaselineF: window.baselineF, decisionBaselineF,
    presence: calibrated ? presence.occupied ? 'occupied' : 'empty' : 'unavailable',
    presenceSourceKey: sourceMatches ? entry.sourceKey : null,
    mechanicallyQuiet: raw.device.baseMoving === false && raw.device.priming === false && raw.device.vibrating === false,
    deviceFresh: fresh(raw.device.observedAt, now, DEVICE_MAX_AGE_MS),
    sensorReady: signals?.state === 'ready' && fresh(signals.sampleAt, now, VITAL_MAX_AGE_MS)
      && signals.expiresAt !== null && signals.expiresAt > now,
    manualPaused: state.pausedUntil > now || raw.owner === 'manual' || raw.owner === 'run-once',
  })
  return parsed.success ? parsed.data : undefined
}
