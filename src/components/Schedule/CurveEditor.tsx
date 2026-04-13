'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Snowflake, Scale, Flame, X } from 'lucide-react'
import clsx from 'clsx'
import { CurveChart } from './CurveChart'
import { SetPointCard } from './SetPointCard'
import { SetPointEditor } from './SetPointEditor'
import { DAYS, type DayOfWeek } from './DaySelector'
import { useSchedule } from '@/src/hooks/useSchedule'
import type { SchedulePhase } from '@/src/hooks/useSchedules'
import type { CurvePoint, CoolingIntensity } from '@/src/lib/sleepCurve/types'
import {
  generateSleepCurve,
  curveToScheduleTemperatures,
  timeStringToMinutes,
} from '@/src/lib/sleepCurve/generate'

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
  bedtime: string
  wakeTime: string
  minTempF: number
  maxTempF: number
}

const PRESETS: PresetDef[] = [
  { id: 'cool', label: 'Hot Sleeper', icon: Snowflake, bedtime: '22:00', wakeTime: '06:30', minTempF: 65, maxTempF: 84 },
  { id: 'balanced', label: 'Balanced', icon: Scale, bedtime: '22:00', wakeTime: '07:00', minTempF: 68, maxTempF: 86 },
  { id: 'warm', label: 'Cold Sleeper', icon: Flame, bedtime: '22:30', wakeTime: '07:00', minTempF: 72, maxTempF: 88 },
]

const PHASE_NAMES = ['Bedtime', 'Deep Sleep', 'Pre-Wake', 'Wake Up']

function toPhase(point: LocalSetPoint, index: number): SchedulePhase {
  return {
    id: point.localId,
    name: index < PHASE_NAMES.length ? PHASE_NAMES[index] : `Phase ${index + 1}`,
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
  const [days, setDays] = useState<Set<DayOfWeek>>(new Set(initialDays))
  const [points, setPoints] = useState<LocalSetPoint[]>(() =>
    initialSetPoints.map((p, i) => ({ localId: -(i + 1), time: p.time, temperature: p.temperature })),
  )
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pendingConflict, setPendingConflict] = useState<DayOfWeek[] | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const idCounter = useRef(-1000)

  // Reset state when opening (avoid stale state from previous open)
  useEffect(() => {
    if (!open) return
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setDays(new Set(initialDays))

    setPoints(initialSetPoints.map((p, i) => ({ localId: -(i + 1), time: p.time, temperature: p.temperature })))

    setEditorOpen(false)

    setEditingId(null)

    setPendingConflict(null)

    setSaveError(null)
  }, [open, initialDays, initialSetPoints])

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

  const phases = useMemo(
    () => [...points]
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((p, i) => toPhase(p, i)),
    [points],
  )

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

  const handleApplyPreset = useCallback((preset: PresetDef) => {
    const bedtimeMinutes = timeStringToMinutes(preset.bedtime)
    const wakeMinutes = timeStringToMinutes(preset.wakeTime)
    const curvePoints = generateSleepCurve({
      bedtimeMinutes,
      wakeMinutes,
      intensity: preset.id,
      minTempF: preset.minTempF,
      maxTempF: preset.maxTempF,
    })
    const scheduleTemps = curveToScheduleTemperatures(curvePoints, bedtimeMinutes)
    const next: LocalSetPoint[] = Object.entries(scheduleTemps).map(([time, temperature], i) => ({
      localId: -(i + 1),
      time,
      temperature: Math.round(Math.max(55, Math.min(110, temperature))),
    }))
    setPoints(next)
  }, [])

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

  const editingPhase = editingId !== null ? phases.find(p => p.id === editingId) ?? null : null

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
          className="rounded-full bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white active:bg-sky-600 disabled:opacity-40"
        >
          Save
        </button>
      </div>

      {/* Day picker */}
      <div className="border-b border-zinc-800 px-4 py-3">
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

      {/* Chart preview */}
      {curveData && (
        <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-3 py-2">
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
                <div className="grid grid-cols-3 gap-2">
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
                </div>
              </div>
            )
          : (
              <div className="space-y-1.5">
                {phases.map(phase => (
                  <SetPointCard
                    key={phase.id}
                    phase={phase}
                    onAdjustTemp={handleAdjustTemp}
                    onDelete={handleDeletePoint}
                    onTapCard={handleEditPoint}
                    disabled={isMutating}
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
                className="flex-1 rounded-xl bg-sky-500 px-3 py-2 text-xs font-semibold text-white active:bg-sky-600"
              >
                Move &amp; Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
