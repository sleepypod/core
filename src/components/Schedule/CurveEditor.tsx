'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Snowflake, Scale, Flame, X, Minus, Moon, Sun, Loader2, Sparkles } from 'lucide-react'
import clsx from 'clsx'
import { AICurveWizard } from './AICurveWizard'
import { CurveChart } from './CurveChart'
import { SetPointCard } from './SetPointCard'
import { SetPointEditor } from './SetPointEditor'
import { TimeInput } from './TimeInput'
import { DAYS, type DayOfWeek } from './DaySelector'
import { useSchedule } from '@/src/hooks/useSchedule'
import type { SchedulePhase } from '@/src/hooks/useSchedules'
import type { CurvePoint, CoolingIntensity } from '@/src/lib/sleepCurve/types'
import {
  generateSleepCurve,
  curveToScheduleTemperatures,
  timeStringToMinutes,
} from '@/src/lib/sleepCurve/generate'
import { sortChronological } from '@/src/lib/scheduleGrouping'

interface CurveEditorProps {
  open: boolean
  onClose: () => void
  /** When provided, editor opens in edit mode for the existing curve. */
  initialDays?: DayOfWeek[]
  /** Initial set points. Empty array = create mode with empty list. */
  initialSetPoints?: Array<{ time: string, temperature: number }>
}

interface LocalSetPoint {
  localId: number
  time: string
  temperature: number
}

interface PresetDef {
  id: CoolingIntensity
  label: string
  icon: typeof Snowflake
}

const PRESETS: PresetDef[] = [
  { id: 'cool', label: 'Hot Sleeper', icon: Snowflake },
  { id: 'balanced', label: 'Balanced', icon: Scale },
  { id: 'warm', label: 'Cold Sleeper', icon: Flame },
]

const DEFAULT_BEDTIME = '22:00'
const DEFAULT_WAKE = '07:00'
const DEFAULT_MIN_TEMP = 68
const DEFAULT_MAX_TEMP = 86
const TEMP_FLOOR = 55
const TEMP_CEIL = 110

function toPhase(point: LocalSetPoint): SchedulePhase {
  return {
    id: point.localId,
    name: '',
    icon: 'moon',
    time: point.time,
    temperature: point.temperature,
    enabled: true,
  }
}

function buildCurveData(points: LocalSetPoint[]) {
  if (points.length === 0) return null
  const sorted = [...points].sort((a, b) => a.time.localeCompare(b.time))
  const temps = sorted.map(p => p.temperature)
  const min = Math.min(...temps)
  const max = Math.max(...temps)
  const btMin = timeStringToMinutes(sorted[0].time)

  const curvePoints: CurvePoint[] = sorted.map((p, i) => {
    let tMin = timeStringToMinutes(p.time) - btMin
    if (tMin < -120) tMin += 24 * 60
    const frac = sorted.length > 1 ? i / (sorted.length - 1) : 0
    const phase
      = frac < 0.1
        ? ('warmUp' as const)
        : frac < 0.25
          ? ('coolDown' as const)
          : frac < 0.55
            ? ('deepSleep' as const)
            : frac < 0.75
              ? ('maintain' as const)
              : frac < 0.9
                ? ('preWake' as const)
                : ('wake' as const)
    return { minutesFromBedtime: tMin, tempOffset: p.temperature - 80, phase }
  }).sort((a, b) => a.minutesFromBedtime - b.minutesFromBedtime)

  return { points: curvePoints, bedtimeMinutes: btMin, minTempF: min, maxTempF: max }
}

/**
 * Full-screen editor for creating or editing a curve.
 * Local state until "Save" — then writes via `useSchedule.saveCurve` (one batch).
 */
