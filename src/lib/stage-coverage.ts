import type { SleepEpoch } from './sleep-stages'

/** Epoch duration estimates cannot extend beyond the requested recording or overlap the next epoch. */
export function stagesWithinWindow(epochs: SleepEpoch[], window: { start: Date, end: Date }): SleepEpoch[] {
  const lower = window.start.getTime(), upper = window.end.getTime()
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) return []
  const ordered = epochs.filter(epoch => Number.isFinite(epoch.start) && Number.isFinite(epoch.duration)
    && epoch.duration > 0 && epoch.start < upper && epoch.start + epoch.duration > lower)
    .sort((first, second) => first.start - second.start)
  return ordered.flatMap((epoch, index) => {
    const start = Math.max(lower, epoch.start)
    const end = Math.min(upper, epoch.start + epoch.duration, ordered[index + 1]?.start ?? upper)
    return end > start ? [{ ...epoch, start, duration: end - start }] : []
  })
}
