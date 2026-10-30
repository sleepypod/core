import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Side } from '@/src/hardware/types'
import { withSideLock } from '@/src/hardware/sideLock'
import { ComfortRuntime, type ComfortRuntimeDeps } from '../runtime'
import { createComfortStore } from '../store'
import { defaultComfortState, MANUAL_PAUSE_MS, type ComfortContext } from '../policy'
import { missingComfortSignals } from '../signals'
import { migratedComfortDatabase } from './databaseFixture'

const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => {
  databases.splice(0).forEach(database => database.close())
  vi.useRealTimers()
})

function harness() {
  const database = migratedComfortDatabase()
  databases.push(database)
  const now = Date.parse('2026-10-25T10:00:00Z')
  const store = createComfortStore(database)
  const input: ComfortContext = {
    now, window: { session: 'night-1', segment: 'night-1:bedtime', start: now - 3_600_000, end: now + 3_600_000, baselineF: 75, alarmAt: null },
    device: { observedAt: now, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false, targetF: 75 },
    presence: { observedAt: now, available: true, occupied: true },
    eitherAway: false, routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true,
  }
  const pending: Partial<Record<Side, number>> = {}
  const deps: ComfortRuntimeDeps = {
    now: () => input.now, store, withSideLock,
    readContext: () => ({ context: input, timezone: 'America/Los_Angeles' }),
    timezone: () => 'America/Los_Angeles',
    pendingPause: side => pending[side] ?? null,
    acknowledgePause: (side) => { pending[side] = undefined },
  }
  store.commit('left', { ...defaultComfortState(), offsetF: -2, config: { mode: 'preview', minimumF: 70, maximumF: 95 } })
  return { database, input, deps, store, pending, runtime: new ComfortRuntime(deps) }
}

