'use client'

import { TimeInput } from './TimeInput'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Loader2, Play, Square, Trash2 } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, DayPicker, InlineError, Modal, Pill, SegmentedControl, Slider, Stepper } from '@/src/components/ds'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { useSingleSleeperSide, type SideSelection } from '@/src/providers/SideProvider'
import type { DayOfWeek } from '@/src/lib/scheduleTime'

import { displayToSetpointF, setpointFToDisplay } from '@/src/lib/tempUtils'
import { FIXED_INTENSITY, FIXED_PATTERN } from '@/src/lib/vibrationPatterns'
import { nextSnoozeSeconds } from '@/src/hardware/snoozeLength'
import type { AlarmGroup } from './AlarmCard'
import { DAY_ORDER, DAY_PICKER_LABELS, WEEKDAYS, WEEKENDS, daysToIndexes, indexesToDays, sameDays } from './scheduleFormat'

type Side = 'left' | 'right'
type Pattern = 'rise' | 'double'

interface AlarmEditorProps {
  open: boolean
  onClose: () => void
  /** Side whose alarms are listed (an existing group belongs to it). */
  side: Side
  /** Side selection a new alarm starts with. */
  defaultSide?: SideSelection
  /** When provided, editor opens in edit mode for this group. */
  existingGroup?: AlarmGroup | null
  /** Called after a successful save so the parent can refetch. */
  onSaved?: () => void
  /** Delete goes through the parent's confirmation dialog. */
  onRequestDelete?: (group: AlarmGroup) => void
}

const DEFAULT_TIME = '07:00'
const DEFAULT_DURATION = 30
const DEFAULT_TEMP = 75
const MIN_DURATION = 10
const MAX_DURATION = 180

const MIN_TEMP = 55
const MAX_TEMP = 110

const WAKE_WINDOW_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '10', label: '10' },
  { value: '15', label: '15' },
  { value: '20', label: '20' },
  { value: '30', label: '30 min' },
] as const
type WakeWindowOption = typeof WAKE_WINDOW_OPTIONS[number]['value']

const DEFAULT_SNOOZE_MINUTES = 5
const MAX_SNOOZE_MINUTES = 30

const SNOOZE_TAPER_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '30', label: '30' },
  { value: '40', label: '40' },
  { value: '50', label: '50' },
  { value: '60', label: '60%' },
] as const
type SnoozeTaperOption = typeof SNOOZE_TAPER_OPTIONS[number]['value']

/** "9, 6.3, 4.4, 3.1 min": the first snoozes of an alarm with this taper. */
export function snoozeTaperPreview(minutes: number, taper: number, count = 4): string {
  const lengths = Array.from({ length: count }, (_, snoozeCount) =>
    Math.round(nextSnoozeSeconds({ vibrationIntensity: 0, vibrationPattern: 'rise', duration: 0, snoozeDuration: minutes * 60, snoozeTaper: taper, snoozeCount }) / 6) / 10)
  return `${lengths.join(', ')} min`
}

const QUICK_PICKS: Array<{ label: string, days: DayOfWeek[] }> = [
  { label: 'Weekdays', days: WEEKDAYS },
  { label: 'Weekends', days: WEEKENDS },
  { label: 'Every day', days: DAY_ORDER },
]

