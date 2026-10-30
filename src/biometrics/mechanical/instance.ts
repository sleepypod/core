import { db, biometricsDb } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { getBaseControllerIfRunning } from '@/src/hardware/base/instance'
import { MECHANICAL_FRESH_MS } from './context'
import { installMechanicalObserver } from './dispatch'
import { MechanicalStore } from './store'

const globals = globalThis as typeof globalThis & { __sp_mechanicalRuntime?: { stop: () => void } }

/** Observe existing hardware only. Missing telemetry is unknown, including an unconfigured base. */
export function startMechanicalContext() {
  if (globals.__sp_mechanicalRuntime) return
  const store = new MechanicalStore(biometricsDb.$client)
  let stopped = false, failed = false
  const sample = () => {
    const now = Date.now()
    try {
      const monitor = getDacMonitorIfRunning()
      const status = monitor?.getFreshStatus(MECHANICAL_FRESH_MS)
      const base = getBaseControllerIfRunning()?.status()
      const states = db.select().from(deviceState).all()
      const alarmKnown = states.length === 2 && ['left', 'right'].every(side => states.some(row => row.side === side))
        && states.every(row => typeof row.isAlarmVibrating === 'boolean')
      store.observe({ now, deviceAt: status ? monitor?.getLastPollAt() ?? null : null,
        priming: status?.isPriming ?? null,
        // Firmware has no vibration sensor. This is command-derived evidence.
        vibrationCommandActive: alarmKnown ? states.some(row => row.isAlarmVibrating) : null,
        baseAt: base?.state === 'connected' && !base.stale ? base.lastUpdate : null,
        baseMoving: base?.busy ? true : base?.moving ?? null })
      failed = false
    }
    catch {
      store.invalidate(now)
      if (!failed) console.warn('[biometrics] Mechanical context unavailable; withholding affected estimates.')
      failed = true
    }
  }
  installMechanicalObserver({ command(kind, durationMs) {
    try {
      if (stopped) throw new Error('Mechanical context has stopped')
      store.command(kind, Date.now(), durationMs)
    }
    catch (error) {
      store.invalidate(Date.now(), Math.max(durationMs, 180_000))
      throw error
    }
  } })
  sample()
  const timer = setInterval(sample, 1000)
  timer.unref?.()
  globals.__sp_mechanicalRuntime = { stop() {
    stopped = true
    clearInterval(timer)
    store.stop(Date.now())
    // Keep the stopped recorder installed: new interference fails closed.
  } }
}

export function stopMechanicalContext() {
  globals.__sp_mechanicalRuntime?.stop()
}
