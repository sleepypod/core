import { randomUUID } from 'node:crypto'
import type { BedroomComfortGuidance } from '@/src/bedroom/contract'
import { currentBedroomGuidance } from '@/src/bedroom/fusion'
import { capturePreviewEvidence, type PreviewOrigin } from './report-evidence'
import { BedEntryTracker, bedtimePreview, type BedtimeStatus } from './bedtime'
import type { ComfortSignals } from './signals'
import type { Side } from '@/src/hardware/types'
import { COMFORT_ACTIVATION_REASON, comfortConfigSchema, comfortFeedbackSchema, type ComfortStatus } from './contract'
import { comfortLocalDate, decideComfort, learnComfort, MANUAL_PAUSE_MS, type ComfortConfig, type ComfortContext, type ComfortDecision, type ComfortFeedback, type ComfortState } from './policy'
import { comfortEvent, type ComfortStore } from './store'
import type { ThermalContext, ThermalLearning } from './thermal-learning'

const STORAGE_FAULT = 'Personal comfort is withheld because its current inputs, settings or observation journal are unavailable.'
interface Observation { at: number, decision: ComfortDecision, stateKey: string, signals: ComfortSignals | null, timing: BedtimeStatus, bedroom: BedroomComfortGuidance | null, thermalContext?: ThermalContext | null }
export class ComfortInputError extends Error {}

export interface ComfortRuntimeDeps {
  now(): number
  origin?: PreviewOrigin
  store: ComfortStore
  withSideLock<T>(side: Side, work: () => Promise<T>): Promise<T>
  readContext(side: Side, state: ComfortState, now: number): { context: ComfortContext, timezone: string }
  prepareSignals?(side: Side, now: number): Promise<void>
  timezone(): string
  pendingPause(side: Side): number | null
  acknowledgePause(side: Side, at: number): void
  activation?: {
    admitted(side: Side, state: ComfortState): boolean
    revoke(side: Side, reason: string): void
    revokeLease(side: Side): void
    reconcile(side: Side): Promise<void>
  }
}

/** Preview remains inert; qualified Active proposals use the shared temperature authority. */
export class ComfortRuntime {
  private readonly runId = randomUUID()
  private observations: Partial<Record<Side, Observation>> = {}
  private recorded: Partial<Record<Side, { at: number, key: string }>> = {}
  private thermalRecorded: Partial<Record<Side, number>> = {}
  private faults: Partial<Record<Side, string>> = {}
  private readonly entryTrackers = { left: new BedEntryTracker(), right: new BedEntryTracker() }
  private running = false
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<void>
  private lastPrunedAt = 0

  constructor(private readonly deps: ComfortRuntimeDeps) {}

  isRunning(): boolean {
    return this.running
  }

  status(side: Side): ComfortStatus {
    let state: ComfortState | null = null
    let history: ComfortStatus['history'] = []
    let timezone: string | null = null
    let deviceDate: string | null = null
    try {
      timezone = this.deps.timezone()
      deviceDate = comfortLocalDate(this.deps.now(), timezone)
      state = this.deps.store.read(side)
      history = this.deps.store.history(side)
    }
    catch { this.faults[side] = STORAGE_FAULT }
    const observed = this.observations[side]
    const now = this.deps.now()
    const observation = observed && observed.at <= now && now - observed.at < 10_000 ? observed : undefined
    const signals = observation?.signals
    const signalExpired = signals?.expiresAt !== null && signals?.expiresAt !== undefined && now >= signals.expiresAt
    const bedroomExpired = state?.config.roomAware && observation?.bedroom?.state === 'ready' && !currentBedroomGuidance(observation.bedroom, now)
    const fault = this.faults[side] ?? (this.deps.pendingPause(side) !== null ? STORAGE_FAULT : null)
    const active = state !== null && this.deps.activation?.admitted(side, state) === true
    let learning: ThermalLearning | null = null
    if (timezone && this.deps.store.learning) {
      try {
        learning = this.deps.store.learning(side, !fault && !signalExpired && !bedroomExpired
        && observation?.stateKey === JSON.stringify(state) && observation.decision.eligible
          ? observation.thermalContext ?? null
          : null, timezone, now)
      }
      catch { /* Research availability must never interrupt the control policy. */ }
    }
    let decision = fault || signalExpired || bedroomExpired || observation?.stateKey !== JSON.stringify(state) ? null : observation?.decision ?? null
    if (decision && state?.config.mode === 'active' && !active) {
      decision = { ...decision, eligible: false, proposedF: null, retainPreviousLease: false, reason: COMFORT_ACTIVATION_REASON }
    }
    return {
      apiVersion: 1, generatedAt: this.deps.now(), side, state, history, fault, timezone, deviceDate,
      learning,
      evaluatedAt: observed?.at ?? null,
      decision,
      runtime: this.running ? 'running' : 'stopped',
      activation: { available: false, current: active, reason: active ? 'Owner activation is current. Every adjustment still rechecks live guards.' : COMFORT_ACTIVATION_REASON },
      features: { roomAware: true, sensorAware: true, followBedtime: true, nightReports: true, modeOnly: true, ...(this.deps.activation ? { ownerActivation: true } : {}) },
      timing: fault || signalExpired || observation?.stateKey !== JSON.stringify(state) ? null : observation?.timing ?? null,
      signals: fault || signalExpired || observation?.stateKey !== JSON.stringify(state) ? null : signals ?? null,
      bedroom: fault || observation?.stateKey !== JSON.stringify(state) ? null : observation?.bedroom ?? null,
    }
  }

