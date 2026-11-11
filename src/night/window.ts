import { nightQuerySchema } from './contract'
import { shiftHistoryDate, sourceDate } from '@/src/lib/localDates'

/** Find local noon by calendar comparison, so a DST night remains 23 or 25 hours. */
function localNoon(date: string, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  const key = (at: number) => {
    const parts = formatter.formatToParts(at)
    const part = (name: string) => parts.find(value => value.type === name)?.value ?? ''
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}`
  }
  let lower = Date.parse(`${date}T12:00:00Z`) - 36 * 3600_000
  let upper = lower + 72 * 3600_000
  const wanted = `${date}T12`
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (key(middle) < wanted) lower = middle + 1
    else upper = middle
  }
  if (key(lower) !== wanted) throw new Error('Local noon is unavailable for this date')
  return lower
}

export function nightWindow(timeZone: string, now: number, wakeDate?: string) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Night clock is unavailable')
  const selected = nightQuerySchema.parse({ side: 'left', wakeDate }).wakeDate ?? sourceDate(now / 1000, timeZone)
  const start = localNoon(shiftHistoryDate(selected, -1), timeZone)
  const end = localNoon(selected, timeZone)
  if (start < 0 || start > now || now - end > 30 * 86_400_000 || end - start > 26 * 3600_000 || end <= start) {
    throw new Error('Choose a started night within the last 30 days')
  }
  return { wakeDate: selected, timeZone, start, end, observedThrough: Math.min(now, end) }
}
