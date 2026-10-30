import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { BedroomComfortGuidance } from '@/src/bedroom/contract'
import { withSideLock } from '@/src/hardware/sideLock'
import { createComfortOwner } from '../owner'
import { createComfortStore, comfortEvent } from '../store'
import { defaultComfortState, type ComfortContext, type ComfortState } from '../policy'
import { capturePreviewEvidence, previewReportId } from '../report-evidence'
import { createPreviewReports } from '../reports'
import type { OwnerIdentity, QualificationKind } from '../owner-contract'
import { migratedComfortDatabase } from './databaseFixture'

const DAY = 86_400_000
/** Synthetic database only. No production identity overrides or hardware services are involved. */
export function ownerFixture() {
  const database = migratedComfortDatabase()
  const store = createComfortStore(database)
  let now = Date.parse('2026-11-05T18:00:00Z')
  let running = true
  let enabled = true
  let identifiable = true
  const identity: OwnerIdentity = { hardware: 'd'.repeat(64), calibration: 'c'.repeat(64), schedule: 'b'.repeat(64), build: 'a'.repeat(40),
    policy: { minimumF: 70, maximumF: 95, sensorAware: false, followBedtime: false } }
  const context: ComfortContext = {
    now, window: null,
    device: { observedAt: now, powered: false, offConfirmed: true, targetF: 75, waterAdequate: true, priming: false, vibrating: false, baseMoving: false },
    presence: { observedAt: now, available: true, occupied: false, entry: { measuredAt: now, sourceKey: identity.calibration, state: 'absent' } },
    eitherAway: false, routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true,
  }
  const configure = (change: Partial<ComfortState>) => store.commit('left', { ...store.read('left'), ...change })
  configure({ ...defaultComfortState(), config: { ...identity.policy, mode: 'preview' } })
  const revokeLease = vi.fn()
  const deps = { database, store, now: () => now, running: () => running, autopilotEnabled: () => enabled, withSideLock, revokeLease,
    identity: (_side: unknown, state: ComfortState) => identifiable
      ? { ...identity, policy: { minimumF: state.config.minimumF, maximumF: state.config.maximumF,
          sensorAware: state.config.sensorAware === true, followBedtime: state.config.followBedtime === true, roomAware: state.config.roomAware === true } }
      : null,
    context: () => context }
  const owner = createComfortOwner(deps)
  const reports = createPreviewReports(database, () => now)
  function refresh(at = now) {
    now = at
    context.now = at
    context.device.observedAt = at
    context.presence.observedAt = at
    if (context.presence.entry) context.presence.entry.measuredAt = at
  }
  function application(source: 'manual' | 'schedule', targetF: number) {
    database.prepare(`INSERT INTO temperature_applications (attempt_id, side, attempted_at, finished_at, outcome, request)
      VALUES (?, 'left', ?, ?, 'acknowledged', ?)`).run(randomUUID(), now - 120_001, now - 120_000,
      JSON.stringify({ side: 'left', source, targetF, durationSec: null, reason: source === 'manual' ? 'manual' : 'reconcile', requestId: null }))
  }
  async function qualify(kind: QualificationKind) {
    const review = await owner.prepare({ side: 'left', purpose: 'qualification', kind })
    await owner.confirm({ side: 'left', id: review.id, confirmed: true, note: 'Synthetic owner observation in an isolated test.' })
    return review
  }
  async function qualifyAll() {
    await qualify('presence_empty')
    context.presence.occupied = true
    if (context.presence.entry) context.presence.entry.state = 'present'
    await qualify('presence_occupied')
    context.device.powered = true
    context.device.targetF = 73
    application('manual', 73)
    await qualify('cooling')
    context.device.targetF = 77
    application('manual', 77)
    await qualify('warming')
    context.device.powered = false
    configure({ pausedUntil: now + 6 * 3_600_000 })
    await qualify('manual_stop')
    application('schedule', 75)
    database.prepare(`INSERT INTO alarm_occurrences (side, schedule_id, original_at, effective_at, outcome, attempted_at)
      VALUES ('left', 1, ?, ?, 'acknowledged', ?)`).run(now - 1000, now - 1000, now - 1000)
    await qualify('offline_routine')
  }
  async function night(daysAgo: number, change: { eligible?: boolean, hardware?: string | null, build?: string, policy?: Partial<OwnerIdentity['policy']>, bedroom?: BedroomComfortGuidance } = {}) {
    const start = now - daysAgo * DAY
    const state = { ...defaultComfortState(), config: { ...identity.policy, ...change.policy, mode: 'preview' as const } }
    const runId = randomUUID()
    let id = ''
    for (let minute = 0; minute <= 240; minute++) {
      const at = start + minute * 60_000
      const input: ComfortContext = { ...context, now: at,
        bedroom: change.bedroom ? { ...change.bedroom, expiresAt: at + 60000 } : undefined,
        window: { start, end: start + 8 * 3_600_000, session: `synthetic:${start}`, segment: 'first', baselineF: 75, alarmAt: null,
          phases: { revision: identity.schedule, startF: 75, changes: [] } },
        device: { ...context.device, observedAt: at, powered: true, targetF: 75 },
        presence: { observedAt: at, available: true, occupied: true, entry: { measuredAt: at, sourceKey: identity.calibration, state: 'present' } } }
      const evidence = capturePreviewEvidence(state, input, 75, 'America/Los_Angeles', runId,
        { environment: 'production', buildRevision: change.build ?? identity.build, hardwareIdentity: change.hardware === undefined ? identity.hardware : change.hardware })
      if (!evidence) throw new Error('Synthetic evidence is required')
      id = previewReportId(evidence)
      const event = { ...comfortEvent(at, 'preview', 'Synthetic preview.'), session: evidence.session, eligible: change.eligible ?? true,
        proposedF: 74, reportedF: 75, deviceObservedAt: at, presenceObservedAt: at, preview: evidence }
      database.prepare('INSERT INTO comfort_events (side, observed_at, event, report_id) VALUES (?, ?, ?, ?)').run('left', at, JSON.stringify(event), id)
    }
    const detail = await reports.detail('left', id)
    await reports.review({ side: 'left', id, digest: detail.summary.digest, expectedReviewId: null, outcome: 'reviewed',
      confirmedActualNight: true, note: 'Synthetic fixture; not an actual night.' })
    return id
  }
  async function ready() {
    await qualifyAll()
    for (let days = 7; days > 0; days--) await night(days)
  }
  return { database, store, owner, reports, identity, context, deps, configure, refresh, qualify, qualifyAll, night, ready, application,
    now: () => now, setRunning: (value: boolean) => { running = value },
    setEnabled: (value: boolean) => { enabled = value },
    setIdentifiable: (value: boolean) => { identifiable = value } }
}
