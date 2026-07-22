/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for src/hardware/dacMonitor.instance.ts — the global hardware
 * singleton wrapper (DAC server connect, shared HardwareClient, DacMonitor).
 *
 * The class boundaries (DacMonitor, GestureActionHandler, DeviceStateSync,
 * dacTransport) are mocked so we exercise only the wrapper's wiring.
 *
 * `globalThis` carries the singleton state, so each test calls
 * `freshModule()` which resets module state AND clears the relevant global
 * keys to avoid cross-test bleed.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import type { DeviceStatus } from '../types'

// ── Module-scoped mock targets ───────────────────────────────────────────────

const connectDacMock = vi.fn<(path: string) => Promise<void>>(async () => {})
const disconnectDacMock = vi.fn(async () => {})
const sendCommandMock = vi.fn<(cmd: string, arg?: string) => Promise<string>>(async () => 'OK\n\n')
const isDacConnectedMock = vi.fn(() => true)

const parseDeviceStatusMock = vi.fn<(resp: string) => DeviceStatus>(() => ({
  leftSide: { currentTemperature: 75, targetTemperature: 75, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
  rightSide: { currentTemperature: 75, targetTemperature: 75, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
  waterLevel: 'ok',
  isPriming: false,
  podVersion: 'I00' as any,
  sensorLabel: 'I00-test',
}))
const parseSimpleResponseMock = vi.fn<(resp: string) => { success: boolean, message: string }>(
  () => ({ success: true, message: 'ok' }),
)

// DacMonitor mock — captures registered listeners so tests can fire them.
// `nextStartImpl` lets a test queue a one-shot start() body for the next
// constructed monitor (e.g. to make it throw and exercise the catch path).
type ListenerMap = Record<string, Array<(...args: unknown[]) => void>>
const monitorInstances: any[] = []
let nextStartImpl: (() => Promise<void>) | null = null
class FakeDacMonitor {
  config: any
  listeners: ListenerMap = {}
  start: Mock
  stop = vi.fn()
  removeAllListeners = vi.fn((event?: string) => {
    if (event) this.listeners[event] = []
    else this.listeners = {}
  })

  constructor(config: any) {
    this.config = config
    const impl = nextStartImpl ?? (async () => {})
    nextStartImpl = null
    this.start = vi.fn(impl)
    monitorInstances.push(this)
  }

  on(event: string, cb: (...args: unknown[]) => void) {
    ;(this.listeners[event] ||= []).push(cb)
    return this
  }

  emit(event: string, ...args: unknown[]) {
    for (const cb of this.listeners[event] || []) cb(...args)
  }
}

const gestureCleanupMock = vi.fn()
const gestureHandleMock = vi.fn()
class FakeGestureActionHandler {
  socketPath: string
  deps: unknown
  cleanup = gestureCleanupMock
  handle = gestureHandleMock
  constructor(socketPath: string, deps: unknown) {
    this.socketPath = socketPath
    this.deps = deps
  }
}

const stateSyncSyncMock = vi.fn(async () => {})
const stateSyncRecordFlowMock = vi.fn()
class FakeDeviceStateSync {
  sync = stateSyncSyncMock
  recordFlowData = stateSyncRecordFlowMock
}

const cancelSnoozeMock = vi.fn<(side: 'left' | 'right') => void>()
const resetPrimingStateMock = vi.fn()
const trackPrimingStateMock = vi.fn<(priming: boolean) => void>()
const getPrimeCompletedAtMock = vi.fn(() => null as number | null)
const getAllPumpStallNoticesMock = vi.fn<() => { left: unknown, right: unknown }>(() => ({ left: null, right: null }))
const getAlarmStateMock = vi.fn(() => ({ left: false, right: false }))
const getSnoozeStatusMock = vi.fn<(side: 'left' | 'right') => { active: boolean, snoozeUntil: number | null }>(
  () => ({ active: false, snoozeUntil: null }),
)

const broadcastFrameMock = vi.fn()
const onServerFrameMock = vi.fn<(cb: (frame: unknown) => void) => () => void>(() => () => {})

// ── vi.mock declarations ─────────────────────────────────────────────────────

vi.mock('../dacTransport', () => ({
  connectDac: (...a: unknown[]) => connectDacMock(...a as [string]),
  disconnectDac: () => disconnectDacMock(),
  sendCommand: (...a: unknown[]) => sendCommandMock(...a as [string, string?]),
  isDacConnected: () => isDacConnectedMock(),
}))

vi.mock('../dacMonitor', () => ({
  DacMonitor: FakeDacMonitor,
}))

vi.mock('../gestureActionHandler', () => ({
  GestureActionHandler: FakeGestureActionHandler,
}))

vi.mock('../gestureActionHandler.deps', () => ({
  defaultGestureActionDeps: { _stub: true },
}))

vi.mock('../deviceStateSync', () => ({
  DeviceStateSync: FakeDeviceStateSync,
  getAlarmState: () => getAlarmStateMock(),
}))

vi.mock('../primeNotification', () => ({
  trackPrimingState: (priming: boolean) => trackPrimingStateMock(priming),
  resetPrimingState: () => resetPrimingStateMock(),
  getPrimeCompletedAt: () => getPrimeCompletedAtMock(),
}))

vi.mock('../pumpStallNotification', () => ({
  getAllPumpStallNotices: () => getAllPumpStallNoticesMock(),
}))

vi.mock('../snoozeManager', () => ({
  cancelSnooze: (side: 'left' | 'right') => cancelSnoozeMock(side),
  getSnoozeStatus: (side: 'left' | 'right') => getSnoozeStatusMock(side),
}))

vi.mock('../responseParser', () => ({
  parseDeviceStatus: (...a: unknown[]) => parseDeviceStatusMock(...a as [string]),
  parseSimpleResponse: (...a: unknown[]) => parseSimpleResponseMock(...a as [string]),
}))

vi.mock('@/src/streaming/piezoStream', () => ({
  broadcastFrame: (...a: unknown[]) => broadcastFrameMock(...a),
  onServerFrame: (cb: (frame: unknown) => void) => onServerFrameMock(cb),
}))

// ── Helpers ─────────────────────────────────────────────────────────────────

import type * as InstanceModuleTypes from '../dacMonitor.instance'
type InstanceModule = typeof InstanceModuleTypes

const GLOBAL_KEYS = [
  '__sp_dac_server__',
  '__sp_hw_client__',
  '__sp_dac_monitor__',
  '__sp_gesture_handler__',
  '__sp_unsub_flow__',
] as const

function clearGlobals() {
  const g = globalThis as Record<string, unknown>
  // The keys come from a const tuple; dynamic-access on a known shape is safe.
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  for (const k of GLOBAL_KEYS) delete g[k]
}

async function freshModule(): Promise<InstanceModule> {
  vi.resetModules()
  clearGlobals()
  return await import('../dacMonitor.instance')
}

async function flushMicrotasks(): Promise<void> {
  // Dynamic imports return a Promise; the wrapper chains .then(broadcastFrame).
  // Several macrotask ticks ensure the chain settles before assertions.
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('hardware/dacMonitor.instance', () => {
  beforeEach(() => {
    connectDacMock.mockReset().mockResolvedValue(undefined)
    disconnectDacMock.mockReset().mockResolvedValue(undefined)
    sendCommandMock.mockReset().mockResolvedValue('OK\n\n')
    isDacConnectedMock.mockReset().mockReturnValue(true)
    parseDeviceStatusMock.mockClear()
    parseSimpleResponseMock.mockReset().mockReturnValue({ success: true, message: 'ok' })
    gestureCleanupMock.mockClear()
    gestureHandleMock.mockClear()
    stateSyncSyncMock.mockReset().mockResolvedValue(undefined)
    stateSyncRecordFlowMock.mockClear()
    cancelSnoozeMock.mockClear()
    resetPrimingStateMock.mockClear()
    trackPrimingStateMock.mockClear()
    getPrimeCompletedAtMock.mockReset().mockReturnValue(null)
    getAllPumpStallNoticesMock.mockReset().mockReturnValue({ left: null, right: null })
    getAlarmStateMock.mockReset().mockReturnValue({ left: false, right: false })
    getSnoozeStatusMock.mockReset().mockReturnValue({ active: false, snoozeUntil: null })
    broadcastFrameMock.mockClear()
    onServerFrameMock.mockReset().mockImplementation(() => () => {})
    monitorInstances.length = 0
    nextStartImpl = null
  })

  afterEach(async () => {
    // Drain any in-flight shutdown so the singleton globals are clean before
    // the next test re-imports the module.
    try {
      const mod = await import('../dacMonitor.instance')
      await mod.shutdownDacMonitor().catch(() => {})
    }
    catch { /* ignore */ }
    // Give pending dynamic-import .then() chains a chance to settle before
    // the next test resets module + mock state, so leftover side effects
    // (e.g. onServerFrame registration) can't bleed across tests.
    await flushMicrotasks()
    clearGlobals()
  })

  // ── startDacServer / getDacServer ──

  describe('startDacServer / getDacServer', () => {
    it('returns null before startDacServer is called', async () => {
      const mod = await freshModule()
      expect(mod.getDacServer()).toBeNull()
    })

    it('invokes connectDac on first call and marks the server flag', async () => {
      const mod = await freshModule()
      await mod.startDacServer()
      await flushMicrotasks()

      expect(connectDacMock).toHaveBeenCalledTimes(1)
      expect(mod.getDacServer()).toBe(true)
    })

    it('is idempotent — second call does NOT re-invoke connectDac', async () => {
      const mod = await freshModule()
      await mod.startDacServer()
      await mod.startDacServer()
      await flushMicrotasks()
      expect(connectDacMock).toHaveBeenCalledTimes(1)
    })

    it('swallows connectDac rejection (degraded mode) with a console warning', async () => {
      const mod = await freshModule()
      connectDacMock.mockRejectedValueOnce(new Error('no socket'))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await mod.startDacServer()
      await flushMicrotasks()

      expect(warnSpy).toHaveBeenCalledWith(
        '[DAC] connection failed (will retry on next command):',
        'no socket',
      )
      expect(mod.getDacServer()).toBe(true) // server flag still set
      warnSpy.mockRestore()
    })

    it('handles non-Error rejection values without crashing', async () => {
      const mod = await freshModule()
      connectDacMock.mockRejectedValueOnce('string failure')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await mod.startDacServer()
      await flushMicrotasks()

      expect(warnSpy).toHaveBeenCalledWith(
        '[DAC] connection failed (will retry on next command):',
        'string failure',
      )
      warnSpy.mockRestore()
    })

    it('honours DAC_SOCK_PATH from the environment', async () => {
      const prev = process.env.DAC_SOCK_PATH
      process.env.DAC_SOCK_PATH = '/tmp/custom-dac.sock'
      try {
        const mod = await freshModule()
        await mod.startDacServer()
        await flushMicrotasks()
        expect(connectDacMock).toHaveBeenCalledWith('/tmp/custom-dac.sock')
      }
      finally {
        if (prev === undefined) delete process.env.DAC_SOCK_PATH
        else process.env.DAC_SOCK_PATH = prev
      }
    })
  })

  // ── getSharedHardwareClient ──

  describe('getSharedHardwareClient', () => {
    it('returns the same client instance across calls', async () => {
      const mod = await freshModule()
      const a = mod.getSharedHardwareClient()
      const b = mod.getSharedHardwareClient()
      expect(a).toBe(b)
    })

    describe('DacHardwareClient methods', () => {
      it('connect() short-circuits when already connected', async () => {
        const mod = await freshModule()
        isDacConnectedMock.mockReturnValue(true)
        await mod.getSharedHardwareClient().connect()
        expect(connectDacMock).not.toHaveBeenCalled()
      })

      it('connect() calls connectDac when disconnected', async () => {
        const mod = await freshModule()
        isDacConnectedMock.mockReturnValue(false)
        await mod.getSharedHardwareClient().connect()
        expect(connectDacMock).toHaveBeenCalledTimes(1)
      })

      it('getDeviceStatus delegates to sendCommand + parseDeviceStatus', async () => {
        const mod = await freshModule()
        sendCommandMock.mockResolvedValue('raw-response')
        const client = mod.getSharedHardwareClient()
        await client.getDeviceStatus()
        expect(sendCommandMock).toHaveBeenCalledWith('14') // DEVICE_STATUS
        expect(parseDeviceStatusMock).toHaveBeenCalledWith('raw-response')
      })

      it('setTemperature throws below MIN_TEMP', async () => {
        const mod = await freshModule()
        await expect(mod.getSharedHardwareClient().setTemperature('left', 40))
          .rejects.toThrow(/between/)
      })

      it('setTemperature throws above MAX_TEMP', async () => {
        const mod = await freshModule()
        await expect(mod.getSharedHardwareClient().setTemperature('right', 200))
          .rejects.toThrow(/between/)
      })

      it('setTemperature(left) sends level + duration commands', async () => {
        const mod = await freshModule()
        await mod.getSharedHardwareClient().setTemperature('left', 75)
        // Level + duration → 2 calls; the first is TEMP_LEVEL_LEFT ('11')
        expect(sendCommandMock).toHaveBeenCalledTimes(2)
        expect(sendCommandMock).toHaveBeenNthCalledWith(1, '11', expect.any(String))
        expect(sendCommandMock).toHaveBeenNthCalledWith(2, '9', expect.any(String))
      })

      it('setTemperature(right) routes to the right-side commands', async () => {
        const mod = await freshModule()
        await mod.getSharedHardwareClient().setTemperature('right', 75, 600)
        expect(sendCommandMock).toHaveBeenNthCalledWith(1, '12', expect.any(String))
        expect(sendCommandMock).toHaveBeenNthCalledWith(2, '10', '600')
      })

      it('setAlarm rejects vibrationIntensity outside 1..100', async () => {
        const mod = await freshModule()
        const c = mod.getSharedHardwareClient()
        await expect(c.setAlarm('left', { vibrationIntensity: 0, vibrationPattern: 'rise', duration: 60 }))
          .rejects.toThrow(/intensity/)
        await expect(c.setAlarm('left', { vibrationIntensity: 200, vibrationPattern: 'rise', duration: 60 }))
          .rejects.toThrow(/intensity/)
      })

      it('setAlarm rejects duration outside 0..180', async () => {
        const mod = await freshModule()
        await expect(mod.getSharedHardwareClient()
          .setAlarm('left', { vibrationIntensity: 50, vibrationPattern: 'rise', duration: 999 }))
          .rejects.toThrow(/duration/)
      })

      it('setAlarm(left, rise) sends ALARM_LEFT (cmd 5) with hex-CBOR payload', async () => {
        const mod = await freshModule()
        await mod.getSharedHardwareClient()
          .setAlarm('left', { vibrationIntensity: 50, vibrationPattern: 'rise', duration: 60 })
        const [cmd, arg] = sendCommandMock.mock.calls[0]
        expect(cmd).toBe('5')
        expect(arg).toMatch(/^[0-9a-f]+$/)
        // CBOR text(4) "rise" encodes as 0x64 0x72 0x69 0x73 0x65
        expect(arg).toContain('6472697365')
      })

      it('setAlarm(right, double) sends ALARM_RIGHT (cmd 6) with hex-CBOR payload', async () => {
        const mod = await freshModule()
        await mod.getSharedHardwareClient()
          .setAlarm('right', { vibrationIntensity: 100, vibrationPattern: 'double', duration: 0 })
        const [cmd, arg] = sendCommandMock.mock.calls[0]
        expect(cmd).toBe('6')
        expect(arg).toMatch(/^[0-9a-f]+$/)
        // CBOR text(6) "double" encodes as 0x66 0x64 0x6f 0x75 0x62 0x6c 0x65
        expect(arg).toContain('66646f75626c65')
      })

      it('setAlarm throws when parseSimpleResponse reports failure', async () => {
        const mod = await freshModule()
        parseSimpleResponseMock.mockReturnValue({ success: false, message: 'nope' })
        await expect(mod.getSharedHardwareClient()
          .setAlarm('left', { vibrationIntensity: 50, vibrationPattern: 'rise', duration: 60 }))
          .rejects.toThrow(/nope/)
      })

      it('clearAlarm(left) sends ALARM_CLEAR with arg "0"', async () => {
        const mod = await freshModule()
        await mod.getSharedHardwareClient().clearAlarm('left')
        expect(sendCommandMock).toHaveBeenCalledWith('16', '0')
      })

      it('clearAlarm(right) sends ALARM_CLEAR with arg "1"', async () => {
        const mod = await freshModule()
        await mod.getSharedHardwareClient().clearAlarm('right')
        expect(sendCommandMock).toHaveBeenCalledWith('16', '1')
      })

      it('startPriming throws when the firmware response indicates failure', async () => {
        const mod = await freshModule()
        parseSimpleResponseMock.mockReturnValue({ success: false, message: 'busy' })
        await expect(mod.getSharedHardwareClient().startPriming())
          .rejects.toThrow(/busy/)
      })

      it('startPriming resolves silently on success', async () => {
        const mod = await freshModule()
        await expect(mod.getSharedHardwareClient().startPriming()).resolves.toBeUndefined()
        expect(sendCommandMock).toHaveBeenCalledWith('13') // PRIME
      })

      it('setPower(true) without temperature uses the POWER_ON_FALLBACK', async () => {
        const mod = await freshModule()
        await mod.getSharedHardwareClient().setPower('left', true)
        // Routed through setTemperature → 2 sendCommand calls
        expect(sendCommandMock).toHaveBeenCalledTimes(2)
      })

      it('setPower(true) with explicit temperature routes through setTemperature', async () => {
        const mod = await freshModule()
        await mod.getSharedHardwareClient().setPower('right', true, 80)
        expect(sendCommandMock).toHaveBeenNthCalledWith(1, '12', expect.any(String))
      })

      it('setPower(false, left) sends TEMP_LEVEL_LEFT "0"', async () => {
        const mod = await freshModule()
        await mod.getSharedHardwareClient().setPower('left', false)
        expect(sendCommandMock).toHaveBeenCalledWith('11', '0')
      })

      it('setPower(false, right) throws when the firmware reports failure', async () => {
        const mod = await freshModule()
        parseSimpleResponseMock.mockReturnValue({ success: false, message: 'fail' })
        await expect(mod.getSharedHardwareClient().setPower('right', false))
          .rejects.toThrow(/power off/i)
      })

      it('isConnected delegates to isDacConnected', async () => {
        const mod = await freshModule()
        isDacConnectedMock.mockReturnValue(true)
        expect(mod.getSharedHardwareClient().isConnected()).toBe(true)
        isDacConnectedMock.mockReturnValue(false)
        expect(mod.getSharedHardwareClient().isConnected()).toBe(false)
      })

      it('disconnect is a no-op on the shared client', async () => {
        const mod = await freshModule()
        mod.getSharedHardwareClient().disconnect()
        expect(disconnectDacMock).not.toHaveBeenCalled()
      })

      it('getRawClient returns null on the shared client', async () => {
        const mod = await freshModule()
        const client = mod.getSharedHardwareClient() as any
        expect(client.getRawClient()).toBeNull()
      })
    })
  })

  // ── getDacMonitor / getDacMonitorIfRunning / shutdownDacMonitor ──

  describe('getDacMonitor', () => {
    it('returns null from getDacMonitorIfRunning before init', async () => {
      const mod = await freshModule()
      expect(mod.getDacMonitorIfRunning()).toBeNull()
    })

    it('lazy-constructs a DacMonitor on first call and starts it', async () => {
      const mod = await freshModule()
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const monitor = await mod.getDacMonitor()
      expect(monitorInstances).toHaveLength(1)
      expect(monitor).toBe(monitorInstances[0])
      expect(monitorInstances[0].start).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledWith('[DAC] monitor started')
      log.mockRestore()
    })

    it('is idempotent — second call returns the same monitor without re-starting', async () => {
      const mod = await freshModule()
      const a = await mod.getDacMonitor()
      const b = await mod.getDacMonitor()
      expect(a).toBe(b)
      expect(monitorInstances).toHaveLength(1)
      expect(monitorInstances[0].start).toHaveBeenCalledTimes(1)
    })

    it('coalesces concurrent callers into a single init (single-flight)', async () => {
      const mod = await freshModule()
      const [a, b, c] = await Promise.all([
        mod.getDacMonitor(),
        mod.getDacMonitor(),
        mod.getDacMonitor(),
      ])
      expect(a).toBe(b)
      expect(b).toBe(c)
      expect(monitorInstances).toHaveLength(1)
    })

    it('clears the monitor slot when start() rejects so the next call can retry', async () => {
      const mod = await freshModule()
      nextStartImpl = async () => {
        throw new Error('start-fail')
      }

      await expect(mod.getDacMonitor()).rejects.toThrow('start-fail')
      expect(mod.getDacMonitorIfRunning()).toBeNull()

      // Second attempt: next monitor uses the default success impl
      const m2 = await mod.getDacMonitor()
      expect(m2).toBeDefined()
      expect(monitorInstances.length).toBeGreaterThanOrEqual(2)
    })

    it('wires status:updated listener — fires trackPrimingState + DeviceStateSync.sync', async () => {
      const mod = await freshModule()
      await mod.getDacMonitor()
      await flushMicrotasks()
      const monitor = monitorInstances[0]

      const status: DeviceStatus = parseDeviceStatusMock('raw') // shape from default mock
      const beforeCalls = broadcastFrameMock.mock.calls.length
      monitor.emit('status:updated', status)
      await flushMicrotasks()

      expect(trackPrimingStateMock).toHaveBeenCalledWith(status.isPriming)
      expect(stateSyncSyncMock).toHaveBeenCalledWith(status)
      // Allow for frames already emitted during init wiring; require at least
      // one additional broadcast triggered by the emit above.
      expect(broadcastFrameMock.mock.calls.length).toBeGreaterThan(beforeCalls)
    })

    it('broadcasts the exact deviceStatus frame with alarm and snooze state', async () => {
      const mod = await freshModule()
      vi.spyOn(Date, 'now').mockReturnValue(1_720_000_123_456)
      getAlarmStateMock.mockReturnValue({ left: true, right: false })
      getSnoozeStatusMock.mockImplementation(side => side === 'left'
        ? { active: true, snoozeUntil: 123 }
        : { active: false, snoozeUntil: null })
      await mod.getDacMonitor()
      await flushMicrotasks()
      broadcastFrameMock.mockClear()
      getSnoozeStatusMock.mockClear()
      const status = parseDeviceStatusMock('raw')

      monitorInstances[0].emit('status:updated', status)
      await flushMicrotasks()

      expect(broadcastFrameMock).toHaveBeenCalledWith({
        type: 'deviceStatus',
        ts: 1_720_000_123_456,
        leftSide: { ...status.leftSide, isAlarmVibrating: true },
        rightSide: { ...status.rightSide, isAlarmVibrating: false },
        waterLevel: 'ok',
        isPriming: false,
        snooze: {
          left: { active: true, snoozeUntil: 123 },
          right: { active: false, snoozeUntil: null },
        },
      })
      expect(getSnoozeStatusMock.mock.calls).toEqual([['left'], ['right']])
      vi.restoreAllMocks()
    })

    it('status:updated includes primeCompletedNotification when getPrimeCompletedAt returns a value', async () => {
      const mod = await freshModule()
      await mod.getDacMonitor()
      await flushMicrotasks()
      const monitor = monitorInstances[0]
      getPrimeCompletedAtMock.mockReturnValue(123_456)

      const status: DeviceStatus = parseDeviceStatusMock('raw')
      monitor.emit('status:updated', status)
      await flushMicrotasks()

      const lastFrame = broadcastFrameMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
      expect(lastFrame).toBeDefined()
      expect(lastFrame?.primeCompletedNotification).toEqual({ timestamp: 123_456 })
    })

    it('status:updated includes pumpStallNotifications when one side has an active notice', async () => {
      const mod = await freshModule()
      await mod.getDacMonitor()
      await flushMicrotasks()
      const monitor = monitorInstances[0]
      const notice = { alertId: 42, trippedAt: 1_700_000_000, rpm: 0, restore: null }
      getAllPumpStallNoticesMock.mockReturnValue({ left: null, right: notice })

      const status: DeviceStatus = parseDeviceStatusMock('raw')
      monitor.emit('status:updated', status)
      await flushMicrotasks()

      const lastFrame = broadcastFrameMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
      expect(lastFrame).toBeDefined()
      expect(lastFrame?.pumpStallNotifications).toEqual({ left: null, right: notice })
    })

    it('status:updated includes pumpStallNotifications when only the left side has an active notice', async () => {
      const mod = await freshModule()
      await mod.getDacMonitor()
      await flushMicrotasks()
      const monitor = monitorInstances[0]
      const notice = { alertId: 43, trippedAt: 1_700_000_000, rpm: 0, restore: null }
      getAllPumpStallNoticesMock.mockReturnValue({ left: notice, right: null })

      const status: DeviceStatus = parseDeviceStatusMock('raw')
      monitor.emit('status:updated', status)
      await flushMicrotasks()

      const lastFrame = broadcastFrameMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
      expect(lastFrame).toBeDefined()
      expect(lastFrame?.pumpStallNotifications).toEqual({ left: notice, right: null })
    })

    it('status:updated omits pumpStallNotifications when both sides are null', async () => {
      const mod = await freshModule()
      await mod.getDacMonitor()
      await flushMicrotasks()
      const monitor = monitorInstances[0]

      const status: DeviceStatus = parseDeviceStatusMock('raw')
      monitor.emit('status:updated', status)
      await flushMicrotasks()

      const lastFrame = broadcastFrameMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
      expect(lastFrame).toBeDefined()
      expect(lastFrame && 'pumpStallNotifications' in lastFrame).toBe(false)
    })

    it('status:updated does NOT crash when trackPrimingState throws', async () => {
      const mod = await freshModule()
      await mod.getDacMonitor()
      const monitor = monitorInstances[0]
      trackPrimingStateMock.mockImplementationOnce(() => {
        throw new Error('prime-bad')
      })
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const status: DeviceStatus = parseDeviceStatusMock('raw')
      expect(() => monitor.emit('status:updated', status)).not.toThrow()
      await flushMicrotasks()
      expect(errSpy).toHaveBeenCalledWith('[DacMonitor] primeNotification error:', expect.objectContaining({ message: 'prime-bad' }))
      errSpy.mockRestore()
    })

    it('wires gesture:detected listener — fires gesture handler + broadcasts frame', async () => {
      const mod = await freshModule()
      await mod.getDacMonitor()
      await flushMicrotasks()
      const monitor = monitorInstances[0]

      const gestureEvent = { side: 'left', tapType: 'doubleTap', timestamp: new Date() }
      monitor.emit('gesture:detected', gestureEvent)
      await flushMicrotasks()

      expect(gestureHandleMock).toHaveBeenCalledWith(gestureEvent)
      expect(broadcastFrameMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'gesture', side: 'left', tapType: 'doubleTap' }),
      )
    })

    it('subscribes to piezoStream server frames and records flow data', async () => {
      const mod = await freshModule()
      await mod.getDacMonitor()
      await flushMicrotasks()

      expect(onServerFrameMock).toHaveBeenCalledTimes(1)
      const cb = (onServerFrameMock.mock.calls[0]?.[0]) as ((frame: unknown) => void) | undefined
      cb?.({ type: 'frzHealth', flow: 42 })
      expect(stateSyncRecordFlowMock).toHaveBeenCalledWith({ type: 'frzHealth', flow: 42 })
    })

    it('isolates DeviceStateSync.sync rejections (logged, not thrown)', async () => {
      const mod = await freshModule()
      await mod.getDacMonitor()
      const monitor = monitorInstances[0]
      stateSyncSyncMock.mockRejectedValueOnce(new Error('sync-bad'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      monitor.emit('status:updated', parseDeviceStatusMock('raw'))
      await flushMicrotasks()
      await flushMicrotasks()
      expect(errSpy).toHaveBeenCalledWith('[DacMonitor] DeviceStateSync error:', expect.objectContaining({ message: 'sync-bad' }))
      errSpy.mockRestore()
    })
  })

  // ── shutdownDacMonitor ──

  describe('shutdownDacMonitor', () => {
    it('cleans up monitor, gesture handler, and clears all global keys', async () => {
      const mod = await freshModule()
      await mod.startDacServer()
      mod.getSharedHardwareClient()
      const monitor = await mod.getDacMonitor()
      await flushMicrotasks()

      expect(mod.getDacServer()).toBe(true)
      expect(mod.getDacMonitorIfRunning()).toBe(monitor)

      await mod.shutdownDacMonitor()

      expect(monitor.stop).toHaveBeenCalled()
      expect(monitor.removeAllListeners).toHaveBeenCalledWith('gesture:detected')
      expect(monitor.removeAllListeners).toHaveBeenCalledWith('status:updated')
      expect(gestureCleanupMock).toHaveBeenCalled()
      expect(disconnectDacMock).toHaveBeenCalled()
      expect(cancelSnoozeMock).toHaveBeenCalledWith('left')
      expect(cancelSnoozeMock).toHaveBeenCalledWith('right')
      expect(resetPrimingStateMock).toHaveBeenCalled()
      expect(mod.getDacServer()).toBeNull()
      expect(mod.getDacMonitorIfRunning()).toBeNull()
    })

    it('is safe to call before any init (no-op path)', async () => {
      const mod = await freshModule()
      await expect(mod.shutdownDacMonitor()).resolves.toBeUndefined()
      expect(disconnectDacMock).toHaveBeenCalled() // still drains transport
    })

    it('awaits an in-flight monitorInitPromise without throwing', async () => {
      const mod = await freshModule()
      let release!: () => void
      nextStartImpl = () => new Promise<void>((resolve) => {
        release = resolve
      })

      const initP = mod.getDacMonitor()
      let shutdownSettled = false
      const shutdown = mod.shutdownDacMonitor().then(() => {
        shutdownSettled = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(shutdownSettled).toBe(false)

      release()
      await initP
      await shutdown
      expect(shutdownSettled).toBe(true)
    })

    it('invokes the flow-data unsubscribe handle stored on globalThis', async () => {
      const mod = await freshModule()
      const unsub = vi.fn()
      onServerFrameMock.mockImplementation(() => unsub)

      await mod.getDacMonitor()
      await flushMicrotasks()
      await mod.shutdownDacMonitor()

      expect(unsub).toHaveBeenCalled()
    })

    it('logs the exact shutdown completion message', async () => {
      const mod = await freshModule()
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})

      await mod.shutdownDacMonitor()

      expect(log).toHaveBeenCalledWith('[DAC] shutdown complete')
      log.mockRestore()
    })
  })
})
