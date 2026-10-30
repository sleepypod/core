import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { MECHANICAL_CONTEXT_VERSION, MECHANICAL_FRESH_MS, MECHANICAL_MAX_SPANS, MECHANICAL_RETENTION_MS, MECHANICAL_SETTLE_MS, mechanicalKindSchema, mechanicalObservation, mechanicalStateSchema } from './context'
import type { MechanicalKind, MechanicalObservation, MechanicalReason, MechanicalState } from './context'

/** One controller owns this journal; Python readers never mutate it. No hardware access. */
export class MechanicalStore {
  private epoch = randomUUID()
  private uncertainUntil = 0
  constructor(private readonly database: Database.Database) {}

  /** A busy biometric DB must not hold emergency cancellation for seconds. */
  private write<T>(action: () => T): T {
    const timeout = this.database.pragma('busy_timeout', { simple: true })
    if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout)) throw new Error('Invalid database timeout')
    this.database.pragma('busy_timeout = 25')
    try {
      return this.database.transaction(action).immediate()
    }
    finally {
      this.database.pragma(`busy_timeout = ${timeout}`)
    }
  }

  /** A failed journal write cannot join the next observation to old evidence. */
  invalidate(now: number, durationMs = 180_000) {
    this.epoch = randomUUID()
    this.uncertainUntil = Math.max(this.uncertainUntil, now + durationMs + MECHANICAL_SETTLE_MS)
  }

  read(): MechanicalState | null {
    const row = this.database.prepare('SELECT payload FROM biometric_mechanical_state WHERE id=1').get() as { payload: string } | undefined
    if (!row) return null
    if (Buffer.byteLength(row.payload) > 8192) throw new Error('Mechanical context exceeds its bound')
    return mechanicalStateSchema.parse(JSON.parse(row.payload))
  }

  private save(value: MechanicalState) {
    const state = mechanicalStateSchema.parse(value)
    this.database.prepare('INSERT INTO biometric_mechanical_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(state))
    return state
  }

  private initial(now: number, reason: MechanicalReason): MechanicalState {
    return { version: MECHANICAL_CONTEXT_VERSION, epoch: this.epoch, publishedAtMs: now, confirmedThroughMs: null,
      validUntilMs: now, blockedUntilMs: now + MECHANICAL_SETTLE_MS, cleanSinceMs: null, spanId: null,
      reasons: [reason], commandAtMs: null, commandUntilMs: 0 }
  }

  observe(input: MechanicalObservation) {
    const observation = mechanicalObservation(input)
    return this.write(() => {
      const prior = this.read()
      const restarted = prior?.epoch !== this.epoch
      const gap = prior !== null && observation.now - prior.publishedAtMs >= MECHANICAL_FRESH_MS
      const regressed = prior !== null && (observation.now < prior.publishedAtMs
        || (observation.observedAt !== null && prior.confirmedThroughMs !== null && observation.observedAt < prior.confirmedThroughMs))
      // Wall/source clock reversals make earlier time-based coverage ambiguous.
      if (regressed) this.database.prepare('DELETE FROM biometric_mechanical_spans').run()
      const state = !prior || restarted || gap || regressed
        ? this.initial(observation.now, regressed ? 'clock_regression' : gap ? 'observation_gap' : 'controller_restart')
        : { ...prior }
      // Pending command windows survive process restarts and unknown outcomes.
      state.commandUntilMs = Math.max(state.commandUntilMs, prior?.commandUntilMs ?? 0)
      state.commandAtMs = prior?.commandAtMs ?? null
      state.blockedUntilMs = Math.max(state.blockedUntilMs, state.commandUntilMs, this.uncertainUntil)
      if (observation.reasons.length) state.blockedUntilMs = Math.max(state.blockedUntilMs, observation.now + MECHANICAL_SETTLE_MS)
      const commandObserved = state.commandAtMs === null || (observation.observedAt !== null && observation.observedAt > state.commandAtMs)
      const quiet = observation.observedAt !== null && observation.observedAt >= state.blockedUntilMs && commandObserved
      state.reasons = observation.reasons.length ? observation.reasons : quiet ? [] : ['settling']
      state.publishedAtMs = observation.now
      state.confirmedThroughMs = observation.observedAt
      state.validUntilMs = observation.observedAt === null ? observation.now : observation.observedAt + MECHANICAL_FRESH_MS
      if (quiet && observation.observedAt !== null) {
        state.cleanSinceMs ??= Math.max(state.blockedUntilMs, observation.observedAt)
        state.spanId ??= randomUUID()
        this.database.prepare('INSERT INTO biometric_mechanical_spans(id,epoch,start_ms,end_ms) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET end_ms=MAX(end_ms,excluded.end_ms)')
          .run(state.spanId, this.epoch, state.cleanSinceMs, observation.observedAt)
      }
      else {
        state.cleanSinceMs = null
        state.spanId = null
      }
      this.database.prepare('DELETE FROM biometric_mechanical_spans WHERE end_ms < ?').run(observation.now - MECHANICAL_RETENTION_MS)
      this.database.prepare('DELETE FROM biometric_mechanical_spans WHERE id IN (SELECT id FROM biometric_mechanical_spans ORDER BY end_ms DESC, id DESC LIMIT -1 OFFSET ?)').run(MECHANICAL_MAX_SPANS)
      return this.save(state)
    })
  }

  /** Persist before dispatch. Clear/Stop never shorten a possible vibration window. */
  command(kind: MechanicalKind, now: number, durationMs = 0) {
    mechanicalKindSchema.parse(kind)
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 180000) throw new Error('Invalid mechanical command interval')
    return this.write(() => {
      const previous = this.read()
      const state = this.initial(now, kind === 'vibration' ? 'vibration_command' : kind === 'base' ? 'base_motion' : 'priming')
      state.commandAtMs = now
      state.commandUntilMs = Math.max(previous?.commandUntilMs ?? 0, now + durationMs + MECHANICAL_SETTLE_MS)
      state.blockedUntilMs = state.commandUntilMs
      return this.save(state)
    })
  }

  stop(now: number) {
    return this.write(() => this.save({ ...this.initial(now, 'controller_stopped'),
      commandUntilMs: this.read()?.commandUntilMs ?? 0 }))
  }
}
