import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beforeControlWrite } from '@/src/controls/context'
import { withSideLock } from '@/src/hardware/sideLock'
import { TemperatureController, type TemperatureRequest } from '@/src/temperature/controller'
import { createTemperatureApplicationRecorder, readTemperatureApplications } from '@/src/temperature/applications'
import { ComfortApplicationAdapter, type ComfortAdmission } from '../application'
import { createComfortStore } from '../store'
import { ADJUSTMENT_INTERVAL_MS, defaultComfortState, type ComfortContext } from '../policy'
import { migratedComfortDatabase } from './databaseFixture'

const databases: ReturnType<typeof migratedComfortDatabase>[] = []
const directories: string[] = []
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function fixture(filename = ':memory:', initialize = true) {
  const database = migratedComfortDatabase(filename)
  databases.push(database)
  const store = createComfortStore(database)
  let now = Date.parse('2026-10-26T08:00:00Z'), monotonic = 1000
  let enabled = true, pause: number | null = null
  let admission: ComfortAdmission | null = { revision: 'synthetic-owner-grant', issuedAt: now - 1000, expiresAt: now + 86_400_000 }
  const context: ComfortContext = {
    now, window: { session: 'synthetic-night', segment: 'synthetic-phase', start: now - 3_600_000, end: now + 4 * 3_600_000, baselineF: 75, alarmAt: null },
    device: { observedAt: now, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false, targetF: 75 },
    presence: { observedAt: now, available: true, occupied: true },
    eitherAway: false, routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true,
  }
  if (initialize) store.commit('left', { ...defaultComfortState(), config: { mode: 'active', minimumF: 70, maximumF: 95 }, offsetF: -2 })
  const baseline: TemperatureRequest = { id: 'routine', source: 'schedule', temperature: 75, startsAt: now - 1000,
    expiresAt: now + 86_400_000, createdAt: now - 1000, priority: 0 }
  const commands: { target: number, part: 'level' | 'duration' }[] = []
  let beforeApply: () => Promise<void> = async () => {}
  let betweenWrites: () => void = () => {}
  let reportsTarget = true
  let hold: TemperatureRequest | null = null
  const controller = new TemperatureController({
    now: () => now, withSideLock,
    readHold: () => hold, writeHold: (_side, value) => { hold = value },
    readBaseline: () => [baseline], isPowered: () => context.device.powered,
    readCurrentTarget: () => context.device.targetF,
    readHardwareDeadline: () => null, writeHardwareDeadline: () => {}, isBlocked: () => false,
    connect: async () => {}, powerOff: async () => { context.device.powered = false }, publish: () => {},
    recordApplication: createTemperatureApplicationRecorder(database, () => now),
    apply: async (_side, target) => {
      await beforeApply()
      beforeControlWrite()
      commands.push({ target, part: 'level' })
      betweenWrites()
      beforeControlWrite()
      commands.push({ target, part: 'duration' })
      if (reportsTarget) {
        context.device.targetF = target
        context.device.observedAt = now
      }
    },
  })
  const deps = {
    now: () => now, monotonicNow: () => monotonic, store, authority: controller, withSideLock,
    autopilotEnabled: () => enabled, admission: () => admission, pendingPause: () => pause,
    readContext: () => ({ ...context, now, device: { ...context.device }, presence: { ...context.presence } }),
  }
  const adapter = new ComfortApplicationAdapter(deps)
  const advance = (milliseconds: number, fresh = true) => {
    now += milliseconds
    monotonic += Math.max(0, milliseconds)
    context.now = now
    if (fresh) {
      context.device.observedAt = now
      context.presence.observedAt = now
    }
  }
  return { database, store, context, controller, deps, adapter, commands, advance,
    applications: () => readTemperatureApplications(database, 'left', undefined, now).items,
    beforeApply: (work: () => Promise<void>) => { beforeApply = work },
    betweenWrites: (work: () => void) => { betweenWrites = work },
    reportTarget: (value: boolean) => { reportsTarget = value },
    enable: (value: boolean) => { enabled = value },
    grant: (value: ComfortAdmission | null) => { admission = value },
    pause: () => { pause = now },
    mono: (value: number) => { monotonic = value },
  }
}

