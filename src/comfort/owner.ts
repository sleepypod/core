import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { durableTransaction } from '@/src/db/durable'
import type { ComfortAdmission } from './application'
import type { ComfortContext, ComfortState } from './policy'
import { MANUAL_PAUSE_MS } from './policy'
import { comfortEvent, type ComfortStore } from './store'
import { createPreviewReports } from './reports'
import { evidenceMeaning, readQualificationEvidence, requireOwner } from './owner-evidence'
import {
  ownerConfirmSchema, ownerIdentitySchema, ownerPrepareSchema, ownerReviewSchema, ownerSnapshotSchema, ownerStatusSchema,
  qualificationKindSchema, qualificationLabels, qualificationSchema,
  type OwnerIdentity, type OwnerSnapshot, type Qualification, type QualificationKind,
} from './owner-contract'
import type { z } from 'zod'

export interface ComfortOwnerDeps {
  database: Database.Database
  store: ComfortStore
  now(): number
  identity(side: Side, state: ComfortState): OwnerIdentity | null
  context(side: Side, state: ComfortState, now: number): ComfortContext
  autopilotEnabled(): boolean
  running(): boolean
  withSideLock<Result>(side: Side, operation: () => Promise<Result>): Promise<Result>
  revokeLease(side: Side): void
}
const same = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second)
interface GrantRow { id: string, at: number, snapshot: string }

