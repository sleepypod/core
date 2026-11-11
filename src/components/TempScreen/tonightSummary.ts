import type { ComfortStatus } from '@/src/comfort/contract'

/** A recently fetched plan describes configuration, never proof of an actuator's movement. */
export function currentTonightRead(updatedAt: number, failed: boolean, now: number): boolean {
  return !failed && updatedAt > 0 && Number.isFinite(updatedAt) && updatedAt <= now + 60_000 && now - updatedAt <= 90_000
}

export function personalComfortMode(status: ComfortStatus | undefined, now: number): string {
  if (!status || !Number.isFinite(status.generatedAt) || status.generatedAt > now + 60_000 || now - status.generatedAt > 90_000) return 'Not checked'
  if (!status.state || status.state.config.mode === 'off') return 'Off'
  if (status.state.config.mode === 'preview') return 'Preview · no adjustments'
  if (!status.activation.current) return 'Activation not confirmed'
  if (status.fault || status.runtime !== 'running') return 'Unavailable · check Autopilot'
  if (status.state.pausedUntil > now) return 'Paused after manual control'
  return 'Active · bounded adjustments'
}

export function morningInPodZone(now: number, timeZone: string | undefined): boolean {
  if (!timeZone) return false
  try {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now))
    return hour >= 4 && hour < 13
  }
  catch { return false }
}