describe('personal comfort execution adapter (synthetic qualification, mocked hardware)', () => {
  it('rechecks bedroom expiry after a queued write', async () => {
    const test = fixture()
    const saved = test.store.read('left')
    test.store.commit('left', { ...saved, config: { ...saved.config, roomAware: true } })
    test.context.bedroom = { state: 'ready', offsetF: -1, reason: 'Synthetic room.', sourceIds: ['temperature', 'humidity'],
      expiresAt: test.context.now + 2000, configuration: 'f'.repeat(64) }
    test.beforeApply(async () => {
      test.advance(2000)
    })
    await expect(test.adapter.reconcile('left')).rejects.toThrow('Current control conditions')
    expect(test.commands.filter(command => command.target === 74)).toEqual([])
  })
  it('withdraws an expired bedroom lease during the correction cooldown', async () => {
    const test = fixture()
    const saved = test.store.read('left')
    test.store.commit('left', { ...saved, config: { ...saved.config, roomAware: true } })
    test.context.bedroom = { state: 'ready', offsetF: -1, reason: 'Synthetic room.', sourceIds: ['temperature', 'humidity'],
      expiresAt: test.context.now + 2000, configuration: 'f'.repeat(64) }
    await test.adapter.reconcile('left')
    expect(test.commands.some(command => command.target === 74)).toBe(true)
    test.advance(2000)
    await test.adapter.reconcile('left')
    expect(test.controller.status('left').source).not.toBe('autopilot')
  })
  it('persists only winning one-degree applications and retains the correction clock across keepalives and restarts', async () => {
    const test = fixture()
    await test.adapter.reconcile('left')
    const first = test.store.read('left')
    expect(first).toMatchObject({ lastTargetF: 74, lastAppliedAt: test.context.now, lastSegment: 'synthetic-phase', application: { outcome: 'acknowledged' } })
    expect(test.commands).toEqual([{ target: 74, part: 'level' }, { target: 74, part: 'duration' }])
    expect(test.applications()[0]).toMatchObject({ source: 'autopilot', outcome: 'acknowledged', requestId: `policy:personal-comfort:${first.application?.requestId}` })
    test.advance(5000)
    const restarted = new ComfortApplicationAdapter(test.deps)
    await restarted.reconcile('left')
    expect(test.commands).toHaveLength(2)
    await test.controller.reconcile('left', true)
    expect(test.store.read('left').lastAppliedAt).toBe(first.lastAppliedAt)
    expect(test.applications()).toHaveLength(2)
    test.advance(ADJUSTMENT_INTERVAL_MS - 5000)
    await restarted.reconcile('left')
    expect(test.store.read('left')).toMatchObject({ lastTargetF: 73, lastAppliedAt: test.context.now })
    expect(test.commands.slice(-2)).toEqual([{ target: 73, part: 'level' }, { target: 73, part: 'duration' }])
    expect(test.store.read('right')).toEqual(defaultComfortState())
  })

  it.each(['off', 'preview'] as const)('never submits personal changes in %s mode', async (mode) => {
    const test = fixture()
    const state = test.store.read('left')
    test.store.commit('left', { ...state, config: { ...state.config, mode } })
    await test.adapter.reconcile('left')
    expect(test.store.read('left').application).toBeUndefined()
    expect(test.commands.every(command => command.target === 75)).toBe(true)
  })

  it.each(['consent', 'grant', 'pending_pause', 'empty', 'water', 'stale', 'off', 'base', 'vibration', 'priming', 'alarm', 'bedtime'] as const)(
    'withholds a new proposal when %s is unavailable', async (missing) => {
      const test = fixture()
      if (missing === 'consent') test.enable(false)
      if (missing === 'grant') test.grant(null)
      if (missing === 'pending_pause') test.pause()
      if (missing === 'empty') test.context.presence.occupied = false
      if (missing === 'water') test.context.device.waterAdequate = null
      if (missing === 'stale') test.context.device.observedAt = test.context.now - 16_000
      if (missing === 'off') test.context.device.powered = false
      if (missing === 'base') test.context.device.baseMoving = null
      if (missing === 'vibration') test.context.device.vibrating = true
      if (missing === 'priming') test.context.device.priming = true
      if (missing === 'alarm') test.context.alarmOverride = true
      if (missing === 'bedtime') {
        const state = test.store.read('left')
        test.store.commit('left', { ...state, config: { ...state.config, followBedtime: true } })
      }
      await test.adapter.reconcile('left')
      expect(test.store.read('left').application).toBeUndefined()
      expect(test.commands.every(command => command.target === 75)).toBe(true)
    },
  )

  it('does not reserve a correction for an unselected proposal, even when a rule spoofs its ID', async () => {
    const test = fixture()
    await test.controller.replaceAutopilot('left', [{ id: 'policy:personal-comfort:spoof', source: 'autopilot', temperature: 76,
      startsAt: test.context.now, expiresAt: test.context.now + 60_000, createdAt: test.context.now, priority: 0 }])
    await test.adapter.reconcile('left')
    expect(test.store.read('left').application).toBeUndefined()
    expect(test.commands).toHaveLength(2)
    expect(test.commands[0].target).toBe(76)
  })

  it.each(['consent', 'grant', 'expiry', 'monotonic', 'pause', 'water', 'manual', 'stop', 'slow_inputs'] as const)(
    'rechecks %s after the write has waited in the hardware queue', async (change) => {
      const test = fixture()
      test.beforeApply(async () => {
        if (change === 'consent') test.enable(false)
        if (change === 'grant') test.grant({ revision: 'replaced', issuedAt: test.context.now - 1, expiresAt: test.context.now + 60_000 })
        if (change === 'expiry') test.advance(10_000)
        if (change === 'monotonic') test.mono(11_000)
        if (change === 'pause') test.pause()
        if (change === 'water') test.context.device.waterAdequate = false
        if (change === 'manual') {
          const state = test.store.read('left')
          test.store.commit('left', { ...state, pausedUntil: test.context.now + 6 * 3_600_000 })
        }
        if (change === 'stop') test.adapter.revoke('left')
        if (change === 'slow_inputs') {
          const read = test.deps.readContext
          test.deps.readContext = () => {
            const result = read()
            test.advance(11_000)
            return result
          }
        }
      })
      await expect(test.adapter.reconcile('left')).rejects.toThrow('control conditions')
      expect(test.commands).toEqual([])
      expect(test.store.read('left')).toMatchObject({ lastAppliedAt: 0, lastTargetF: null, application: { outcome: 'unknown' } })
      expect(test.applications()[0].outcome).toBe('unknown')
    },
  )

  it('leaves a partial level/duration write unconfirmed and never retries it after a restart or elapsed cooldown', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'comfort-adapter-'))
    directories.push(directory)
    const filename = path.join(directory, 'config.db')
    const test = fixture(filename)
    test.betweenWrites(() => {
      test.context.device.waterAdequate = false
    })
    await expect(test.adapter.reconcile('left')).rejects.toThrow()
    expect(test.commands).toEqual([{ target: 74, part: 'level' }])
    test.database.close()
    const reopened = fixture(filename, false)
    reopened.advance(ADJUSTMENT_INTERVAL_MS + 1)
    await reopened.adapter.reconcile('left')
    expect(reopened.commands.every(command => command.target === 75)).toBe(true)
    expect(reopened.store.read('left')).toMatchObject({ lastAppliedAt: 0, application: { outcome: 'unknown' } })
  })

  it.each(['reservation', 'journal', 'journal_result', 'comfort_result'] as const)(
    'fails closed if the %s persistence step fails', async (failure) => {
      const test = fixture()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (failure === 'reservation') test.database.exec('CREATE TRIGGER reject_reservation BEFORE UPDATE ON comfort_states BEGIN SELECT RAISE(ABORT, \'test\'); END')
      if (failure === 'journal') test.database.exec('CREATE TRIGGER reject_journal BEFORE INSERT ON temperature_applications BEGIN SELECT RAISE(ABORT, \'test\'); END')
      if (failure === 'journal_result') test.database.exec('CREATE TRIGGER reject_result BEFORE UPDATE ON temperature_applications BEGIN SELECT RAISE(ABORT, \'test\'); END')
      if (failure === 'comfort_result') test.betweenWrites(() => {
        test.database.exec('CREATE TRIGGER reject_result BEFORE UPDATE ON comfort_states BEGIN SELECT RAISE(ABORT, \'test\'); END')
      })
      if (failure === 'journal_result') await test.adapter.reconcile('left')
      else await expect(test.adapter.reconcile('left')).rejects.toThrow('test')
      const state = test.store.read('left')
      expect(state.lastAppliedAt).toBe(0)
      if (failure === 'reservation') expect(state.application).toBeUndefined()
      else expect(state.application?.outcome).not.toBe('acknowledged')
      expect(test.commands).toHaveLength(failure === 'reservation' || failure === 'journal' ? 0 : 2)
    },
  )

  it('persists an unexpected-target pause', async () => {
    const test = fixture()
    test.context.targetKnown = false
    await test.adapter.reconcile('left')
    expect(test.store.read('left').pausedUntil).toBe(test.context.now + 6 * 3_600_000)
    expect(test.store.read('left').application).toBeUndefined()
  })

  it('latches unexpected targets during read-only selection and persists the pause inside the next side lock', async () => {
    const test = fixture()
    await test.adapter.reconcile('left')
    const before = test.store.read('left')
    test.context.targetKnown = false
    test.context.device.targetF = 77
    expect(test.controller.status('left').source).toBe('schedule')
    expect(test.store.read('left')).toEqual(before)
    test.context.targetKnown = true
    test.context.device.targetF = 74
    await test.adapter.reconcile('left')
    expect(test.store.read('left').pausedUntil).toBe(test.context.now + 6 * 3_600_000)
  })

  it('waits briefly for a newer target report without refreshing its grace period or retrying the target', async () => {
    const test = fixture()
    test.reportTarget(false)
    test.betweenWrites(() => test.advance(1, false))
    await test.adapter.reconcile('left')
    expect(test.controller.status('left').source).toBe('autopilot')
    test.advance(5000, false)
    await test.adapter.reconcile('left')
    expect(test.commands).toHaveLength(2)
    await expect(test.controller.reconcile('left', true)).rejects.toThrow('control conditions')
    expect(test.commands).toHaveLength(2)
    test.advance(5001, false)
    await test.controller.reconcile('left')
    expect(test.controller.status('left').source).toBe('schedule')
    expect(test.commands.slice(-2).every(command => command.target === 75)).toBe(true)
  })
})
