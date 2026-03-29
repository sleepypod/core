/**
 * Shared time utility for converting HH:mm strings to Date objects.
 * Used by both the runOnce router and JobManager.
 */

/**
 * Convert an HH:mm time string to a Date for today or tomorrow.
 * If the resulting time is before `referenceDate`, it's assumed to be tomorrow.
 */
export function timeToDate(time: string, timezone: string, referenceDate: Date): Date {
  const [hour, minute] = time.split(':').map(Number)
  const dateStr = referenceDate.toLocaleDateString('en-CA', { timeZone: timezone })
  const candidate = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`)

  const utcStr = candidate.toLocaleString('en-US', { timeZone: 'UTC' })
  const tzStr = candidate.toLocaleString('en-US', { timeZone: timezone })
  const offset = new Date(utcStr).getTime() - new Date(tzStr).getTime()
  if (isNaN(offset)) throw new Error(`Invalid timezone offset for: ${timezone}`)
  const adjusted = new Date(candidate.getTime() + offset)

  if (adjusted <= referenceDate) {
    // Use calendar day increment instead of raw +24h (handles DST correctly)
    const tomorrow = new Date(adjusted)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return tomorrow
  }
  return adjusted
}