describe('production personal comfort Preview', () => {
  it('samples research context at most every five minutes without changing the control proposal', async () => {
    const { input, store, runtime } = harness()
    input.thermalContext = { targetF: 75, waterF: 75, roomF: 74, humidity: 50 }
    await runtime.evaluate('left')
    const firstDecision = runtime.status('left').decision?.proposedF
    for (const elapsed of [60000, 120000, 300000]) {
      input.now += elapsed
      input.device.observedAt = input.now
      input.presence.observedAt = input.now
      await runtime.evaluate('left')
    }
    expect(store.history('left').filter(event => event.thermalContext)).toHaveLength(2)
    expect(runtime.status('left').decision?.proposedF).toBe(firstDecision)
  })

  it('switches only mode after concurrent settings writes and preserves learning and manual pause', async () => {
    const { runtime, store, pending, input } = harness()
    pending.left = input.now
    const config = { mode: 'off' as const, minimumF: 72, maximumF: 91, sensorAware: true, followBedtime: true }
    await Promise.all([runtime.configure('left', config), runtime.setMode('left', 'preview')])
    expect(store.read('left')).toMatchObject({ config: { ...config, mode: 'preview' }, offsetF: -2,
      pausedUntil: input.now + MANUAL_PAUSE_MS, lastAppliedAt: 0, lastTargetF: null })
    expect(store.read('right')).toEqual(defaultComfortState())
    expect(runtime.status('left').features.modeOnly).toBe(true)
    const before = store.read('left')
    await expect(runtime.setMode('left', 'active')).rejects.toThrow('Hardware qualification')
    expect(store.read('left')).toEqual(before)
    store.commit = () => {
      throw new Error('Synthetic storage failure')
    }
    await expect(runtime.setMode('left', 'off')).rejects.toThrow('Synthetic storage failure')
    expect(store.read('left')).toEqual(before)
  })
  it('captures report provenance only for bounded Preview observations and changes the runtime identity after restart', async () => {
    const { deps, input, store } = harness()
    if (!input.window) throw new Error('Fixture requires a routine')
    input.window.phases = { revision: 'b'.repeat(64), startF: 75, changes: [] }
    input.presence.entry = { measuredAt: input.now, sourceKey: 'c'.repeat(64), state: 'present' }
    deps.origin = { environment: 'production', buildRevision: 'a'.repeat(40) }
    const runtime = new ComfortRuntime(deps)
    await runtime.evaluate('left')
    const first = store.history('left')[0].preview
    expect(first).toMatchObject({ environment: 'production', buildRevision: 'a'.repeat(40), presence: 'occupied',
      presenceSourceKey: 'c'.repeat(64), mechanicallyQuiet: true, deviceFresh: true, scheduledBaselineF: 75 })
    const restarted = new ComfortRuntime(deps)
    await restarted.evaluate('left')
    expect(store.history('left')[0].preview?.runId).not.toBe(first?.runId)
    await restarted.configure('left', { ...store.read('left').config, mode: 'off' })
    const length = store.history('left').length
    await restarted.evaluate('left')
    expect(store.history('left')).toHaveLength(length)
    await restarted.configure('left', { ...store.read('left').config, mode: 'preview' })
    input.window = null
    await restarted.evaluate('left')
    expect(store.history('left')[0].preview).toBeUndefined()
    expect(store.read('left')).toMatchObject({ lastAppliedAt: 0, lastTargetF: null })
  })

  it('persists a qualified phase choice, reuses it after restart, and withdraws on schedule edits or pauses', async () => {
    const { deps, input, store, runtime } = harness()
    const routine = input.window
    if (!routine) throw new Error('Fixture requires a routine')
    routine.start = input.now - 5 * 60000
    routine.phases = { revision: 'b'.repeat(64), startF: 75,
      changes: [{ id: 'cool', at: routine.start + 30 * 60000, temperatureF: 70 }] }
    const entryAt = input.now
    const refresh = (now: number, occupied = true) => {
      input.now = now
      input.device.observedAt = now
      input.presence = { observedAt: now, available: true, occupied,
        entry: { measuredAt: now, sourceKey: 'a'.repeat(64), state: occupied ? 'present' : 'absent' } }
      input.signals = { ...missingComfortSignals(), state: 'ready', sampleAt: now, expiresAt: now + 60000 }
    }
    await runtime.configure('left', { ...store.read('left').config, sensorAware: true, followBedtime: true })
    refresh(entryAt - 60000, false)
    await runtime.evaluate('left')
    for (let minute = 0; minute < 10; minute++) {
      refresh(entryAt + minute * 60000)
      await runtime.evaluate('left')
      expect(store.read('left').bedtime).toBeUndefined()
    }
    refresh(entryAt + 10 * 60000)
    await runtime.evaluate('left')
    const selection = store.read('left').bedtime
    expect(selection).toMatchObject({ entryAt, shiftMinutes: 5, session: routine.session })
    expect(store.history('left')[0].timing).toMatchObject({ state: 'ready', selection })
    expect(store.read('left')).toMatchObject({ lastAppliedAt: 0, lastTargetF: null })
    const restarted = new ComfortRuntime(deps)
    refresh(entryAt + 11 * 60000)
    await restarted.evaluate('left')
    expect(restarted.status('left')).toMatchObject({ decision: { eligible: true }, timing: { selection } })
    expect(restarted.status('right').state?.bedtime).toBeUndefined()
    store.commit('left', { ...store.read('left'), pausedUntil: input.now + MANUAL_PAUSE_MS })
    await restarted.evaluate('left')
    expect(restarted.status('left').decision).toMatchObject({ eligible: false, reason: expect.stringContaining('six hours') })
    store.commit('left', { ...store.read('left'), pausedUntil: 0 })
    routine.phases.revision = 'c'.repeat(64)
    await restarted.evaluate('left')
    expect(restarted.status('left')).toMatchObject({ decision: { eligible: false }, timing: { state: 'withheld' } })
    expect(store.read('left').bedtime).toEqual(selection)
    // A shifted phase outside the user range must not mask an unknown-target pause.
    routine.phases.revision = 'b'.repeat(64)
    routine.phases.startF = 60
    input.targetKnown = false
    await restarted.evaluate('left')
    expect(store.read('left').pausedUntil).toBe(input.now + MANUAL_PAUSE_MS)
  })

  it('does not publish a selected phase when its atomic journal write fails', async () => {
    const { database, input, store, runtime } = harness()
    const entryAt = input.now
    if (!input.window) throw new Error('Fixture requires a routine')
    input.window.start = entryAt
    input.window.phases = { revision: 'b'.repeat(64), startF: 75, changes: [{ id: 'cool', at: entryAt + 30 * 60000, temperatureF: 70 }] }
    await runtime.configure('left', { ...store.read('left').config, sensorAware: true, followBedtime: true })
    for (let minute = -1; minute <= 10; minute++) {
      input.now = entryAt + minute * 60000
      input.device.observedAt = input.now
      input.presence = { observedAt: input.now, available: true, occupied: minute >= 0,
        entry: { measuredAt: input.now, sourceKey: 'a'.repeat(64), state: minute < 0 ? 'absent' : 'present' } }
      input.signals = { ...missingComfortSignals(), state: 'ready', sampleAt: input.now, expiresAt: input.now + 60000 }
      if (minute === 10) database.exec('CREATE TRIGGER reject_timing BEFORE INSERT ON comfort_events BEGIN SELECT RAISE(ABORT, \'test\'); END')
      await runtime.evaluate('left')
    }
    expect(runtime.status('left')).toMatchObject({ decision: null, timing: null, fault: expect.any(String) })
    expect(store.read('left').bedtime).toBeUndefined()
    database.exec('DROP TRIGGER reject_timing')
    input.now += 5000
    input.device.observedAt = input.now
    input.presence.observedAt = input.now
    if (!input.presence.entry) throw new Error('Fixture requires an entry sample')
    input.presence.entry.measuredAt = input.now
    await runtime.evaluate('left')
    expect(runtime.status('left').timing?.state).toBe('waiting')
    expect(store.read('left').bedtime).toBeUndefined()
  })

  it('persists sensor Preview consent and evidence, expires status, and never acknowledges hardware', async () => {
    const { runtime, store, input } = harness()
    await runtime.configure('left', { ...store.read('left').config, sensorAware: true })
    input.signals = { ...missingComfortSignals(), state: 'ready', reason: 'Qualified comparison',
      sampleAt: input.now - 60000, expiresAt: input.now + 2000, baselineHeartRate: 60, baselineDays: 7, baselineWindows: 84 }
    await runtime.evaluate('left')
    expect(runtime.status('left')).toMatchObject({ features: { sensorAware: true }, decision: { eligible: true }, signals: { baselineDays: 7 } })
    expect(store.history('left')[0].signals?.baselineHeartRate).toBe(60)
    expect(store.read('left')).toMatchObject({ lastAppliedAt: 0, lastTargetF: null })
    input.now += 2000
    expect(runtime.status('left')).toMatchObject({ decision: null, signals: null })
    await runtime.evaluate('left')
    expect(runtime.status('left').decision).toBeNull()
  })

  it('prepares history outside the side lock and rechecks manual control after preparation', async () => {
    const { deps, store, input } = harness()
    store.commit('left', { ...store.read('left'), config: { ...store.read('left').config, sensorAware: true } })
    let locked = false
    deps.withSideLock = async (_side, work) => {
      locked = true
      try {
        return await work()
      }
      finally { locked = false }
    }
    deps.prepareSignals = async () => {
      expect(locked).toBe(false)
      store.commit('left', { ...store.read('left'), pausedUntil: input.now + MANUAL_PAUSE_MS })
    }
    const runtime = new ComfortRuntime(deps)
    await runtime.evaluate('left')
    expect(runtime.status('left').decision).toMatchObject({ eligible: false, reason: expect.stringContaining('six hours') })
    input.now += 10000
    expect(runtime.status('left')).toMatchObject({ evaluatedAt: input.now - 10000, decision: null })
  })

  it('does not present an old eligible decision after a manual pause changes persisted state', async () => {
    const { runtime, store, input } = harness()
    await runtime.evaluate('left')
    expect(runtime.status('left').decision?.eligible).toBe(true)
    store.commit('left', { ...store.read('left'), pausedUntil: input.now + MANUAL_PAUSE_MS })
    expect(runtime.status('left')).toMatchObject({ decision: null, state: { pausedUntil: input.now + MANUAL_PAUSE_MS } })
  })
  it('records a bounded proposal with measurement times without claiming an applied target', async () => {
    const { runtime, store, input } = harness()
    await runtime.evaluate('left')
    expect(runtime.status('left')).toMatchObject({
      evaluatedAt: input.now, decision: { eligible: true, proposedF: 74 },
      activation: { available: false }, state: { lastAppliedAt: 0, lastTargetF: null },
    })
    expect(store.history('left')[0]).toMatchObject({ kind: 'preview', proposedF: 74, reportedF: 75, owner: 'schedule', deviceObservedAt: input.now })
  })

  it('rejects active and unsupported adapter settings, retaining existing consent', async () => {
    const { runtime, store } = harness()
    const config = store.read('left').config
    await expect(runtime.configure('left', { ...config, mode: 'active' })).rejects.toThrow('qualification')
    await expect(runtime.configure('left', { ...config, followBedtime: true })).rejects.toThrow('sensor guard')
    expect(store.read('left').config).toEqual(config)
  })

  it('keeps migrated active settings inert and reports the missing qualification', async () => {
    const { runtime, store } = harness()
    const state = store.read('left')
    store.commit('left', { ...state, config: { ...state.config, mode: 'active' } })
    await runtime.evaluate('left')
    expect(runtime.status('left').decision).toMatchObject({ eligible: false, proposedF: null, reason: expect.stringContaining('qualification') })
  })

  it('persists an unexpected-target pause across a new runtime and configuration changes', async () => {
    const { runtime, deps, input, store } = harness()
    input.targetKnown = false
    await runtime.evaluate('left')
    expect(store.read('left').pausedUntil).toBe(input.now + MANUAL_PAUSE_MS)
    input.targetKnown = true
    const restarted = new ComfortRuntime(deps)
    await restarted.configure('left', { mode: 'preview', minimumF: 70, maximumF: 95 })
    await restarted.evaluate('left')
    expect(restarted.status('left').decision).toMatchObject({ eligible: false, reason: expect.stringContaining('six hours') })
  })

  it('recovers a failed manual journal before evaluating another proposal', async () => {
    const { runtime, pending, input, store } = harness()
    pending.left = input.now - 60_000
    await runtime.evaluate('left')
    expect(pending.left).toBeUndefined()
    expect(store.read('left').pausedUntil).toBe(input.now - 60_000 + MANUAL_PAUSE_MS)
    expect(runtime.status('left').decision?.eligible).toBe(false)
  })

  it('withholds when journal writes fail, without acknowledging a proposal or consuming check-ins', async () => {
    const { runtime, database, store } = harness()
    database.exec('CREATE TRIGGER reject_comfort BEFORE INSERT ON comfort_events BEGIN SELECT RAISE(ABORT, \'test\'); END')
    await runtime.evaluate('left')
    expect(runtime.status('left')).toMatchObject({ decision: null, fault: expect.stringContaining('journal') })
    expect(store.read('left').learnedSession).toBe('')
    database.exec('DROP TRIGGER reject_comfort')
    await runtime.evaluate('left')
    expect(runtime.status('left')).toMatchObject({ fault: null, decision: { eligible: true } })
  })

  it('uses three unique check-ins once and preserves learning cursors across restart', async () => {
    const { runtime, store, deps } = harness()
    for (const date of ['2026-10-23', '2026-10-24', '2026-10-25']) await runtime.feedback('left', { date, comfort: 'warm' })
    await runtime.evaluate('left')
    expect(store.read('left')).toMatchObject({ offsetF: -3, feedbackThrough: '2026-10-25', learnedSession: 'night-1' })
    await new ComfortRuntime(deps).evaluate('left')
    expect(store.read('left').offsetF).toBe(-3)
  })

  it('validates feedback dates in the device timezone and leaves consumed edits consumed', async () => {
    const { runtime, input, store } = harness()
    input.now = Date.parse('2026-10-25T01:00:00Z') // Still October 24 in Los Angeles.
    await expect(runtime.feedback('left', { date: '2026-10-25', comfort: 'cold' })).rejects.toThrow('local dates')
    await expect(runtime.feedback('left', { date: '2026-10-01', comfort: 'warm' })).rejects.toThrow('local dates')
    const state = store.read('left')
    store.commit('left', { ...state, feedbackThrough: '2026-10-24' })
    await runtime.feedback('left', { date: '2026-10-24', comfort: 'cold' })
    expect(store.read('left').feedbackThrough).toBe('2026-10-24')
  })

  it('records changed guards immediately and limits unchanged observations to once a minute', async () => {
    const { runtime, input, store } = harness()
    await runtime.evaluate('left')
    await runtime.evaluate('left')
    expect(store.history('left')).toHaveLength(1)
    input.device.priming = true
    await runtime.evaluate('left')
    expect(store.history('left')).toHaveLength(2)
    input.now += 60_000
    input.device.observedAt = input.now
    input.presence.observedAt = input.now
    await runtime.evaluate('left')
    expect(store.history('left')).toHaveLength(3)
  })

  it('runs without overlapping ticks and drains queued work before shutdown', async () => {
    vi.useFakeTimers()
    const { runtime, store } = harness()
    await runtime.start()
    await vi.advanceTimersByTimeAsync(15_000)
    await runtime.stop()
    const before = store.history('left')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.status('left').runtime).toBe('stopped')
    expect(store.history('left')).toEqual(before)
  })
})
