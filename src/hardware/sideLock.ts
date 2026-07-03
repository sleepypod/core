/**
 * Per-side hardware write serialization.
 *
 * Multiple subsystems mutate the same physical side — the scheduler's
 * temperature/power/alarm jobs and the autopilot AutomationEngine. node-schedule
 * fires same-minute jobs in parallel inside the event loop, and the engine ticks
 * independently, so without a shared mutex a temperature command could land
 * after a power-off and re-enable heat. These module-level promise chains
 * serialize every writer for a given side across the whole process.
 *
 * Combined with power-off updating device_state.isPowered before sending
 * hardware, any temp/alarm that acquires the lock after power-off observes
 * isPowered=false and skips.
 *
 * The lock map lives on globalThis: Turbopack can bundle this module into
 * multiple chunks (instrumentation + API routes), and a per-chunk map would
 * silently give each chunk its own "mutex", breaking cross-component write
 * serialization. Same pattern as snoozeManager / pumpStallGuard /
 * dacMonitor.instance.
 */

type Side = 'left' | 'right'

const G = globalThis as Record<string, unknown>
const SIDE_LOCKS_KEY = '__sp_side_locks__'

function getSideLocks(): Record<Side, Promise<void>> {
  let locks = G[SIDE_LOCKS_KEY] as Record<Side, Promise<void>> | undefined
  if (!locks) {
    locks = { left: Promise.resolve(), right: Promise.resolve() }
    G[SIDE_LOCKS_KEY] = locks
  }
  return locks
}

export async function withSideLock<T>(side: Side, fn: () => Promise<T>): Promise<T> {
  const sideLocks = getSideLocks()
  const prev = sideLocks[side]
  let release!: () => void
  sideLocks[side] = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await prev
    return await fn()
  }
  finally {
    release()
  }
}
