import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import type { TemperatureController } from '@/src/temperature/controller'
import { createComfortStore } from '../store'
import type { createComfortOwner } from '../owner'
import { experimentDigest, readExperimentAvailability } from './access'
import { ExperimentAdmissions } from './admissions'
import type { ExperimentExecutionReview, ExperimentGrant, ExperimentZoneProof } from './admission-contract'
import { ExperimentApplicationAdapter, type ExperimentExecutionSnapshot } from './application'
import { ExperimentApplicationStore } from './applications'
import type { ExperimentExecutionAccess } from './execution-access'
import type { ExperimentPrincipal } from './execution-principal'
import type { ExperimentSample } from './exposure'
import { experimentContextMatches } from './plan'
import { ComfortExperimentStore } from './store'

export interface ExperimentExecutionDeps {
  database: Database.Database
  now(): number
  monotonicNow(): number
  enabled(): boolean
  pendingManualPause(side: Side): number | null
  subject(principal: ExperimentPrincipal): string
  resolve(principal: ExperimentPrincipal): ExperimentExecutionAccess
  owner: Pick<ReturnType<typeof createComfortOwner>, 'experimentEvidence' | 'assertExperimentEvidence' | 'suspendForExperiment'>
  withSideLock<Result>(side: Side, work: () => Promise<Result>): Promise<Result>
  authority: Pick<TemperatureController, 'replacePolicy'>
  /** Reads existing physical-zone observations only; never consult authority.status() recursively. */
  sample(side: Side, at: number, context: NonNullable<ReturnType<typeof readExperimentAvailability>['context']>): ExperimentSample
}

/** Own reviewed experiment leases within the existing automatic-service lifecycle. */
export class ExperimentExecutionHost {
  readonly admissions: ExperimentAdmissions
  private readonly applications: ExperimentApplicationStore
  private readonly adapter: ExperimentApplicationAdapter
  private running = false
  private generation = 0
  private pending?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private readonly failed = new Set<string>()
  private readonly audited = new Map<string, number>()

  constructor(private readonly deps: ExperimentExecutionDeps) {
    this.applications = new ExperimentApplicationStore(deps.database, deps.now)
    this.admissions = new ExperimentAdmissions({ database: deps.database, now: deps.now,
      validate: (review, sources) => this.validate(review, sources),
      suspend: zone => deps.owner.suspendForExperiment(zone.side, zone.evidence),
      revokeLease: side => this.adapter.revoke(side) })
    this.adapter = new ExperimentApplicationAdapter({ now: deps.now, monotonicNow: deps.monotonicNow,
      withSideLock: deps.withSideLock, authority: deps.authority,
      read: (side, at) => this.snapshot(side, at),
      reserve: (reservation, current) => this.applications.reserve(reservation, current),
      finish: (reservation, receipt) => this.applications.finish(reservation, receipt) })
  }

  isRunning() { return this.running }

  private interruptionHash(side: Side): string {
    const state = createComfortStore(this.deps.database).read(side)
    const manual = this.deps.database.prepare(`SELECT id FROM comfort_events WHERE side = ?
      AND json_extract(event, '$.kind') = 'manual_pause' ORDER BY id DESC LIMIT 1`).get(side)
    return experimentDigest({ pausedUntil: state.pausedUntil, pending: this.deps.pendingManualPause(side), manual: manual ?? null })
  }

  private validate(review: ExperimentExecutionReview, includeSource: boolean) {
    if (!this.running || !this.deps.enabled() || this.failed.has(review.id)) throw new Error('Experiment execution is unavailable')
    const { access, zones } = this.deps.resolve(review.principal)
    if (access.subjectKey !== review.subjectKey || experimentDigest(access.scope) !== review.scopeHash
      || JSON.stringify([...zones].sort()) !== JSON.stringify(review.zones.map(zone => zone.side).sort()))
      throw new Error('The reviewed account, device or physical assignment changed')
    const record = new ComfortExperimentStore(this.deps.database, access.subjectKey, this.deps.now).read(review.planId)
    const current = readExperimentAvailability(this.deps.database, access)
    if (!record || record.status !== 'planned' || !current.context || !experimentContextMatches(record.plan, current.context))
      throw new Error('The experiment stopped, or the reviewed routine, wake plan or overnight range changed')
    for (const zone of review.zones) {
      if (zone.interruptionHash !== this.interruptionHash(zone.side) || this.deps.pendingManualPause(zone.side) !== null)
        throw new Error('Manual control interrupted this experiment')
      this.deps.owner.assertExperimentEvidence(zone.side, zone.evidence, includeSource)
    }
    return current.context
  }

  private withZones<Result>(zones: Side[], work: () => Promise<Result>): Promise<Result> {
    const ordered = [...new Set(zones)].sort()
    if (!ordered.length) throw new Error('No physical experiment zone is authorized')
    return ordered.length === 2
      ? this.deps.withSideLock('left', () => this.deps.withSideLock('right', work))
      : this.deps.withSideLock(ordered[0], work)
  }

