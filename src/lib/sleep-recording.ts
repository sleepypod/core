/** Recorded occupancy windows are evidence of bed presence, not time asleep. */
export interface RecordingRow {
  id: number
  enteredBedAt: Date
  leftBedAt: Date | null
  sleepDurationSeconds?: number
  timesExitedBed?: number
}

export interface RecordingWindow { start: Date, end: Date }

/** Union overlapping records; gaps remain unknown and never become stage inputs. */
export function recordingWindows(records: RecordingRow[], now = new Date()): RecordingWindow[] {
  const ordered = records.map(record => ({ start: new Date(record.enteredBedAt), end: record.leftBedAt ? new Date(record.leftBedAt) : now }))
    .filter(window => Number.isFinite(window.start.getTime()) && Number.isFinite(window.end.getTime()) && window.end > window.start)
    .sort((first, second) => first.start.getTime() - second.start.getTime())
  const merged: RecordingWindow[] = []
  for (const window of ordered) {
    const previous = merged.at(-1)
    if (previous && window.start <= previous.end) previous.end = new Date(Math.max(previous.end.getTime(), window.end.getTime()))
    else merged.push({ ...window })
  }
  return merged
}

/** Use the Pod's calendar and a noon rollover, including across DST changes. */
export function sleepNightKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date)
  const part = (name: string) => Number(parts.find(value => value.type === name)?.value)
  const calendar = new Date(Date.UTC(part('year'), part('month') - 1, part('day')))
  if (part('hour') < 12) calendar.setUTCDate(calendar.getUTCDate() - 1)
  return calendar.toISOString().slice(0, 10)
}

/** Select the newest recorded night first; a long older segment must not win. */
export function selectNightRecords<Source extends RecordingRow>(records: Source[], timeZone: string, nightDate?: string): Source[] {
  const usable = records.filter(record => Number.isFinite(new Date(record.enteredBedAt).getTime()))
  const selected = nightDate ?? usable.map(record => sleepNightKey(new Date(record.enteredBedAt), timeZone)).sort().at(-1)
  return usable.filter(record => sleepNightKey(new Date(record.enteredBedAt), timeZone) === selected)
    .sort((first, second) => new Date(first.enteredBedAt).getTime() - new Date(second.enteredBedAt).getTime())
}

export interface SleepRecordingSummary {
  nightDate: string
  recordIds: number[]
  start: number
  end: number
  durationMs: number
  gapsMs: number
  exits: number
}

export function summarizeRecording(records: RecordingRow[], timeZone: string, now = new Date()): SleepRecordingSummary | null {
  const windows = recordingWindows(records, now)
  const first = windows[0], last = windows.at(-1)
  if (!first || !last) return null
  const durationMs = windows.reduce((total, window) => total + window.end.getTime() - window.start.getTime(), 0)
  return {
    nightDate: sleepNightKey(first.start, timeZone), recordIds: [...new Set(records.map(record => record.id))],
    start: first.start.getTime(), end: last.end.getTime(), durationMs,
    gapsMs: last.end.getTime() - first.start.getTime() - durationMs,
    exits: records.reduce((total, record) => total + (record.timesExitedBed ?? 0), 0),
  }
}
