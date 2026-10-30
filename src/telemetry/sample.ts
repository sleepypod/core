/** Source time is never refreshed by republishing a cached observation. */
export interface TelemetrySample {
  schemaVersion: 1
  ts: number | null
  expiresAt: number | null
  source: string
  available: boolean
  reason: 'missing' | 'stale' | 'unqualified' | 'privacy_required' | null
  [field: string]: unknown
}

export function sample(source: string, ts: number | null, lifetimeMs: number, now: number,
  values: Record<string, unknown>, qualified = true): TelemetrySample {
  const timed = ts !== null && Number.isSafeInteger(ts) && ts > 0
  const fresh = timed && Number.isFinite(now) && ts <= now && now < ts + lifetimeMs
  const available = fresh && qualified
  return {
    ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, available ? value : null])),
    schemaVersion: 1,
    ts: timed ? ts : null,
    expiresAt: timed ? ts + lifetimeMs : null,
    source, available,
    reason: !timed ? 'missing' : !fresh ? 'stale' : !qualified ? 'unqualified' : null,
  }
}

export function finite(value: unknown, min = -Infinity, max = Infinity): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
}
