/**
 * Shared time utility for converting HH:mm strings to Date objects.
 * Used by both the runOnce router and JobManager.
 */

/**
 * Resolve a wall-clock Y-M-D H:M in `timezone` to a UTC epoch ms.
 * Uses Intl.DateTimeFormat.formatToParts to extract the timezone offset
 * at that instant, which correctly handles DST boundaries:
 *   - during spring-forward (non-existent local time), the returned instant
 *     falls in the pre-transition offset, i.e. the next valid instant past
 *     the gap (e.g. 02:30 -> 03:30 local on US DST start).
 *   - during fall-back (ambiguous local time), the first occurrence is
 *     returned (pre-transition offset), matching node-schedule's cron behavior.
 */
function zonedWallTimeToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  // Start from a UTC guess, then measure the zone's offset at that instant
  // and correct. One correction is enough when the target wall-clock exists;
  // for the DST spring-forward gap the correction lands in the post-transition
  // offset, which maps to the first valid instant after the gap.
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute)
  const offsetAtGuess = getTimezoneOffsetMs(utcGuess, timezone)
  return utcGuess - offsetAtGuess
}

/**
 * Get the timezone's UTC offset in milliseconds at a given UTC instant.
 * Positive for zones east of UTC, negative for zones west.
 * Throws for invalid timezone identifiers.
 */
function getTimezoneOffsetMs(utcMs: number, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (type: string) => {
    const part = parts.find(p => p.type === type)
    if (!part) throw new Error(`Invalid timezone: ${timezone}`)
    return Number(part.value)
  }
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - utcMs
}

/**
 * Convert an HH:mm time string to a Date for today or tomorrow.
 * If the resulting time is before `referenceDate`, it's assumed to be tomorrow.
 */
export function timeToDate(time: string, timezone: string, referenceDate: Date): Date {
  const [hour, minute] = time.split(':').map(Number)
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error(`Invalid time format: "${time}"`)
  }

  // Extract Y-M-D for the reference date in the target timezone
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate)
  const get = (type: string) => {
    const part = dateParts.find(p => p.type === type)
    if (!part) throw new Error(`Invalid timezone: ${timezone}`)
    return Number(part.value)
  }
  const year = get('year')
  const month = get('month')
  const day = get('day')

  const todayMs = zonedWallTimeToEpochMs(year, month, day, hour, minute, timezone)
  if (todayMs > referenceDate.getTime()) {
    return new Date(todayMs)
  }

  // Otherwise, compute the same wall-clock on the next calendar day in the zone
  const nextDay = new Date(Date.UTC(year, month - 1, day))
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  const tomorrowMs = zonedWallTimeToEpochMs(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    hour,
    minute,
    timezone,
  )
  return new Date(tomorrowMs)
}

/**
 * Compute the current wall-clock hour + minute in a given timezone.
 * Returns values suitable for comparison with scheduled HH:mm times.
 */
export function nowInTimezone(timezone: string, now: Date = new Date()): { hour: number, minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => {
    const part = parts.find(p => p.type === type)
    if (!part) throw new Error(`Invalid timezone: ${timezone}`)
    return Number(part.value)
  }
  return { hour: get('hour'), minute: get('minute') }
}