/** `HH:mm` moved by `minutes`, wrapping around midnight. */
function shiftTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const t = (((h * 60 + m + minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/**
 * Alarm editor (Dialog on desktop, Sheet on phones).
 * - Each saved alarm produces one row per selected day × side (same time/pattern/intensity/duration/temp).
 * - "Test" fires `device.setAlarm` immediately so the user can feel it; "Stop" clears it.
 * - Saves as you go: SAVE_DELAY_MS after the last change (at once on Done or
 *   close), delete-then-create — the previous save's rows are replaced by new
 *   ones. Saves run one at a time, each replacing the rows the last created,
 *   so an edit the user never confirms can't be lost. A new alarm is first
 *   saved once it has a day. Saving an edit turns a paused alarm back on.
 */
/** Quiet time after the last change before it is saved. */
export const SAVE_DELAY_MS = 600

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

/** One opened alarm's saves. Each load starts a new one, so a save still
 * running for the previous alarm can't touch the rows of the next. */
interface SaveSession {
  /** Rows the alarm has now: the group's when opened, then whatever the
   * last save created. Every save replaces exactly these. */
  rowIds: number[]
  /** Every set of rows this session created, so a refetch still showing an
   * earlier save's rows isn't taken for a different alarm. */
  ownKeys: Set<string>
  /** The draft last saved (JSON), so an unchanged form isn't saved again. */
  saved: string | null
  /** The draft last queued (JSON), so a change isn't queued twice. */
  queued: string | null
  failed: boolean
}

const rowKey = (ids: number[]) => `edit:${[...ids].sort((a, b) => a - b).join(',')}`
const newSession = (rowIds: number[]): SaveSession => ({ rowIds, ownKeys: new Set(), saved: null, queued: null, failed: false })

export function AlarmEditor({
  open,
  onClose,
  side,
  defaultSide = side,
  existingGroup = null,
  onSaved,
  onRequestDelete,
}: AlarmEditorProps) {
  const { formatTime, timeFormat } = useTimeFormatter()
  const isEdit = existingGroup !== null
  const { unit } = useTemperatureUnit()
  const { leftName, rightName } = useSideNames()
  // One side away: alarms go on the sleeper's side, no side picker.
  const singleSleeperSide = useSingleSleeperSide()
  const minDisplayTemp = Math.round(setpointFToDisplay(MIN_TEMP, unit) ?? MIN_TEMP)
  const maxDisplayTemp = Math.round(setpointFToDisplay(MAX_TEMP, unit) ?? MAX_TEMP)
  const defaultDisplayTemp = Math.round(setpointFToDisplay(DEFAULT_TEMP, unit) ?? DEFAULT_TEMP)

  const [days, setDays] = useState<Set<DayOfWeek>>(new Set())
  const [time, setTime] = useState(DEFAULT_TIME)
  const [targetSide, setTargetSide] = useState<SideSelection>(defaultSide)
  const [pattern, setPattern] = useState<Pattern>(FIXED_PATTERN)
  const [intensity, setIntensity] = useState(FIXED_INTENSITY)
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [displayTemperature, setDisplayTemperature] = useState(defaultDisplayTemp)
  const [wakeWindow, setWakeWindow] = useState(0)
  const [snoozeDuration, setSnoozeDuration] = useState(DEFAULT_SNOOZE_MINUTES * 60)
  const snoozeMinutes = snoozeDuration / 60
  const [snoozeTaper, setSnoozeTaper] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [testing, setTesting] = useState(false)
  // Done was pressed on a saved alarm with every day cleared.
  const [needsDay, setNeedsDay] = useState(false)

  const session = useRef<SaveSession>(newSession([]))
  // Saves run one at a time, in order.
  const queue = useRef<Promise<void>>(Promise.resolve())
  // Bumped each time the form loads; the render showing that load is the
  // saved state, not an edit.
  const [loadGeneration, setLoadGeneration] = useState(0)
  const baselineGeneration = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Load the form when it opens, or when a different alarm is passed in. Not
  // on every new `existingGroup` object: callers rebuild it on each render
  // (the home screen re-renders with every status update), and after each
  // save the group comes back with the rows that save created — neither may
  // reset an edit in progress.
  const loadedFrom = useRef<string | null>(null)
  useEffect(() => {
    const source = !open ? null : existingGroup ? rowKey(existingGroup.ids) : 'new'
    if (source === loadedFrom.current) return
    if (source !== null && loadedFrom.current !== null && session.current.ownKeys.has(source)) {
      loadedFrom.current = source
      return
    }
    loadedFrom.current = source
    if (source === null) return
    session.current = newSession(existingGroup?.ids ?? [])
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoadGeneration(g => g + 1)
    if (existingGroup) {
      setDays(new Set(existingGroup.days))
      setTime(existingGroup.time)
      setTargetSide(side)
      setPattern(existingGroup.vibrationPattern)
      setIntensity(existingGroup.vibrationIntensity)
      setDuration(existingGroup.duration)
      setDisplayTemperature(Math.round(setpointFToDisplay(existingGroup.alarmTemperature, unit) ?? existingGroup.alarmTemperature))
      setWakeWindow(existingGroup.wakeWindow)
      setSnoozeDuration(existingGroup.snoozeDuration)
      setSnoozeTaper(existingGroup.snoozeTaper)
    }
    else {
      setDays(new Set())
      setTime(DEFAULT_TIME)
      setTargetSide(defaultSide)
      setPattern(FIXED_PATTERN)
      setIntensity(FIXED_INTENSITY)
      setDuration(DEFAULT_DURATION)
      setDisplayTemperature(defaultDisplayTemp)
      setWakeWindow(0)
      setSnoozeDuration(DEFAULT_SNOOZE_MINUTES * 60)
      setSnoozeTaper(0)
    }
    setSaveError(null)
    setSaveState('idle')
    setTesting(false)
    setNeedsDay(false)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, existingGroup, side, defaultSide, unit, defaultDisplayTemp])

  const batchUpdate = trpc.schedules.batchUpdate.useMutation()
  const testAlarm = trpc.device.setAlarm.useMutation()
  const clearAlarm = trpc.device.clearAlarm.useMutation()
  const utils = trpc.useUtils()

  const sides = useMemo<Side[]>(
    () => (singleSleeperSide ? [singleSleeperSide] : targetSide === 'both' ? ['left', 'right'] : [targetSide]),
    [singleSleeperSide, targetSide],
  )

  const handleTest = useCallback(async () => {
    try {
      await Promise.all(sides.map(s => testAlarm.mutateAsync({ side: s, vibrationIntensity: intensity, vibrationPattern: pattern, duration })))
      setTesting(true)
    }
    catch {
      // testAlarm.error renders below
    }
  }, [testAlarm, sides, intensity, pattern, duration])

  const handleStopTest = useCallback(() => {
    for (const s of sides) clearAlarm.mutate({ side: s })
    setTesting(false)
  }, [clearAlarm, sides])

  // What the form would save now, or null while it has no day to save.
  const draft = useMemo(() => {
    if (days.size === 0) return null
    const temperatureF = Math.round(displayToSetpointF(displayTemperature, unit) ?? DEFAULT_TEMP)
    return sides.flatMap(s => Array.from(days).map(dayOfWeek => ({
      side: s,
      dayOfWeek,
      time,
      vibrationIntensity: intensity,
      vibrationPattern: pattern,
      duration,
      alarmTemperature: temperatureF,
      wakeWindow,
      snoozeDuration,
      snoozeTaper,
    })))
  }, [days, sides, time, intensity, pattern, duration, displayTemperature, wakeWindow, snoozeDuration, snoozeTaper, unit])

  const { mutateAsync } = batchUpdate

  const save = useCallback((rows: NonNullable<typeof draft>) => {
    const saving = session.current
    const isCurrent = () => saving === session.current
    const snapshot = JSON.stringify(rows)
    saving.queued = snapshot
    queue.current = queue.current.then(async () => {
      // Compared when its turn comes, after the saves queued before it.
      if (snapshot === saving.saved) {
        // Back to what is saved: nothing is left unsaved, even if a save in
        // between failed.
        saving.failed = false
        if (isCurrent()) {
          setSaveError(null)
          setSaveState(state => (state === 'idle' ? state : 'saved'))
        }
        return
      }
      if (isCurrent()) setSaveState('saving')
      try {
        const result = await mutateAsync({
          deletes: { alarm: saving.rowIds },
          // Changing a paused alarm means it should ring again.
          creates: { alarm: rows.map(r => ({ ...r, enabled: true })) },
        })
        saving.rowIds = result?.created?.alarm ?? []
        saving.ownKeys.add(rowKey(saving.rowIds))
        saving.saved = snapshot
        saving.failed = false
        if (isCurrent()) {
          setSaveError(null)
          setSaveState('saved')
        }
        void utils.schedules.getAll.invalidate()
        void utils.schedules.getByDay.invalidate()
        onSaved?.()
      }
      catch (err) {
        saving.failed = true
        if (isCurrent()) {
          setSaveError(err instanceof Error ? err.message : 'Failed to save alarm')
          setSaveState('error')
        }
      }
    })
    return queue.current
  }, [mutateAsync, utils, onSaved])

  // Save each change once the user pauses. The first draft after the form
  // loads is what an existing alarm already has saved.
  useEffect(() => {
    if (!open) return
    if (baselineGeneration.current !== loadGeneration) {
      baselineGeneration.current = loadGeneration
      const baseline = existingGroup && draft ? JSON.stringify(draft) : null
      session.current.saved = baseline
      session.current.queued = baseline
      return
    }
    if (!draft || JSON.stringify(draft) === session.current.queued) return

    setSaveState('pending')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void save(draft)
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer.current)
  }, [open, draft, save, existingGroup, loadGeneration])

  // The latest draft, for saves that wait on earlier ones.
  const latestDraft = useRef(draft)
  useEffect(() => {
    latestDraft.current = draft
  }, [draft])

  /** Save the form now (Done, close, delete), including changes made while it saves. */
  const flush = useCallback(async () => {
    let rows: typeof draft
    do {
      rows = latestDraft.current
      clearTimeout(timer.current)
      await (rows ? save(rows) : queue.current)
    } while (JSON.stringify(rows) !== JSON.stringify(latestDraft.current))
  }, [save])

  // Closing saves the form first. A failed save keeps the editor open with
  // its error rather than dropping the change, and a saved alarm can't be
  // left with no day (it would keep its old days without saying so).
  const handleClose = useCallback(async () => {
    await flush()
    if (session.current.failed) return
    if (!latestDraft.current && session.current.rowIds.length > 0) {
      setNeedsDay(true)
      return
    }
    onClose()
  }, [flush, onClose])

  const handleDelete = useCallback(async () => {
    if (!existingGroup || !onRequestDelete) return
    await flush()
    onRequestDelete({ ...existingGroup, ids: session.current.rowIds })
  }, [existingGroup, onRequestDelete, flush])

  const clock = formatTime(time)
  const [clockDigits, clockPeriod] = clock.split(' ')

  return (
    <Modal
      open={open}
      onClose={() => void handleClose()}
      title={isEdit ? 'Edit alarm' : 'New alarm'}
      icon={Bell}
      iconClassName="text-warn"
      width={520}
      footer={(
        <>
          {testing
            ? (
                <Button icon={Square} onClick={handleStopTest} disabled={clearAlarm.isPending}>Stop</Button>
              )
            : (
                <Button icon={Play} onClick={() => void handleTest()} disabled={testAlarm.isPending}>Test</Button>
              )}
          {isEdit && existingGroup && onRequestDelete && (
            <Button variant="danger" icon={Trash2} onClick={() => void handleDelete()}>
              Delete
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2.5">
            <span className="text-xs text-fg-3" aria-live="polite">
              {saveState === 'saving' || saveState === 'pending'
                ? (
                    <>
                      <Loader2 size={12} className="mr-1 inline animate-spin" />
                      Saving…
                    </>
                  )
                : saveState === 'saved' ? 'Saved' : days.size === 0 ? 'Pick a day to save' : ''}
            </span>
            <Button variant="primary" onClick={() => void handleClose()}>Done</Button>
          </div>
        </>
      )}
    >
      <div className="flex flex-wrap items-end gap-3.5">
        {timeFormat === '24h'
          ? <TimeInput label="Wake at" value={time} onChange={setTime} />
          : (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-fg-2">Wake at</span>
                {/* Big mono readout; an invisible native time input on top opens the OS picker. */}
                <span className="relative rounded-ctl focus-within:outline focus-within:outline-1 focus-within:outline-offset-4 focus-within:outline-fg-3">
                  <span className="font-mono text-[44px] font-light leading-none" aria-hidden>
                    {clockDigits}
                    <span className="text-xl text-fg-2">{` ${clockPeriod ?? ''}`}</span>
                  </span>
                  <input
                    type="time"
                    aria-label="Wake at"
                    value={time}
                    onChange={e => e.target.value && setTime(e.target.value)}

                    className="absolute inset-0 m-0 w-full min-w-0 cursor-pointer appearance-none opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:m-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:p-0"
                  />
                </span>
              </label>
            )}
        {!singleSleeperSide && (
          <SegmentedControl
            className="ml-auto"
            ariaLabel="Alarm side"
            value={targetSide}
            onChange={setTargetSide}
            options={[
              { value: 'left', label: leftName },
              { value: 'right', label: rightName },
              { value: 'both', label: 'Both' },
            ]}
          />
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-xs text-fg-2">Repeat</span>
        <DayPicker
          value={daysToIndexes(days)}
          onChange={v => setDays(new Set(indexesToDays(v)))}
          labels={DAY_PICKER_LABELS}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-fg-2">Quick pick</span>
          {QUICK_PICKS.map(q => (
            <Pill key={q.label} selected={sameDays(days, q.days)} onClick={() => setDays(new Set(q.days))}>
              {q.label}
            </Pill>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1 text-sm">Wake window</span>
          <SegmentedControl<WakeWindowOption>
            size="sm"
            ariaLabel="Wake window"
            value={String(wakeWindow) as WakeWindowOption}
            onChange={v => setWakeWindow(Number(v))}
            options={WAKE_WINDOW_OPTIONS}
          />
        </div>
        <span className="text-xs leading-[1.4] text-fg-3">
          {wakeWindow > 0
            ? `Wakes you up to ${wakeWindow} min early, the first time you move after ${formatTime(shiftTime(time, -wakeWindow))}. Otherwise it goes off at ${clock}.`
            : 'Goes off at the set time.'}
        </span>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <span className="text-xs text-fg-2">Snooze</span>
        <div className="flex items-center gap-3">
          <span className="flex-1 text-sm">Snooze for</span>
          <Stepper
            value={snoozeMinutes}
            onChange={minutes => setSnoozeDuration(Math.round(minutes * 60))}
            min={1}
            max={MAX_SNOOZE_MINUTES}
            format={v => `${v} min`}
            label="snooze length"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1 whitespace-nowrap text-sm">Snooze taper</span>
          <SegmentedControl<SnoozeTaperOption>
            size="sm"
            ariaLabel="Snooze taper"
            value={String(snoozeTaper) as SnoozeTaperOption}
            onChange={v => setSnoozeTaper(Number(v))}
            options={SNOOZE_TAPER_OPTIONS}
          />
        </div>
        <span className="text-xs leading-[1.4] text-fg-3">
          {snoozeTaper > 0
            ? `Each snooze is ${snoozeTaper}% shorter than the last, so you ease out of bed instead of drifting back off: ${snoozeTaperPreview(snoozeMinutes, snoozeTaper)}…`
            : `Every snooze lasts ${snoozeMinutes} min. Snooze taper makes each one shorter than the last.`}
        </span>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <span className="text-xs text-fg-2">Vibration</span>
        <div className="flex items-center gap-3">
          <span className="w-[76px] shrink-0 text-sm">Pattern</span>
          <SegmentedControl
            ariaLabel="Vibration pattern"
            value={pattern}
            onChange={setPattern}
            options={[{ value: 'rise', label: 'Rise' }, { value: 'double', label: 'Double' }]}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="w-[76px] shrink-0 text-sm">Intensity</span>
          <Slider value={intensity} onChange={setIntensity} min={1} max={100} label="Vibration intensity" />
          <span className="w-9 text-right font-mono text-xs">{`${intensity}%`}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-[76px] shrink-0 text-sm">Duration</span>
          <Slider value={duration} onChange={setDuration} min={MIN_DURATION} max={MAX_DURATION} label="Vibration duration" />
          <span className="w-9 text-right font-mono text-xs">{`${duration} s`}</span>
        </div>
        <span className="text-xs leading-[1.4] text-fg-3">
          Pod 5 covers ignore pattern and intensity — duration is what you feel.
        </span>
      </div>

      <div className="flex items-center gap-3 border-t border-line pt-3.5">
        <span className="flex-1 text-sm">Bed temperature at wake</span>
        <Stepper
          value={displayTemperature}
          onChange={setDisplayTemperature}
          min={minDisplayTemp}
          max={maxDisplayTemp}
          label="bed temperature at wake"
        />
      </div>

      {testAlarm.error && <InlineError>{testAlarm.error.message}</InlineError>}
      {saveError && <InlineError>{saveError}</InlineError>}
      {needsDay && days.size === 0 && <InlineError>Pick at least one day, or delete the alarm.</InlineError>}
    </Modal>
  )
}
