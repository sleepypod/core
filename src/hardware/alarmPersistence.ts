/**
 * On-disk record of vibrating alarms and pending snoozes, so a server restart
 * (deploy, crash) in the middle of either picks up where it was instead of
 * silently dropping a snoozed alarm.
 *
 * One small JSON file next to the database (ALARM_STATE_PATH overrides),
 * rewritten atomically (tmp + rename) on every change. Writes are
 * best-effort: a failure is logged and the in-memory state still works for
 * this process. The in-memory copy lives on globalThis (Turbopack can
 * duplicate module instances).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Side } from './types'

export interface AlarmConfig {
  vibrationIntensity: number
  vibrationPattern: 'double' | 'rise'
  /** Vibration length in seconds. */
  duration: number
}

export interface TimedAlarm {
  /** Epoch ms: when the vibration ends, or when the snoozed alarm restarts. */
  until: number
  config: AlarmConfig
}

export interface PersistedAlarmState {
  alarms: Partial<Record<Side, TimedAlarm>>
  snoozes: Partial<Record<Side, TimedAlarm>>
}

const G = globalThis as Record<string, unknown>
const KEY = '__sp_alarm_persisted__'

export function alarmStatePath(): string {
  if (process.env.ALARM_STATE_PATH) return process.env.ALARM_STATE_PATH
  const dbPath = process.env.DATABASE_URL?.replace('file:', '') || './sleepypod.dev.db'
  return join(dirname(dbPath), 'alarm-state.json')
}

function empty(): PersistedAlarmState {
  return { alarms: {}, snoozes: {} }
}

function isTimedAlarm(v: unknown): v is TimedAlarm {
  const t = v as TimedAlarm | null
  return !!t && typeof t.until === 'number' && !!t.config
    && typeof t.config.vibrationIntensity === 'number'
    && (t.config.vibrationPattern === 'double' || t.config.vibrationPattern === 'rise')
    && typeof t.config.duration === 'number'
}

/** Read the file (once per process); a missing or malformed file is empty. */
export function loadAlarmState(): PersistedAlarmState {
  const cached = G[KEY] as PersistedAlarmState | undefined
  if (cached) return cached
  const state = empty()
  try {
    const raw = JSON.parse(readFileSync(alarmStatePath(), 'utf8')) as Partial<PersistedAlarmState>
    for (const group of ['alarms', 'snoozes'] as const) {
      for (const side of ['left', 'right'] as const) {
        const entry = raw[group]?.[side]
        if (isTimedAlarm(entry)) state[group][side] = entry
      }
    }
  }
  catch {
    // No file yet, or unreadable: nothing pending.
  }
  G[KEY] = state
  return state
}

/** Apply `change` to the state and write the file. */
export function updateAlarmState(change: (state: PersistedAlarmState) => void): void {
  const state = loadAlarmState()
  change(state)
  const path = alarmStatePath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, path)
  }
  catch (err) {
    console.error('[alarmState] failed to persist alarm state:', err instanceof Error ? err.message : err)
  }
}

/** Test hook: forget the cached copy so the next load reads the file. */
export function resetAlarmStateCache(): void {
  G[KEY] = undefined
}
