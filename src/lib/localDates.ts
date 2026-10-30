import { HISTORY_MAX_RANGE_MS } from '@/src/history/contract'

export function sourceDate(seconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(seconds * 1000)
  const value = (name: string) => parts.find(part => part.type === name)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function shiftHistoryDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Locate the first instant of a source-local date, including short/long DST days. */
export function historyDayStart(value: string, timeZone: string): number {
  const noon = Date.parse(`${value}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(noon) || new Date(noon).toISOString().slice(0, 10) !== value) throw new Error('Invalid date')
  const formatter = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const dateAt = (milliseconds: number) => {
    const parts = formatter.formatToParts(milliseconds)
    const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
    return `${part('year')}-${part('month')}-${part('day')}`
  }
  let lower = noon - 48 * 3_600_000
  let upper = noon + 48 * 3_600_000
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (dateAt(middle) < value) lower = middle + 1
    else upper = middle
  }
  if (dateAt(lower) !== value) throw new Error('This date does not occur in the source time zone')
  return lower
}

export function historyRange(from: string, through: string, timeZone: string): { startTime: string, endTime: string } | null {
  try {
    if (through < from) return null
    const start = historyDayStart(from, timeZone)
    historyDayStart(through, timeZone)
    const end = historyDayStart(shiftHistoryDate(through, 1), timeZone)
    if (start < 0 || end <= start || end - start > HISTORY_MAX_RANGE_MS) return null
    return { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() }
  }
  catch { return null }
}
