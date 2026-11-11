/** Render a recorded instant in its retained zone, independent of the browser clock. */
export function journalWallTime(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(instant)
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`
}

/** Return every matching instant; gaps stay invalid and folds require an explicit choice. */
export function journalWallTimeCandidates(value: string, timeZone: string): number[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return []
  const guess = Date.parse(`${value}:00Z`)
  if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 16) !== value) return []
  try {
    const offsets = new Set<number>()
    for (let hours = -36; hours <= 36; hours += 6) {
      const reference = guess + hours * 3600_000
      offsets.add(Date.parse(`${journalWallTime(reference, timeZone)}:00Z`) - reference)
    }
    return [...offsets].map(offset => guess - offset).filter(instant => journalWallTime(instant, timeZone) === value).sort((first, second) => first - second)
  }
  catch { return [] }
}
