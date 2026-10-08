/** Display-only clock preference. Schedule values and timezone calculations stay HH:mm. */
export type TimeFormat = '12h' | '24h'

export function formatTime(time: string, format: TimeFormat = '12h'): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!match) return time
  const hour = Number(match[1])
  const minute = match[2]
  if (hour > 23 || Number(minute) > 59) return time
  if (format === '24h') return `${String(hour).padStart(2, '0')}:${minute}`
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`
}

export function formatClock(value: Date | number | string | null | undefined, format: TimeFormat = '12h', options: Intl.DateTimeFormatOptions = {}): string {
  if (value == null) return '—'
  return new Date(value).toLocaleTimeString('en-US', {
    minute: format === '12h' && 'hour' in options && !('minute' in options) ? undefined : '2-digit',
    ...options,
    hour: format === '24h' ? '2-digit' : options.hour ?? 'numeric',
    // h23 keeps midnight at 00:00 rather than 24:00.
    hourCycle: format === '24h' ? 'h23' : 'h12',
  })
}

export function formatTick(value: number, format: TimeFormat = '12h'): string {
  const date = new Date(value)
  return formatClock(date, format, { minute: format === '12h' && date.getMinutes() === 0 ? undefined : '2-digit' })
}
