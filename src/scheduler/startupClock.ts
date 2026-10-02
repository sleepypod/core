/**
 * Wait until the system clock is plausible (year >= 2024).
 * The Pod can boot with its clock reset to ~2010 before NTP syncs.
 * Schedulers must not start until the date is valid or cron jobs fire at wrong times.
 */
export async function waitForValidSystemDate(
  maxAttempts: number = 24,
  intervalMs: number = 5_000,
  signal?: AbortSignal,
): Promise<void> {
  const MIN_VALID_YEAR = 2024
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    signal?.throwIfAborted()
    if (new Date().getFullYear() >= MIN_VALID_YEAR) return
    console.warn(
      `System clock is invalid (${new Date().toISOString()}), waiting for NTP sync...`,
      `(${attempt + 1}/${maxAttempts})`
    )
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', cancel)
        resolve()
      }, intervalMs)
      const cancel = () => {
        clearTimeout(timer)
        reject(new Error('Scheduler startup cancelled'))
      }
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }
  console.error(
    'System clock never synced after waiting — proceeding anyway.',
    'Scheduled jobs may fire at incorrect times.'
  )
}