export function CurveEditor({
  open,
  onClose,
  initialDays = [],
  initialSetPoints = [],
}: CurveEditorProps) {
  const { saveCurve, detectCurveConflicts, isMutating } = useSchedule()

  const isEdit = initialDays.length > 0
  const initialSorted = useMemo(() => sortChronological(initialSetPoints), [initialSetPoints])
  const initialBedtime = initialSorted[0]?.time ?? DEFAULT_BEDTIME
  const initialWake = initialSorted[initialSorted.length - 1]?.time ?? DEFAULT_WAKE
  const initialMinTemp = initialSetPoints.length > 0
    ? Math.min(...initialSetPoints.map(p => p.temperature))
    : DEFAULT_MIN_TEMP
  const initialMaxTemp = initialSetPoints.length > 0
    ? Math.max(...initialSetPoints.map(p => p.temperature))
    : DEFAULT_MAX_TEMP

  const [days, setDays] = useState<Set<DayOfWeek>>(new Set(initialDays))
  const [points, setPoints] = useState<LocalSetPoint[]>(() =>
    initialSetPoints.map((p, i) => ({ localId: -(i + 1), time: p.time, temperature: p.temperature })),
  )
  const [bedtime, setBedtime] = useState(initialBedtime)
  const [wakeTime, setWakeTime] = useState(initialWake)
  const [minTemp, setMinTemp] = useState(initialMinTemp)
  const [maxTemp, setMaxTemp] = useState(initialMaxTemp)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pendingConflict, setPendingConflict] = useState<DayOfWeek[] | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [aiWizardOpen, setAIWizardOpen] = useState(false)
  const idCounter = useRef(-1000)

  // Reset state when opening (avoid stale state from previous open)
  useEffect(() => {
    if (!open) return
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setDays(new Set(initialDays))

    setPoints(initialSetPoints.map((p, i) => ({ localId: -(i + 1), time: p.time, temperature: p.temperature })))

    setBedtime(initialBedtime)

    setWakeTime(initialWake)

    setMinTemp(initialMinTemp)

    setMaxTemp(initialMaxTemp)

    setEditorOpen(false)

    setEditingId(null)

    setPendingConflict(null)

    setSaveError(null)

    setAIWizardOpen(false)
  }, [open, initialDays, initialSetPoints, initialBedtime, initialWake, initialMinTemp, initialMaxTemp])

  // Lock body scroll when open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const curveData = useMemo(() => buildCurveData(points), [points])

  // Phases sorted chronologically (handles overnight wrap), with auto-on/off
  // labels for the first and last entries so the user knows which point drives
  // the Pod's auto power-on and auto power-off times.
  const orderedPhases = useMemo(() => {
    const sorted = sortChronological(points.map(p => ({ time: p.time, temperature: p.temperature })))
    return sorted.map((sp) => {
      const original = points.find(p => p.time === sp.time && p.temperature === sp.temperature)
      return original
    }).filter((p): p is LocalSetPoint => p !== undefined).map(p => toPhase(p))
  }, [points])

  const autoOnId = orderedPhases[0]?.id ?? null
  const autoOffId = orderedPhases.length > 1 ? orderedPhases[orderedPhases.length - 1].id : null

  const toggleDay = useCallback((day: DayOfWeek) => {
    setDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }, [])

  const handleAddPoint = useCallback(() => {
    setEditingId(null)
    setEditorOpen(true)
  }, [])

  const handleEditPoint = useCallback((phase: SchedulePhase) => {
    setEditingId(phase.id)
    setEditorOpen(true)
  }, [])

  const handleAdjustTemp = useCallback((id: number, delta: number) => {
    setPoints(prev => prev.map(p =>
      p.localId === id
        ? { ...p, temperature: Math.max(55, Math.min(110, p.temperature + delta)) }
        : p,
    ))
  }, [])

  const handleDeletePoint = useCallback((id: number) => {
    setPoints(prev => prev.filter(p => p.localId !== id))
  }, [])

  const handleEditorCreate = useCallback((time: string, temperature: number) => {
    const newId = idCounter.current--
    setPoints(prev => [...prev, { localId: newId, time, temperature }])
  }, [])

  const handleEditorUpdate = useCallback(
    (id: number, updates: { time?: string, temperature?: number }) => {
      setPoints(prev => prev.map(p =>
        p.localId === id
          ? { ...p, ...updates }
          : p,
      ))
    },
    [],
  )

  const handleEditorDelete = useCallback((id: number) => {
    handleDeletePoint(id)
  }, [handleDeletePoint])

  const handleApplyAICurve = useCallback((config: {
    setPoints: Array<{ time: string, temperature: number }>
    bedtime: string
    wakeTime: string
  }) => {
    const next: LocalSetPoint[] = config.setPoints.map((sp, i) => ({
      localId: -(i + 1),
      time: sp.time,
      temperature: Math.round(Math.max(TEMP_FLOOR, Math.min(TEMP_CEIL, sp.temperature))),
    }))
    setPoints(next)
    setBedtime(config.bedtime)
    setWakeTime(config.wakeTime)
    const temps = next.map(p => p.temperature)
    if (temps.length > 0) {
      setMinTemp(Math.min(...temps))
      setMaxTemp(Math.max(...temps))
    }
  }, [])

  const handleApplyPreset = useCallback((preset: PresetDef) => {
    const bedtimeMinutes = timeStringToMinutes(bedtime)
    const wakeMinutes = timeStringToMinutes(wakeTime)
    const curvePoints = generateSleepCurve({
      bedtimeMinutes,
      wakeMinutes,
      intensity: preset.id,
      minTempF: minTemp,
      maxTempF: maxTemp,
    })
    const scheduleTemps = curveToScheduleTemperatures(curvePoints, bedtimeMinutes)
    const next: LocalSetPoint[] = Object.entries(scheduleTemps).map(([time, temperature], i) => ({
      localId: -(i + 1),
      time,
      temperature: Math.round(Math.max(TEMP_FLOOR, Math.min(TEMP_CEIL, temperature))),
    }))
    setPoints(next)
  }, [bedtime, wakeTime, minTemp, maxTemp])

  const performSave = useCallback(async (force = false) => {
    const targetDays = Array.from(days)
    if (targetDays.length === 0) {
      setSaveError('Pick at least one day')
      return
    }
    if (points.length === 0) {
      setSaveError('Add at least one set point')
      return
    }

    if (!force) {
      const conflicts = detectCurveConflicts(targetDays, initialDays)
      if (conflicts.length > 0) {
        setPendingConflict(conflicts)
        return
      }
    }

    try {
      await saveCurve({
        targetDays,
        setPoints: points.map(p => ({ time: p.time, temperature: p.temperature })),
        originalDays: initialDays,
      })
      setPendingConflict(null)
      onClose()
    }
    catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }, [days, points, initialDays, detectCurveConflicts, saveCurve, onClose])

  if (!open) return null

  const editingPhase = editingId !== null ? orderedPhases.find(p => p.id === editingId) ?? null : null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 active:bg-zinc-800"
          aria-label="Cancel"
        >
          <X size={18} />
        </button>
        <span className="text-sm font-medium text-white">
          {isEdit ? 'Edit Curve' : 'New Curve'}
        </span>
        <button
          onClick={() => void performSave()}
          disabled={isMutating || days.size === 0 || points.length === 0}
          className="flex items-center gap-1.5 rounded-full bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white active:bg-sky-600 disabled:opacity-60"
        >
          {isMutating && <Loader2 size={12} className="animate-spin" />}
          {isMutating ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Day picker */}
      <div className="border-b border-zinc-800 px-4 pt-3 pb-5">
        <p className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">Days</p>
        <div className="flex items-center justify-between gap-1">
          {DAYS.map(({ key, short, label }) => {
            const isOn = days.has(key)
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleDay(key)}
                aria-pressed={isOn}
                aria-label={label}
                className={clsx(
                  'flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold transition-colors',
                  isOn ? 'bg-sky-500 text-white' : 'bg-zinc-900 text-zinc-500 active:bg-zinc-800',
                )}
              >
                {short}
              </button>
            )
          })}
        </div>
      </div>

      {/* Bedtime / Wake — drives preset generation and Pod auto on/off */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <p className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">
          Sleep window
        </p>
        <div className="grid grid-cols-2 gap-3">
          <TimeInput
            label="Bedtime"
            value={bedtime}
            onChange={setBedtime}
            icon={<Moon size={12} />}
            accentClass="text-purple-400"
          />
          <TimeInput
            label="Wake up"
            value={wakeTime}
            onChange={setWakeTime}
            icon={<Sun size={12} />}
            accentClass="text-amber-400"
          />
        </div>
      </div>

      {/* Min / Max temp — drives preset generation */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <p className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">
          Temperature range
        </p>
        <div className="grid grid-cols-2 gap-3">
          <TempStepper
            label="Coolest"
            value={minTemp}
            onChange={v => setMinTemp(Math.min(v, maxTemp - 2))}
            icon={<Snowflake size={12} />}
            accentClass="text-blue-400"
          />
          <TempStepper
            label="Warmest"
            value={maxTemp}
            onChange={v => setMaxTemp(Math.max(v, minTemp + 2))}
            icon={<Flame size={12} />}
            accentClass="text-orange-400"
          />
        </div>
      </div>

      {/* Chart preview */}
      {curveData && (
        <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-3 pt-4 pb-3 mt-2">
          <CurveChart
            points={curveData.points}
            bedtimeMinutes={curveData.bedtimeMinutes}
            minTempF={curveData.minTempF}
            maxTempF={curveData.maxTempF}
            compact
          />
        </div>
      )}

      {/* Set points list */}
      <div className="flex-1 overflow-y-auto px-3 py-3 pb-32">
        {points.length === 0
          ? (
              <div className="space-y-3 py-4">
                <p className="text-center text-xs text-zinc-500">
                  Start from a preset or add set points manually
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {PRESETS.map((preset) => {
                    const Icon = preset.icon
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => handleApplyPreset(preset)}
                        className="flex flex-col items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900 px-2 py-3 text-zinc-400 active:scale-[0.97]"
                      >
                        <Icon size={16} />
                        <span className="text-[11px] font-semibold">{preset.label}</span>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => setAIWizardOpen(true)}
                    className="flex flex-col items-center gap-1 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-2 py-3 text-cyan-400 active:scale-[0.97]"
                  >
                    <Sparkles size={16} />
                    <span className="text-[11px] font-semibold">Custom AI</span>
                  </button>
                </div>
              </div>
            )
          : (
              <div className="space-y-1.5">
                {orderedPhases.map(phase => (
                  <SetPointCard
                    key={phase.id}
                    phase={phase}
                    onAdjustTemp={handleAdjustTemp}
                    onDelete={handleDeletePoint}
                    onTapCard={handleEditPoint}
                    disabled={isMutating}
                    autoLabel={
                      phase.id === autoOnId
                        ? 'on'
                        : phase.id === autoOffId
                          ? 'off'
                          : null
                    }
                  />
                ))}
              </div>
            )}

        {saveError && (
          <p className="mt-3 text-center text-xs text-red-400">{saveError}</p>
        )}
      </div>

      {/* Floating add button */}
      <div className="pb-safe absolute inset-x-0 bottom-0 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur-sm">
        <button
          onClick={handleAddPoint}
          className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-zinc-700 text-sm font-medium text-zinc-300 active:bg-zinc-800"
        >
          <Plus size={14} />
          Add Set Point
        </button>
      </div>

      {/* Custom AI curve wizard */}
      <AICurveWizard
        open={aiWizardOpen}
        onClose={() => setAIWizardOpen(false)}
        onApply={handleApplyAICurve}
      />

      {/* Per-point editor sheet */}
      <SetPointEditor
        editingPhase={editingPhase}
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false)
          setEditingId(null)
        }}
        onCreate={handleEditorCreate}
        onUpdate={handleEditorUpdate}
        onDelete={handleEditorDelete}
      />

      {/* Conflict confirm dialog */}
      {pendingConflict && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-zinc-900 p-5">
            <h3 className="text-sm font-semibold text-white">Move days from another curve?</h3>
            <p className="mt-2 text-xs text-zinc-400">
              {pendingConflict.map(d => DAYS.find(x => x.key === d)?.label).join(', ')}
              {' '}
              {pendingConflict.length === 1 ? 'is' : 'are'}
              {' '}
              already part of another curve. Saving will move
              {' '}
              {pendingConflict.length === 1 ? 'it' : 'them'}
              {' '}
              to this curve.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setPendingConflict(null)}
                className="flex-1 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 active:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => void performSave(true)}
                disabled={isMutating}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-sky-500 px-3 py-2 text-xs font-semibold text-white active:bg-sky-600 disabled:opacity-60"
              >
                {isMutating && <Loader2 size={12} className="animate-spin" />}
                {isMutating ? 'Saving…' : 'Move & Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface TempStepperProps {
  label: string
  value: number
  onChange: (value: number) => void
  icon?: React.ReactNode
  accentClass?: string
}

function TempStepper({ label, value, onChange, icon, accentClass }: TempStepperProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
        {icon && <span className={accentClass}>{icon}</span>}
        {label}
      </label>
      <div className="flex h-11 items-center rounded-lg border border-zinc-700 bg-zinc-800/50">
        <button
          type="button"
          onClick={() => onChange(Math.max(TEMP_FLOOR, value - 1))}
          disabled={value <= TEMP_FLOOR}
          className="flex h-full w-10 items-center justify-center text-zinc-400 transition-colors active:text-white disabled:opacity-30"
          aria-label={`Decrease ${label}`}
        >
          <Minus size={14} strokeWidth={3} />
        </button>
        <span className="flex-1 text-center text-sm font-semibold tabular-nums text-white">
          {value}
          °F
        </span>
        <button
          type="button"
          onClick={() => onChange(Math.min(TEMP_CEIL, value + 1))}
          disabled={value >= TEMP_CEIL}
          className="flex h-full w-10 items-center justify-center text-zinc-400 transition-colors active:text-white disabled:opacity-30"
          aria-label={`Increase ${label}`}
        >
          <Plus size={14} strokeWidth={3} />
        </button>
      </div>
    </div>
  )
}