  async configure(side: Side, input: ComfortConfig): Promise<ComfortStatus> {
    const config = comfortConfigSchema.parse(input)
    if (config.mode === 'active') throw new Error(COMFORT_ACTIVATION_REASON)
    if (config.followBedtime && !config.sensorAware) throw new ComfortInputError('Bed-entry timing requires the Pod sensor guard.')
    await this.deps.withSideLock(side, async () => {
      const state = this.recoverPause(side)
      this.commitConfiguration(side, state, config)
    })
    return this.status(side)
  }

  /** Read settings inside the same lock as the write; a mode switch cannot restore stale limits. */
  async setMode(side: Side, mode: ComfortConfig['mode']): Promise<ComfortStatus> {
    comfortConfigSchema.shape.mode.parse(mode)
    if (mode === 'active') throw new Error(COMFORT_ACTIVATION_REASON)
    await this.deps.withSideLock(side, async () => {
      const state = this.recoverPause(side)
      this.commitConfiguration(side, state, { ...state.config, mode })
    })
    return this.status(side)
  }

  private commitConfiguration(side: Side, state: ComfortState, config: ComfortConfig): void {
    this.deps.activation?.revoke(side, 'Owner changed personal comfort configuration')
    this.deps.store.commit(side, { ...state, config },
      comfortEvent(this.deps.now(), 'configuration', `Personal comfort set to ${config.mode}.`))
    if (state.config.followBedtime !== config.followBedtime || state.config.mode !== config.mode || !config.sensorAware) this.entryTrackers[side].reset()
    this.observations[side] = undefined
    this.recorded[side] = undefined
    this.faults[side] = undefined
  }

  async feedback(side: Side, input: ComfortFeedback): Promise<ComfortStatus> {
    const feedback = comfortFeedbackSchema.parse(input)
    await this.deps.withSideLock(side, async () => {
      const now = this.deps.now()
      const today = comfortLocalDate(now, this.deps.timezone())
      const since = new Date(Date.parse(today) - 14 * 86_400_000).toISOString().slice(0, 10)
      if (feedback.date > today || feedback.date < since) throw new ComfortInputError('Check-ins must describe today or the previous fourteen local dates.')
      this.recoverPause(side)
      this.deps.store.saveFeedback(side, feedback,
        comfortEvent(now, 'feedback', `${feedback.date}: ${feedback.comfort}.`))
    })
    return this.status(side)
  }

  /** Recover a failed manual-pause write before evaluating or changing consent. */
  private recoverPause(side: Side): ComfortState {
    let state = this.deps.store.read(side)
    const pending = this.deps.pendingPause(side)
    if (pending !== null) {
      state = { ...state, pausedUntil: Math.max(state.pausedUntil, pending + MANUAL_PAUSE_MS) }
      this.deps.store.commit(side, state, comfortEvent(pending, 'manual_pause', 'Recovered the six-hour pause after a manual control.'), true)
      this.deps.acknowledgePause(side, pending)
    }
    return state
  }

