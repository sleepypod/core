import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ readFile: vi.fn(), monitor: vi.fn(), base: vi.fn(), mqtt: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: runtime.readFile, default: { readFile: runtime.readFile } }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getDacMonitorIfRunning: runtime.monitor }))
vi.mock('@/src/hardware/base/instance', () => ({ getBaseControllerIfRunning: runtime.base }))
vi.mock('@/src/streaming/mqttBridge', () => ({ getBridgeStatus: runtime.mqtt }))
vi.mock('@/src/comfort/instance', () => ({ getComfortRuntimeIfRunning: () => undefined }))
const { readCapabilities } = await import('../read')

beforeEach(() => {
  vi.resetAllMocks()
  runtime.readFile.mockResolvedValue('{"commitHash":"abcdef123"}')
  runtime.monitor.mockReturnValue(null)
  runtime.base.mockReturnValue(null)
  runtime.mqtt.mockReturnValue({ connected: false })
})
afterEach(() => vi.useRealTimers())

describe('passive capability reader', () => {
  it('does not need hardware initialization to describe an unstarted controller', async () => {
    const result = await readCapabilities()
    expect(result.controller.revision).toBe('abcdef123')
    expect(result.features.deviceTelemetry.runtime).toBe('not_ready')
    expect(runtime.readFile).toHaveBeenCalledWith('.git-info', 'utf-8')
  })

  it.each(['null', '{}', '{"commitHash":12}', '{"commitHash":"unknown"}', '{"commitHash":"not a revision"}', 'invalid-json'])('uses unknown revision for invalid build metadata: %s', async (manifest) => {
    runtime.readFile.mockResolvedValue(manifest)
    expect((await readCapabilities()).controller.revision).toBeNull()
  })

  it('survives a missing build manifest', async () => {
    runtime.readFile.mockRejectedValue(new Error('ENOENT'))
    expect((await readCapabilities()).controller.revision).toBeNull()
  })

  it('uses monitor invalidation and existing base reports without control methods', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-25T20:00:00Z'))
    const { parseDeviceStatus } = await import('@/src/hardware/responseParser')
    const { DEVICE_STATUS_POD4 } = await import('@/src/hardware/tests/fixtures')
    const fresh = vi.fn().mockReturnValue(null)
    runtime.monitor.mockReturnValue({ getLastStatus: () => parseDeviceStatus(DEVICE_STATUS_POD4), getLastPollAt: () => Date.now() - 500, getFreshStatus: fresh })
    const result = await readCapabilities()
    expect(result.observations.device.freshness).toBe('stale')
    expect(fresh).toHaveBeenCalledWith(15_000)
  })
})