  /** Qualification parsing may yield; authorization and all proofs are rechecked under the final locks. */
  async prepare(principal: ExperimentPrincipal, planId: string, assertCurrent: () => void): Promise<ExperimentExecutionReview> {
    assertCurrent()
    const initial = this.deps.resolve(principal), scope = experimentDigest(initial.access.scope)
    const proofs: ExperimentZoneProof[] = []
    for (const side of initial.zones) proofs.push({ side, evidence: await this.deps.owner.experimentEvidence(side),
      interruptionHash: this.interruptionHash(side) })
    return this.withZones(initial.zones, async () => this.admissions.prepare(initial.access.subjectKey, scope,
      planId, proofs, assertCurrent, principal))
  }

  async confirm(principal: ExperimentPrincipal, id: string, planHash: string, assertCurrent: () => void): Promise<ExperimentGrant> {
    assertCurrent()
    const { access } = this.deps.resolve(principal), scope = experimentDigest(access.scope)
    const review = this.admissions.review(access.subjectKey, scope, id)
    if (JSON.stringify(review.principal) !== JSON.stringify(principal)) throw new Error('Use the device that prepared this execution review')
    return this.withZones(review.zones.map(zone => zone.side), async () => this.admissions.confirm(access.subjectKey,
      scope, id, planHash, () => {
        assertCurrent()
        const current = this.deps.resolve(principal)
        if (current.access.subjectKey !== access.subjectKey || experimentDigest(current.access.scope) !== scope)
          throw new Error('The account changed while confirming execution')
      }))
  }

  /** A valid personal device may cancel its own grant even when the original reviewing device was revoked. */
  async cancel(principal: ExperimentPrincipal, id: string, assertCurrent: () => void): Promise<void> {
    assertCurrent()
    const subject = this.deps.subject(principal), grant = this.admissions.read(subject, id)
    await this.withZones(grant.review.zones.map(zone => zone.side), async () => this.admissions.revoke(subject, id,
      'Cancelled by the sleeper', () => {
        assertCurrent()
        if (this.deps.subject(principal) !== subject) throw new Error('The account changed while cancelling execution')
      }))
  }

  private snapshot(side: Side, at: number): ExperimentExecutionSnapshot | null {
    const current = this.admissions.current(side)
    const auditedAt = current ? this.audited.get(current.grant.review.id) : undefined
    if (!current || auditedAt === undefined || at < auditedAt || at - auditedAt >= 60_000) return null
    const review = current.grant.review, context = this.validate(review, false)
    const record = new ComfortExperimentStore(this.deps.database, review.subjectKey, this.deps.now).read(review.planId)
    if (!record) return null
    const state = createComfortStore(this.deps.database).read(side)
    return { record, context, admission: current.admission, sample: this.deps.sample(side, at, context),
      enabled: this.running && this.deps.enabled(), adaptationSuspended: state.config.mode === 'preview',
      manualPausedUntil: state.pausedUntil, application: this.applications.latest(side) }
  }

  private async inspect(side: Side) {
    let grant: ExperimentGrant | null = null
    try {
      grant = this.admissions.claim(side)
      if (!grant || grant.revokedAt !== null) return
      const auditedAt = this.audited.get(grant.review.id), now = this.deps.now()
      const auditSource = auditedAt === undefined || now < auditedAt || now - auditedAt >= 60_000
      this.validate(grant.review, auditSource)
      const state = createComfortStore(this.deps.database).read(side), application = this.applications.latest(side)
      if (grant.endsAt <= this.deps.now() || state.config.mode !== 'preview'
        || (application && ['unknown', 'attempting'].includes(application.outcome))
        || this.adapter.failedRevision(side) === grant.review.id)
        throw new Error('The experiment ended, ordinary adaptation resumed, or an earlier application is uncertain')
      if (auditSource) this.audited.set(grant.review.id, this.deps.now())
    }
    catch {
      this.adapter.revoke(side)
      if (!grant) return
      this.failed.add(grant.review.id)
      try {
        this.admissions.revoke(grant.review.subjectKey, grant.review.id, 'Execution conditions changed; review before a new admission', () => {})
      }
      catch { /* Failed persistence cannot re-admit the in-memory grant; source guards still withhold after restart. */ }
    }
  }

  tick(): Promise<void> {
    if (this.pending) return this.pending
    if (!this.running) return Promise.resolve()
    const generation = this.generation
    this.pending = (async () => {
      for (const side of ['left', 'right'] as const) {
        if (!this.running || generation !== this.generation) break
        await this.deps.withSideLock(side, () => this.inspect(side))
        if (!this.running || generation !== this.generation) break
        try {
          await this.adapter.reconcile(side)
        }
        catch { this.adapter.revoke(side) }
        // Resolve a failed first-zone attempt before another zone can use the shared grant.
        if (this.running && generation === this.generation)
          await this.deps.withSideLock(side, () => this.inspect(side))
      }
    })().finally(() => { this.pending = undefined })
    return this.pending
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.generation++
    this.audited.clear()
    this.timer = setInterval(() => {
      void this.tick().catch(() => {})
    }, 5_000)
    this.timer.unref()
    try {
      await this.tick()
    }
    catch (error) {
      await this.stop()
      throw error
    }
  }

  /** Drain queued work; stopping a service never writes a previously saved target. */
  async stop(): Promise<void> {
    this.running = false
    this.generation++
    clearInterval(this.timer)
    this.adapter.revoke('left')
    this.adapter.revoke('right')
    await this.pending
    this.audited.clear()
  }
}