/** Only authenticated owner routes call this service. Client input cannot supply evidence or a night count. */
export function createComfortOwner(deps: ComfortOwnerDeps) {
  const { database, store } = deps
  const reports = createPreviewReports(database, deps.now)
  function now() {
    const value = deps.now()
    requireOwner(Number.isSafeInteger(value) && value > 0, 'The controller clock is unavailable.')
    return value
  }
  function identity(side: Side, state: ComfortState) {
    const value = deps.identity(side, state)
    return value ? ownerIdentitySchema.parse(value) : null
  }
  function qualifications(side: Side): Qualification[] {
    return qualificationKindSchema.options.flatMap((kind) => {
      const row = database.prepare('SELECT record FROM comfort_qualifications WHERE side = ? AND kind = ? ORDER BY sequence DESC LIMIT 1')
        .get(side, kind) as { record: string } | undefined
      return row ? [qualificationSchema.parse(JSON.parse(row.record))] : []
    })
  }
  function matchingQualifications(side: Side, current: OwnerIdentity) {
    return qualifications(side).filter(record => record.at <= now() && same(record.evidence.identity, current))
  }
  function revoke(side: Side, reason: string) {
    deps.revokeLease(side)
    durableTransaction(database, () => {
      database.prepare('UPDATE comfort_activations SET revoked_at = ?, reason = ? WHERE side = ? AND revoked_at IS NULL').run(now(), reason, side)
    })
  }
  function assertReferences(side: Side, snapshot: OwnerSnapshot, source: boolean) {
    const current = matchingQualifications(side, snapshot.identity)
    requireOwner(snapshot.qualifications.length === qualificationKindSchema.options.length
      && qualificationKindSchema.options.every(kind => snapshot.qualifications.some(record => record.kind === kind
        && record.outcome === 'confirmed' && current.some(value => value.id === record.id && value.outcome === 'confirmed'))),
    'Attended qualification changed. Repeat the affected check before activation.')
    const cooling = snapshot.qualifications.find(record => record.kind === 'cooling')?.evidence.targetF
    const warming = snapshot.qualifications.find(record => record.kind === 'warming')?.evidence.targetF
    requireOwner(cooling !== null && cooling !== undefined && warming !== null && warming !== undefined && warming >= cooling + 2,
      'Cooling and warming qualifications need distinct targets at least 2°F apart.')
    requireOwner(snapshot.nights.length === 7, 'Seven matching, source-backed, owner-reviewed Preview nights are required.')
    reports.assertProofsCurrent(side, snapshot.nights, source)
  }
  function validGrant(side: Side, state: ComfortState) {
    try {
      const at = now()
      if (state.config.mode !== 'active' || !deps.running() || !deps.autopilotEnabled()) return null
      const row = database.prepare(`SELECT id, created_at AS at, snapshot FROM comfort_activations
        WHERE side = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(side) as GrantRow | undefined
      if (!row || row.at > at) return null
      const snapshot = ownerSnapshotSchema.parse(JSON.parse(row.snapshot))
      if (!same(identity(side, state), snapshot.identity) || snapshot.identity.policy.followBedtime) return null
      assertReferences(side, snapshot, false)
      return { row, snapshot, at }
    }
    catch { return null }
  }
  function admission(side: Side, state: ComfortState): ComfortAdmission | null {
    const grant = validGrant(side, state)
    return grant ? { revision: grant.row.id, issuedAt: grant.row.at, expiresAt: grant.at + 10_000 } : null
  }
  async function status(side: Side) {
    const at = now()
    const state = store.read(side)
    const current = identity(side, state)
    const recorded = qualifications(side)
    const matching = current ? matchingQualifications(side, current) : []
    const grant = validGrant(side, state)
    const nights = grant?.snapshot.nights ?? (current ? await reports.activationProofs(side, current) : [])
    const reasons: string[] = []
    if (!current) reasons.push('Production Pod identity, calibrated presence, build and enabled routine identity are required.')
    if (!deps.running()) reasons.push('The personal comfort service is stopped.')
    if (!deps.autopilotEnabled()) reasons.push('Global Autopilot is off. Review its existing rules before enabling it; activation will not change that switch.')
    if (state.config.followBedtime) reasons.push('Bed-entry phase shifting remains Preview-only. Disable it and collect matching nights before thermal activation.')
    if (state.config.mode !== 'preview' && state.config.mode !== 'active') reasons.push('Start Preview before preparing activation.')
    for (const kind of current ? qualificationKindSchema.options : []) {
      if (!matching.some(record => record.kind === kind && record.outcome === 'confirmed')) reasons.push(`${qualificationLabels[kind]} needs attended confirmation for this configuration.`)
    }
    if (nights.length < 7) reasons.push(`${nights.length} of 7 matching reviewed nights. Each requires four hours of eligible observation intervals on this Pod, build, calibration, routine and policy.`)
    if (state.application && state.application.outcome !== 'acknowledged') reasons.push('An unconfirmed command needs owner review before further adjustment.')
    const active = admission(side, state) !== null
    return ownerStatusSchema.parse({ apiVersion: 1, generatedAt: at, side, identity: current, qualifications: recorded,
      nights, reasons, active, canActivate: !active && state.config.mode === 'preview' && reasons.length === 0, application: state.application ?? null })
  }
  async function prepare(input: z.infer<typeof ownerPrepareSchema>) {
    const request = ownerPrepareSchema.parse(input)
    // Night parsing yields; no side lock is held while inspecting a month of history.
    const inspection = request.purpose === 'activation' ? await status(request.side) : null
    if (inspection) requireOwner(inspection.canActivate, inspection.reasons.join(' ') || 'Activation is not available.')
    return deps.withSideLock(request.side, async () => {
      const at = now()
      const state = store.read(request.side)
      const current = identity(request.side, state)
      requireOwner(current, 'Production Pod identity, calibrated presence, build and routine are required.')
      requireOwner(deps.running(), 'The personal comfort service is stopped.')
      const recorded = matchingQualifications(request.side, current)
      requireOwner((request.purpose === 'qualification') === (request.kind !== null), 'Select a check only for qualification reviews.')
      requireOwner(request.purpose !== 'qualification' || state.config.mode !== 'active', 'Return to Preview before changing qualification.')
      requireOwner(request.purpose !== 'resolution' || (state.application && state.application.outcome !== 'acknowledged'), 'There is no unconfirmed comfort application to resolve.')
      const evidence = request.purpose !== 'activation'
        ? readQualificationEvidence(database, request.side, current, state, deps.context(request.side, state, at), request.kind, recorded)
        : null
      const snapshot: OwnerSnapshot = { identity: current, qualifications: recorded, nights: inspection?.nights ?? [], evidence, application: state.application ?? null }
      if (inspection) {
        requireOwner(same(current, inspection.identity) && state.config.mode === 'preview' && deps.autopilotEnabled(), 'Settings changed during inspection.')
        assertReferences(request.side, snapshot, true)
      }
      const review = ownerReviewSchema.parse({ id: randomUUID(), side: request.side, at, expiresAt: at + 60_000,
        purpose: request.purpose, kind: request.kind, snapshot })
      database.transaction(() => {
        database.prepare('DELETE FROM comfort_owner_reviews WHERE expires_at < ?').run(at - 86_400_000)
        database.prepare('INSERT INTO comfort_owner_reviews (id, side, created_at, expires_at, review) VALUES (?, ?, ?, ?, ?)')
          .run(review.id, request.side, at, review.expiresAt, JSON.stringify(review))
      })()
      return review
    })
  }
  async function confirm(input: z.infer<typeof ownerConfirmSchema>) {
    const request = ownerConfirmSchema.parse(input)
    return deps.withSideLock(request.side, async () => {
      // Invalidating the current generation cannot issue a command or clear an uncertain result.
      deps.revokeLease(request.side)
      durableTransaction(database, () => {
        const at = now()
        const row = database.prepare('SELECT review, consumed_at AS consumedAt FROM comfort_owner_reviews WHERE id = ? AND side = ?')
          .get(request.id, request.side) as { review: string, consumedAt: number | null } | undefined
        requireOwner(row, 'Review not found for this side. Prepare a fresh review.')
        if (row.consumedAt !== null) return // Lost response retry cannot create another grant or clear a later command.
        const review = ownerReviewSchema.parse(JSON.parse(row.review))
        requireOwner(at >= review.at && at < review.expiresAt, 'Review expired or the clock changed. Refresh its evidence.')
        const state = store.read(request.side)
        requireOwner(same(identity(request.side, state), review.snapshot.identity) && deps.running(), 'Controller identity, settings or runtime changed during review.')
        if (review.purpose === 'activation') {
          requireOwner(state.config.mode === 'preview' && deps.autopilotEnabled() && !state.config.followBedtime,
            'Activation requires Preview, global consent and an unshifted routine.')
          requireOwner(!state.application || state.application.outcome === 'acknowledged', 'Resolve the unconfirmed application first.')
          assertReferences(request.side, review.snapshot, true)
          database.prepare('UPDATE comfort_activations SET revoked_at = ?, reason = ? WHERE side = ? AND revoked_at IS NULL')
            .run(at, 'Replaced by owner review', request.side)
          database.prepare('INSERT INTO comfort_activations (id, side, created_at, snapshot) VALUES (?, ?, ?, ?)')
            .run(review.id, request.side, at, JSON.stringify({ ...review.snapshot, note: request.note }))
          store.commit(request.side, { ...state, config: { ...state.config, mode: 'active' } },
            comfortEvent(at, 'configuration', 'Owner activated bounded thermal comfort after qualification and seven reviewed Preview nights.'))
        }
        else {
          const current = readQualificationEvidence(database, request.side, review.snapshot.identity, state,
            deps.context(request.side, state, at), review.kind, matchingQualifications(request.side, review.snapshot.identity))
          requireOwner(review.snapshot.evidence && evidenceMeaning(current) === evidenceMeaning(review.snapshot.evidence),
            'The reported state or command evidence changed. Prepare a new review.')
          if (review.purpose === 'qualification') {
            requireOwner(state.config.mode !== 'active' && review.kind, 'Return to Preview before qualifying hardware.')
            const record = qualificationSchema.parse({ id: review.id, kind: review.kind, at,
              outcome: 'confirmed', note: request.note, evidence: review.snapshot.evidence })
            database.prepare('INSERT INTO comfort_qualifications (id, side, kind, record) VALUES (?, ?, ?, ?)')
              .run(record.id, request.side, record.kind, JSON.stringify(record))
          }
          else {
            requireOwner(state.application && state.application.outcome !== 'acknowledged' && same(state.application, review.snapshot.application),
              'The unconfirmed application changed. Review it again.')
            database.prepare('INSERT INTO comfort_resolutions (id, side, created_at, snapshot, note) VALUES (?, ?, ?, ?, ?)')
              .run(review.id, request.side, at, JSON.stringify(review.snapshot), request.note)
            store.commit(request.side, { ...state, application: undefined, config: { ...state.config, mode: 'preview' },
              pausedUntil: Math.max(state.pausedUntil, at + MANUAL_PAUSE_MS), lastAppliedAt: 0, lastTargetF: null, lastSegment: '' },
            comfortEvent(at, 'manual_pause', 'Owner archived an unconfirmed application. Returned to Preview with a six-hour pause; the command was not replayed or marked successful.'))
          }
          database.prepare('UPDATE comfort_activations SET revoked_at = ?, reason = ? WHERE side = ? AND revoked_at IS NULL')
            .run(at, 'Qualification or uncertainty review changed', request.side)
        }
        database.prepare('UPDATE comfort_owner_reviews SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(at, review.id)
      })
      return { saved: true as const }
    })
  }
  async function retest(side: Side, kind: QualificationKind, expectedId: string) {
    return deps.withSideLock(side, async () => {
      deps.revokeLease(side)
      durableTransaction(database, () => {
        const previous = qualifications(side).find(record => record.kind === kind)
        requireOwner(previous?.id === expectedId, 'Qualification changed. Refresh before marking a retest.')
        const record: Qualification = { ...previous, id: randomUUID(), at: now(), outcome: 'needs_retest' }
        database.prepare('INSERT INTO comfort_qualifications (id, side, kind, record) VALUES (?, ?, ?, ?)').run(record.id, side, kind, JSON.stringify(record))
        database.prepare('UPDATE comfort_activations SET revoked_at = ?, reason = ? WHERE side = ? AND revoked_at IS NULL').run(now(), 'Owner requested qualification retest', side)
        const state = store.read(side)
        if (state.config.mode === 'active') store.commit(side, { ...state, config: { ...state.config, mode: 'preview' } },
          comfortEvent(now(), 'configuration', 'Returned to Preview for an attended qualification retest.'))
      })
      return { saved: true as const }
    })
  }
  return { status, prepare, confirm, retest, admission, revoke }
}
