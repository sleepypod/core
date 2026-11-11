const MAX_CACHED_TIME_ZONES = 64
const shared = globalThis as typeof globalThis & {
  __sp_timeZoneDateFormatters?: Map<string, Intl.DateTimeFormat | null>
}

/** Reuse ICU formatters, not recordings or clock-dependent validation results. */
function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cache = shared.__sp_timeZoneDateFormatters ??= new Map()
  if (cache.has(timeZone)) {
    const formatter = cache.get(timeZone)
    if (formatter) return formatter
    throw new RangeError('Unknown timezone')
  }
  let formatter: Intl.DateTimeFormat | null = null
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  }
  catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
  if (cache.size >= MAX_CACHED_TIME_ZONES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(timeZone, formatter)
  if (!formatter) throw new RangeError('Unknown timezone')
  return formatter
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    dateFormatter(timeZone)
    return true
  }
  catch { return false }
}

export function dateInTimeZone(milliseconds: number, timeZone: string): string {
  const parts = dateFormatter(timeZone).formatToParts(milliseconds)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}