  async evaluate(side: Side): Promise<void> {
    // Prepare history outside the actuator lock; current hardware is read again inside it.
    try {
      if (this.deps.store.read(side).config.sensorAware) await this.deps.prepareSignals?.(side, this.deps.now())
    }
    catch {
      this.deps.activation?.revokeLease(side)
      this.faults[side] = STORAGE_FAULT
      this.entryTrackers[side].reset()
      this.observations[side] = undefined
      return
    }
    await this.deps.withSideLock(side, async () => {
      try {
        const now = this.deps.now()
        let state = this.recoverPause(side)
        const original = JSON.stringify(state)
        const { context: rawContext, timezone } = this.deps.readContext(side, state, now)
        let context = rawContext
        const admitted = state.config.mode === 'active' && this.deps.activation?.admitted(side, state) === true
        // Only the application adapter records hardware acknowledgments.
        const learning = (state.config.mode === 'preview' || (admitted && (!state.application || state.application.outcome === 'acknowledged'))) && context.window
          ? learnComfort(state, this.deps.store.feedback(side), context.window.session, timezone, now)
          : { state, message: null }
        state = learning.state
        const guard = decideComfort({ ...state, config: { ...state.config, followBedtime: false } }, context)
        const timing = bedtimePreview(state, context, this.entryTrackers[side], guard.eligible)
        if (timing.selection) state = { ...state, bedtime: timing.selection }
        context = { ...context, window: timing.window, timing: timing.status }
        // Preserve raw-schedule safety holds, especially the unexpected-target pause.
        let decision = guard.eligible ? decideComfort(state, context) : guard
        if (state.config.mode === 'active' && !admitted) {
          decision = { ...decision, eligible: false, proposedF: null, retainPreviousLease: false,
            reason: COMFORT_ACTIVATION_REASON }
        }
        if (decision.pauseRequired) state = { ...state, pausedUntil: Math.max(state.pausedUntil, now + MANUAL_PAUSE_MS) }
        const preview = capturePreviewEvidence(state, rawContext, decision.baselineF, timezone, this.runId,
          this.deps.origin ?? { environment: 'unknown', buildRevision: null })
        const key = JSON.stringify([preview, decision, context.window?.segment, context.owner, context.device.targetF,
          context.signals?.state, context.signals?.baselineDays, context.signals?.sampleAt, timing.status])
        const previous = this.recorded[side]
        const lastThermal = this.thermalRecorded[side]
        const recordThermal = decision.eligible && context.thermalContext
          && (lastThermal === undefined || now < lastThermal || now - lastThermal >= 300_000)
        const record = state.config.mode !== 'off' && (!previous || previous.key !== key || now - previous.at >= 60_000 || now < previous.at)
        const event = record
          ? {
              ...comfortEvent(now, state.config.mode === 'active' ? 'active' : 'preview', learning.message ? `${decision.reason} ${learning.message}` : decision.reason),
              session: context.window?.session ?? null, proposedF: decision.proposedF, reportedF: context.device.targetF,
              eligible: decision.eligible, deviceObservedAt: context.device.observedAt,
              presenceObservedAt: context.presence.observedAt, owner: context.owner, signals: context.signals ?? null, timing: timing.status, bedroom: context.bedroom ?? null, preview,
              thermalContext: recordThermal ? context.thermalContext : null,
            }
          : undefined
        if (event || JSON.stringify(state) !== original) this.deps.store.commit(side, state, event, decision.pauseRequired)
        if (event?.thermalContext) this.thermalRecorded[side] = now
        if (record) this.recorded[side] = { at: now, key }
        this.observations[side] = { at: now, decision, stateKey: JSON.stringify(state), signals: context.signals ?? null, timing: timing.status, bedroom: context.bedroom ?? null, thermalContext: context.thermalContext ?? null }
        this.faults[side] = undefined
      }
      catch {
        this.deps.activation?.revokeLease(side)
        this.faults[side] = STORAGE_FAULT
        this.entryTrackers[side].reset()
        this.observations[side] = undefined
      }
    })
    if (!this.faults[side]) {
      try {
        await this.deps.activation?.reconcile(side)
      }
      catch {
        this.deps.activation?.revokeLease(side)
        this.faults[side] = STORAGE_FAULT
      }
    }
  }

  private tick(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = (async () => {
      for (const side of ['left', 'right'] as const) {
        if (!this.running) break
        await this.evaluate(side)
      }
      const now = this.deps.now()
      if (this.running && (!this.lastPrunedAt || now - this.lastPrunedAt >= 3_600_000)) {
        try {
          this.deps.store.prune(now)
          this.lastPrunedAt = now
        }
        catch { /* Retain observations; a later tick retries pruning. */ }
      }
    })().finally(() => { this.pending = undefined })
    return this.pending
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      void this.tick()
    }, 5_000)
    this.timer.unref()
    await this.tick()
  }

  async stop(): Promise<void> {
    this.running = false
    this.deps.activation?.revokeLease('left')
    this.deps.activation?.revokeLease('right')
    clearInterval(this.timer)
    await this.pending
    this.entryTrackers.left.reset()
    this.entryTrackers.right.reset()
    this.observations = {}
  }
}
