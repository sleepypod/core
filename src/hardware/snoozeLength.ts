/**
 * How long a snooze lasts. Pure, so the gesture handler and HomeKit switch can
 * use it without pulling in the snooze timers' hardware client.
 */
import type { AlarmConfig } from './alarmPersistence'

/** The shortest a tapered snooze gets. */
export const MIN_SNOOZE_SECONDS = 5

/**
 * Length of the next snooze for the alarm ringing with `config`: the alarm's
 * snooze length (or `fallbackSeconds` for an alarm without one), shortened
 * by its snooze taper for each snooze already taken — 9 min at 30% gives 9,
 * 6.3, 4.4, 3.1 min… — but never under MIN_SNOOZE_SECONDS (or the base
 * length, if that is shorter).
 */
export function nextSnoozeSeconds(config: AlarmConfig, fallbackSeconds = 300): number {
  const fallback = Number.isFinite(fallbackSeconds) && fallbackSeconds > 0 ? Math.min(fallbackSeconds, 1800) : 300
  const base = config.snoozeDuration !== undefined && Number.isFinite(config.snoozeDuration) && config.snoozeDuration > 0 ? Math.min(config.snoozeDuration, 1800) : fallback
  const taper = Number.isFinite(config.snoozeTaper) ? Math.min(Math.max(config.snoozeTaper ?? 0, 0), 90) / 100 : 0
  const taken = Number.isFinite(config.snoozeCount) ? Math.max(Math.floor(config.snoozeCount ?? 0), 0) : 0
  const seconds = Math.round(base * (1 - taper) ** taken)
  return Math.max(seconds, Math.min(base, MIN_SNOOZE_SECONDS))
}
