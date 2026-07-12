export const DAYS_OF_WEEK = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]

export function hhmmToMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  if (Number.isNaN(hour) || Number.isNaN(minute)) return Number.NaN
  return hour * 60 + minute
}

export function formatTime12h(time: string): string {
  const [hourStr, minuteStr] = time.split(':')
  const hour = parseInt(hourStr, 10)
  const minute = minuteStr ?? '00'
  if (Number.isNaN(hour)) return time
  const period = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return `${displayHour}:${minute} ${period}`
}

export function calcDuration(onTime: string, offTime: string): string {
  const start = hhmmToMinutes(onTime)
  const end = hhmmToMinutes(offTime)
  if (Number.isNaN(start) || Number.isNaN(end)) return '—'
  let totalMinutes = end - start
  if (totalMinutes < 0) totalMinutes += 24 * 60
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  return `${hours}h ${mins}m`
}

export function isInWindow(nowMinutes: number, start: string, end: string): boolean {
  const startMin = hhmmToMinutes(start)
  const endMin = hhmmToMinutes(end)
  if ([nowMinutes, startMin, endMin].some(Number.isNaN)) return false
  return startMin <= endMin
    ? nowMinutes >= startMin && nowMinutes < endMin
    : nowMinutes >= startMin || nowMinutes < endMin
}

export function getCurrentDay(now: Date = new Date()): DayOfWeek {
  const adjusted = new Date(now)
  if (now.getHours() < 4) {
    adjusted.setDate(adjusted.getDate() - 1)
  }
  return DAYS_OF_WEEK[adjusted.getDay()]
}

export function getCurrentDayForTimezone(timezone: string, now: Date = new Date()): DayOfWeek {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    hourCycle: 'h23',
    hour: '2-digit',
  }).formatToParts(now)
  const weekday = parts.find(p => p.type === 'weekday')?.value.toLowerCase()
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const dayIndex = DAYS_OF_WEEK.findIndex(d => d === weekday)
  if (dayIndex < 0) throw new Error(`Invalid timezone: ${timezone}`)
  if (hour >= 4) return DAYS_OF_WEEK[dayIndex]
  return DAYS_OF_WEEK[(dayIndex + 6) % 7]
}

export function isInWindowForTimezone(
  start: string,
  end: string,
  timezone: string,
  now: Date = new Date(),
): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
  return isInWindow(hour * 60 + minute, start, end)
}
