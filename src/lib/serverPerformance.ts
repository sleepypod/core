import { monitorEventLoopDelay } from 'node:perf_hooks'

interface StartupPhase { name: string, elapsedMs: number, durationMs: number }
const globalState = globalThis as typeof globalThis & {
  __sp_server_performance__?: {
    startedAt: number
    phases: StartupPhase[]
    histogram: ReturnType<typeof monitorEventLoopDelay> | null
    sensorSource: 'pending' | 'raw' | 'nats'
    firstFrameMs: number | null
  }
}
function state() {
  return globalState.__sp_server_performance__ ??= {
    startedAt: performance.now(), phases: [], histogram: null, sensorSource: 'pending', firstFrameMs: null,
  }
}

export function startPerformanceMonitoring(): void {
  const s = state()
  if (s.histogram) return
  s.histogram = monitorEventLoopDelay({ resolution: 20 })
  s.histogram.enable()
}

export function stopPerformanceMonitoring(): void {
  state().histogram?.disable()
}

export function recordStartupPhase(name: string, startedAt = performance.now()): void {
  const s = state()
  if (s.phases.some(phase => phase.name === name)) return
  const phase = {
    name, elapsedMs: Math.round(performance.now() - s.startedAt),
    durationMs: Math.round(performance.now() - startedAt),
  }
  s.phases.push(phase)
  console.log(`[startup] ${name}: ${phase.durationMs}ms (${phase.elapsedMs}ms elapsed)`)
}

export function recordSensorSource(source: 'raw' | 'nats'): void {
  state().sensorSource = source
  recordStartupPhase(`sensor-source-${source}`)
}

export function recordFirstSensorFrame(): void {
  const s = state()
  if (s.firstFrameMs !== null) return
  s.firstFrameMs = Math.round(performance.now() - s.startedAt)
  recordStartupPhase('first-sensor-frame')
}

/** Histogram covers time since instrumentation enabled it, including startup. No database or
 * hardware calls: safe to sample while the other services are starting. */
export function getServerPerformance() {
  const s = state()
  const h = s.histogram
  const ms = (ns: number) => Number.isFinite(ns) ? Math.round(ns / 10_000) / 100 : 0
  return {
    uptimeSeconds: process.uptime(),
    rssBytes: process.memoryUsage.rss(),
    startup: s.phases.slice(),
    sensorSource: s.sensorSource,
    firstFrameMs: s.firstFrameMs,
    eventLoop: { meanMs: ms(h?.mean ?? 0), p95Ms: ms(h?.percentile(95) ?? 0), maxMs: ms(h?.max ?? 0) },
  }
}
