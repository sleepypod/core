import type { MechanicalKind } from './context'

interface Observer { command: (kind: MechanicalKind, durationMs: number) => void }
const globals = globalThis as typeof globalThis & { __sp_mechanicalObserver?: Observer }

/** Production installs the recorder after migrations, before hardware initialization. */
export function installMechanicalObserver(observer: Observer) {
  if (globals.__sp_mechanicalObserver && globals.__sp_mechanicalObserver !== observer) throw new Error('Mechanical observer already installed')
  globals.__sp_mechanicalObserver = observer
  return () => {
    if (globals.__sp_mechanicalObserver === observer) delete globals.__sp_mechanicalObserver
  }
}

/** Starting interference needs a durable record. Emergency cancellation remains available. */
export function recordMechanicalCommand(kind: MechanicalKind, durationMs = 0, emergency = false) {
  try {
    globals.__sp_mechanicalObserver?.command(kind, durationMs)
  }
  catch (error) {
    if (!emergency) throw error
    console.warn('[biometrics] Could not record cancellation context; await fresh observations before learning.')
  }
}
