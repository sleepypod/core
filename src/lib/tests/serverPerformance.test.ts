// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const metrics = vi.hoisted(() => ({
  histogram: { enable: vi.fn(), disable: vi.fn(), mean: 1_250_000, max: 4_567_890, percentile: vi.fn(() => 2_345_678) },
  monitorEventLoopDelay: vi.fn(),
}))
vi.mock('node:perf_hooks', () => ({ monitorEventLoopDelay: metrics.monitorEventLoopDelay }))

import {
  getServerPerformance, recordFirstSensorFrame, recordSensorSource, recordStartupPhase,
  startPerformanceMonitoring, stopPerformanceMonitoring,
} from '../serverPerformance'

let now = 0
beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__sp_server_performance__
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  metrics.monitorEventLoopDelay.mockReset().mockReturnValue(metrics.histogram)
  metrics.histogram.enable.mockClear()
  metrics.histogram.disable.mockClear()
  metrics.histogram.percentile.mockClear()
  metrics.histogram.mean = 1_250_000
})
afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__sp_server_performance__
})

describe('server performance telemetry', () => {
  it('reports safe empty values before monitoring starts', () => {
    expect(getServerPerformance()).toMatchObject({
      startup: [], sensorSource: 'pending', firstFrameMs: null,
      eventLoop: { meanMs: 0, p95Ms: 0, maxMs: 0 },
    })
    expect(metrics.monitorEventLoopDelay).not.toHaveBeenCalled()
  })

  it('records each startup phase and the first sensor frame only once', () => {
    startPerformanceMonitoring()
    now = 125
    recordStartupPhase('migrations', 5)
    now = 180
    recordStartupPhase('migrations', 130)
    recordSensorSource('nats')
    now = 225
    recordFirstSensorFrame()
    now = 450
    recordFirstSensorFrame()

    expect(getServerPerformance()).toMatchObject({
      sensorSource: 'nats', firstFrameMs: 225,
      startup: [
        { name: 'migrations', elapsedMs: 125, durationMs: 120 },
        { name: 'sensor-source-nats', elapsedMs: 180, durationMs: 0 },
        { name: 'first-sensor-frame', elapsedMs: 225, durationMs: 0 },
      ],
    })
  })

  it('shares one histogram across module instances and converts nanoseconds to milliseconds', async () => {
    startPerformanceMonitoring()
    vi.resetModules()
    const duplicate = await import('../serverPerformance')
    duplicate.startPerformanceMonitoring()
    expect(metrics.monitorEventLoopDelay).toHaveBeenCalledOnce()
    expect(metrics.histogram.enable).toHaveBeenCalledOnce()
    expect(getServerPerformance().eventLoop).toEqual({ meanMs: 1.25, p95Ms: 2.35, maxMs: 4.57 })
    metrics.histogram.mean = NaN
    expect(getServerPerformance().eventLoop.meanMs).toBe(0)
    stopPerformanceMonitoring()
    expect(metrics.histogram.disable).toHaveBeenCalledOnce()
  })
})
