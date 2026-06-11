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
 */

type Side = 'left' | 'right'

const sideLocks: Record<Side, Promise<void>> = {
  left: Promise.resolve(),
  right: Promise.resolve(),
}

export async function withSideLock<T>(side: Side, fn: () => Promise<T>): Promise<T> {
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
