// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'
import { DacMonitor } from '@/src/hardware/dacMonitor'
import type { HardwareClient } from '@/src/hardware/client'
import { parseDeviceStatus } from '@/src/hardware/responseParser'
import { DEVICE_STATUS_POD4 } from '@/src/hardware/tests/fixtures'
import { beginStatusChange } from '@/src/hardware/statusRevision'
import { clearPumpStallNotice, resetPumpStallNotifications, setPumpStallNotice } from '@/src/hardware/pumpStallNotification'
import { buildThermostatService, THERMOSTAT_FRESH_MS } from '../accessories/thermostat'
import { bindPumpHealth } from '../accessories/pumpHealthSensor'

vi.mock('@/src/temperature/instance', () => ({ getTemperatureController: vi.fn() }))
vi.mock('@/src/scheduler', () => ({ getJobManager: vi.fn() }))

const status = parseDeviceStatus(DEVICE_STATUS_POD4)
describe('HAP observations through the production DAC monitor', () => {
  const client = { connect: vi.fn(), disconnect: vi.fn(), isConnected: vi.fn(), getDeviceStatus: vi.fn() }
  let monitor: DacMonitor
  let accessory: ReturnType<typeof buildThermostatService>
  let stopPump: () => void
  beforeEach(async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-25T12:00:00Z'))
    client.connect.mockResolvedValue(undefined)
    client.isConnected.mockReturnValue(true)
    client.getDeviceStatus.mockReset().mockResolvedValue(status)
    resetPumpStallNotifications()
    monitor = new DacMonitor({ socketPath: '/unused', pollIntervalMs: 100, hardwareClient: client as unknown as HardwareClient })
    monitor.on('error', () => {})
    accessory = buildThermostatService('left', monitor)
    stopPump = bindPumpHealth(accessory.service, 'left')
    await monitor.start()
  })
  afterEach(() => {
    accessory.stop()
    stopPump()
    monitor.stop()
    resetPumpStallNotifications()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  const current = () => accessory.service.getCharacteristic(Characteristic.CurrentTemperature)
  const fault = () => accessory.service.getCharacteristic(Characteristic.StatusFault).handleGetRequest()

  it('starts unavailable, recovers after a report, and expires without another event', async () => {
    await expect(current().handleGetRequest()).rejects.toBe(-70402)
    expect(await fault()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(typeof await current().handleGetRequest()).toBe('number')
    expect(await fault()).toBe(0)
    monitor.setPollInterval(60_000)
    await vi.advanceTimersByTimeAsync(THERMOSTAT_FRESH_MS + 1000)
    expect(current().statusCode).toBe(-70402)
    await expect(current().handleGetRequest()).rejects.toBe(-70402)
    expect(await fault()).toBe(1)
    monitor.setPollInterval(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(current().statusCode).toBe(0)
    expect(await fault()).toBe(0)
  })

  it('rejects a delayed status event that overlapped a hardware write', async () => {
    let finish: (value: typeof status) => void = () => {}
    client.getDeviceStatus.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    await vi.advanceTimersByTimeAsync(100)
    beginStatusChange()()
    finish(status)
    await vi.advanceTimersByTimeAsync(0)
    expect(current().statusCode).toBe(-70402)
    await expect(current().handleGetRequest()).rejects.toBe(-70402)
    await vi.advanceTimersByTimeAsync(100)
    expect(current().statusCode).toBe(0)
  })

  it('invalidates pending writes, disconnection, stop, and backwards clocks', async () => {
    await vi.advanceTimersByTimeAsync(100)
    const finish = beginStatusChange()
    try {
      await expect(current().handleGetRequest()).rejects.toBe(-70402)
    }
    finally { finish() }
    await expect(current().handleGetRequest()).rejects.toBe(-70402)
    await vi.advanceTimersByTimeAsync(100)
    client.isConnected.mockReturnValue(false)
    await expect(current().handleGetRequest()).rejects.toBe(-70402)
    client.isConnected.mockReturnValue(true)
    vi.setSystemTime(Date.now() - 1000)
    await expect(current().handleGetRequest()).rejects.toBe(-70402)
    monitor.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(current().statusCode).toBe(-70402)
  })

  it('combines pump and telemetry faults without either one clearing the other', async () => {
    setPumpStallNotice('left', { alertId: 1, trippedAt: Date.now(), rpm: 0, restore: null })
    await vi.advanceTimersByTimeAsync(100)
    expect(current().statusCode).toBe(0)
    expect(await fault()).toBe(1)
    client.isConnected.mockReturnValue(false)
    clearPumpStallNotice('left')
    await vi.advanceTimersByTimeAsync(5000)
    expect(await fault()).toBe(1)
    client.isConnected.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(await fault()).toBe(0)
  })

  it('cleans up both event subscriptions and the expiry timer', async () => {
    const update = vi.spyOn(current(), 'updateValue')
    accessory.stop()
    expect(monitor.listenerCount('status:updated')).toBe(0)
    expect(monitor.listenerCount('connection:lost')).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(update).not.toHaveBeenCalled()
  })
})
