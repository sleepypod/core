'use client'

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Check, ChevronLeft, Flame, Loader2, Plus, Scale, Snowflake, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, Card, DayPicker, InlineError, PageHeader, SectionLabel, Stepper } from '@/src/components/ds'
import { AICurveWizard } from './AICurveWizard'
import { CurveChart } from './CurveChart'
import { SetPointCard, type EditorSetPoint } from './SetPointCard'
import { SetPointEditor } from './SetPointEditor'
import { TimeInput } from './TimeInput'
import { ConfirmDialog } from './ConfirmDialog'
import { DAY_PICKER_LABELS, DAY_SHORT, daysToIndexes, formatDayRange, indexesToDays } from './scheduleFormat'
import { useSchedule } from '@/src/hooks/useSchedule'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useSide } from '@/src/providers/SideProvider'
import type { DayOfWeek } from '@/src/lib/scheduleTime'
import type { CoolingIntensity } from '@/src/lib/sleepCurve/types'
import {
  generateSleepCurve,
  curveToScheduleTemperatures,
  timeStringToMinutes,
} from '@/src/lib/sleepCurve/generate'
import { rebaseSetPoints } from '@/src/lib/sleepCurve/rebase'
import { sortChronological } from '@/src/lib/scheduleGrouping'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { displayToSetpointF, setpointFToDisplay } from '@/src/lib/tempUtils'

interface CurveEditorProps {
  onClose: () => void
  /** When provided, editor opens in edit mode for the existing curve. */
  initialDays?: DayOfWeek[]
  /** Initial set points. Empty array = create mode with empty list. */
  initialSetPoints?: Array<{ time: string, temperature: number }>
}

interface PresetDef {
  id: CoolingIntensity
  label: string
  icon: LucideIcon
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

const clampTemp = (t: number) => Math.round(Math.max(TEMP_FLOOR, Math.min(TEMP_CEIL, t)))

const desktopQuery = '(min-width: 900px)'
function subscribeDesktop(cb: () => void) {
  const mql = window.matchMedia?.(desktopQuery)
  mql?.addEventListener('change', cb)
  return () => mql?.removeEventListener('change', cb)
}
function useIsDesktop() {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia?.(desktopQuery).matches ?? true,
    () => true,
  )
}

/**
 * Curve editor subpage (in-page, replaces the schedule list while open).
 * Desktop: 300px settings column + chart and set-point rows. Phone: stacked.
 * Local state until "Save" — then writes via `useSchedule.saveCurve` (one batch).
 */
export function CurveEditor({
  onClose,
  initialDays = [],
  initialSetPoints = [],
}: CurveEditorProps) {
  const { saveCurve, detectCurveConflicts, isMutating, allSchedules } = useSchedule()
  const { unit } = useTemperatureUnit()
  const { selectedSide } = useSide()
  const { leftName, rightName } = useSideNames()
  const isDesktop = useIsDesktop()

  const isEdit = initialDays.length > 0
  const [initial] = useState(() => {
    const sorted = sortChronological(initialSetPoints)
    const temps = initialSetPoints.map(p => p.temperature)
    return {
      bedtime: sorted[0]?.time ?? DEFAULT_BEDTIME,
      wake: sorted[sorted.length - 1]?.time ?? DEFAULT_WAKE,
      min: temps.length > 0 ? Math.min(...temps) : DEFAULT_MIN_TEMP,
      max: temps.length > 0 ? Math.max(...temps) : DEFAULT_MAX_TEMP,
    }
  })

  const [days, setDays] = useState<Set<DayOfWeek>>(() => new Set(initialDays))
  const [points, setPoints] = useState<EditorSetPoint[]>(() =>
    initialSetPoints.map((p, i) => ({ id: -(i + 1), time: p.time, temperature: p.temperature })),
  )
  const [bedtime, setBedtime] = useState(initial.bedtime)
  const [wakeTime, setWakeTime] = useState(initial.wake)
  const [minTemp, setMinTemp] = useState(initial.min)
  const [maxTemp, setMaxTemp] = useState(initial.max)
  const [activePreset, setActivePreset] = useState<CoolingIntensity | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [pendingConflict, setPendingConflict] = useState<DayOfWeek[] | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [aiWizardOpen, setAIWizardOpen] = useState(false)
  const idCounter = useRef(-1000)

  // Rows in chronological order (overnight wrap aware). The first and last
  // entries drive the Pod's auto power-on and power-off times.
  const orderedPoints = useMemo(() => {
    const sorted = sortChronological(points)
    const used = new Set<number>()
    return sorted.map((sp) => {
      const match = points.find(p => !used.has(p.id) && p.time === sp.time && p.temperature === sp.temperature)
      if (match) used.add(match.id)
      return match
    }).filter((p): p is EditorSetPoint => p !== undefined)
  }, [points])

  const autoOnId = orderedPoints[0]?.id ?? null
  const autoOffId = orderedPoints.length > 1 ? orderedPoints[orderedPoints.length - 1].id : null

  // Days outside this curve that another curve already schedules.
  const otherCurveDays = useMemo(() => {
    const scheduled = new Set((allSchedules?.temperature ?? []).filter(t => t.enabled).map(t => t.dayOfWeek))
    const original = new Set(initialDays)
    return [...scheduled].filter(d => !original.has(d) && !days.has(d))
  }, [allSchedules, initialDays, days])

  const editPoints = useCallback((fn: (prev: EditorSetPoint[]) => EditorSetPoint[]) => {
    setPoints(fn)
    setActivePreset(null)
  }, [])

  const handleSetTemp = useCallback((id: number, temperature: number) => {
    editPoints(prev => prev.map(p => (p.id === id ? { ...p, temperature } : p)))
  }, [editPoints])

  const handleDeletePoint = useCallback((id: number) => {
    editPoints(prev => prev.filter(p => p.id !== id))
  }, [editPoints])

  const handleEditorCreate = useCallback((time: string, temperature: number) => {
    const id = idCounter.current--
    editPoints(prev => [...prev, { id, time, temperature }])
  }, [editPoints])

  const handleEditorUpdate = useCallback((id: number, updates: { time?: string, temperature?: number }) => {
    editPoints(prev => prev.map(p => (p.id === id ? { ...p, ...updates } : p)))
  }, [editPoints])

  const handleChartChange = useCallback((item: EditorSetPoint, next: { time: string, temperature: number }) => {
    editPoints(prev => prev.map(p => (p.id === item.id ? { ...p, ...next } : p)))
  }, [editPoints])

  const handleApplyAICurve = useCallback((config: {
    setPoints: Array<{ time: string, temperature: number }>
    bedtime: string
    wakeTime: string
  }) => {
    const next = config.setPoints.map((sp, i) => ({ id: -(i + 1), time: sp.time, temperature: clampTemp(sp.temperature) }))
    setPoints(next)
    setActivePreset(null)
    setBedtime(config.bedtime)
    setWakeTime(config.wakeTime)
    const temps = next.map(p => p.temperature)
    if (temps.length > 0) {
      setMinTemp(Math.min(...temps))
      setMaxTemp(Math.max(...temps))
    }
  }, [])

  // Bedtime/wake are the canonical sleep-window controls — changing them
  // rebases the existing set points so the curve shape stays intact within
  // the new window. Without this rewire the inputs only drove preset
  // generation, so users who edited the window without clicking a preset
  // saw their change silently dropped on save.
  const handleBedtimeChange = useCallback((next: string) => {
    setPoints(prev => rebaseSetPoints(prev, bedtime, wakeTime, next, wakeTime))
    setBedtime(next)
  }, [bedtime, wakeTime])

  const handleWakeTimeChange = useCallback((next: string) => {
    setPoints(prev => rebaseSetPoints(prev, bedtime, wakeTime, bedtime, next))
    setWakeTime(next)
  }, [bedtime, wakeTime])

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
    setPoints(Object.entries(scheduleTemps).map(([time, temperature], i) => ({
      id: -(i + 1),
      time,
      temperature: clampTemp(temperature),
    })))
    setActivePreset(preset.id)
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
      setPendingConflict(null)
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }, [days, points, initialDays, detectCurveConflicts, saveCurve, onClose])

  const editingPoint = editingId !== null ? points.find(p => p.id === editingId) ?? null : null
  const title = isEdit ? 'Edit curve' : 'New curve'
  const sideLabel = selectedSide === 'both' ? 'Both sides' : selectedSide === 'left' ? leftName : rightName
  const daysLabel = formatDayRange(days)
  const canSave = !isMutating && days.size > 0 && points.length > 0
  const toDisplay = (f: number) => Math.round(setpointFToDisplay(f, unit) ?? f)
  const toF = (v: number) => clampTemp(displayToSetpointF(v, unit) ?? v)
  const saveLabel = isMutating ? 'Saving…' : 'Save curve'

  // Phone: cards stack in their own order (days, chart, times, set points,
  // range, preset). Desktop: the wrappers become the two grid columns and the
  // chart + set points merge into one card.
  const innerCard = 'min-[900px]:rounded-none min-[900px]:border-0 min-[900px]:bg-transparent min-[900px]:p-0'

  return (
    <div className="flex flex-col gap-3.5 min-[900px]:gap-[18px]">
      {/* Phone top bar */}
      <div className="relative flex min-h-[30px] items-center min-[900px]:hidden">
        <button
          type="button"
          onClick={onClose}
          className="relative z-[1] -ml-1.5 flex cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 text-[15px] text-fg-2"
        >
          <ChevronLeft size={20} />
          Cancel
        </button>
        <h1 className="pointer-events-none absolute inset-x-0 text-center text-[17px] font-medium">{title}</h1>
        <button
          type="button"
          onClick={() => void performSave()}
          disabled={!canSave}
          className="relative z-[1] ml-auto cursor-pointer border-0 bg-transparent p-0 text-[15px] font-medium text-fg disabled:cursor-default disabled:opacity-45"
        >
          {isMutating ? 'Saving…' : 'Save'}
        </button>
      </div>

      <PageHeader
        className="hidden min-[900px]:flex"
        back="Schedule"
        onBack={onClose}
        title={title}
        middle={(
          <span className="font-mono text-xs text-fg-2">
            {daysLabel ? `${sideLabel} · ${daysLabel}` : sideLabel}
          </span>
        )}
        right={(
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void performSave()} disabled={!canSave}>
              {isMutating && <Loader2 size={14} className="animate-spin" />}
              {saveLabel}
            </Button>
          </>
        )}
      />

      <div className="flex flex-col gap-3 min-[900px]:grid min-[900px]:grid-cols-[300px_minmax(0,1fr)] min-[900px]:items-start min-[900px]:gap-3.5">
        <div className="contents min-[900px]:flex min-[900px]:min-w-0 min-[900px]:flex-col min-[900px]:gap-3">
          <Card className="order-1 min-[900px]:order-none">
            <SectionLabel>Days</SectionLabel>
            <DayPicker
              value={daysToIndexes(days)}
              onChange={v => setDays(new Set(indexesToDays(v)))}
              labels={DAY_PICKER_LABELS}
            />
            {otherCurveDays.length > 0 && (
              <span className="text-xs text-fg-2">
                {`${formatDayRange(otherCurveDays)} ${otherCurveDays.length === 1 ? 'uses' : 'use'} another curve`}
              </span>
            )}
          </Card>

          <Card className="order-3 min-[900px]:order-none">
            <SectionLabel className="hidden min-[900px]:flex">Times</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              <TimeInput label="Bedtime" value={bedtime} onChange={handleBedtimeChange} />
              <TimeInput label="Wake up" value={wakeTime} onChange={handleWakeTimeChange} />
            </div>
          </Card>

          <Card className="order-5 min-[900px]:order-none">
            <SectionLabel>Range</SectionLabel>
            <div className="flex items-center justify-between gap-2.5">
              <span className="text-sm">Coolest</span>
              <Stepper
                label="coolest temperature"
                value={toDisplay(minTemp)}
                min={toDisplay(TEMP_FLOOR)}
                max={toDisplay(TEMP_CEIL)}
                onChange={v => setMinTemp(Math.min(toF(v), maxTemp - 2))}
              />
            </div>
            <div className="flex items-center justify-between gap-2.5">
              <span className="text-sm">Warmest</span>
              <Stepper
                label="warmest temperature"
                value={toDisplay(maxTemp)}
                min={toDisplay(TEMP_FLOOR)}
                max={toDisplay(TEMP_CEIL)}
                onChange={v => setMaxTemp(Math.max(toF(v), minTemp + 2))}
              />
            </div>
          </Card>

          <Card className="order-6 min-[900px]:order-none">
            <SectionLabel>Preset</SectionLabel>
            <div className="flex flex-col gap-1.5">
              {PRESETS.map((preset) => {
                const Icon = preset.icon
                const on = activePreset === preset.id
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => handleApplyPreset(preset)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-ctl border bg-transparent px-3 py-[9px] text-left text-sm transition-colors hover:bg-active',
                      on ? 'border-fg text-fg' : 'border-line-2 text-fg-2',
                    )}
                  >
                    <Icon size={15} />
                    {preset.label}
                    {on && <Check size={15} className="ml-auto" />}
                  </button>
                )
              })}
              <button
                type="button"
                onClick={() => setAIWizardOpen(true)}
                className="flex cursor-pointer items-center gap-2.5 rounded-ctl border border-dashed border-line-2 bg-transparent px-3 py-[9px] text-left text-sm text-fg-2 transition-colors hover:bg-active"
              >
                <Sparkles size={15} />
                Custom AI curve
              </button>
            </div>
          </Card>
        </div>

        <div className="contents min-[900px]:flex min-[900px]:min-w-0 min-[900px]:flex-col min-[900px]:gap-3 min-[900px]:rounded-card min-[900px]:border min-[900px]:border-line min-[900px]:bg-surface min-[900px]:px-[18px] min-[900px]:py-4">
          <Card className={cn('order-2 min-[900px]:order-none', innerCard)}>
            <div className="hidden items-center gap-2.5 min-[900px]:flex">
              <span className="text-[15px] font-medium">Curve</span>
              {points.length > 0 && (
                <span className="text-xs text-fg-2">Drag a point to change its time or temperature</span>
              )}
            </div>
            {points.length > 0
              ? (
                  <CurveChart
                    setPoints={points}
                    height={isDesktop ? 210 : 130}
                    large
                    onChangePoint={handleChartChange}
                    getKey={p => p.id}
                  />
                )
              : (
                  <p className="py-6 text-center text-[13px] text-fg-2">
                    Start from a preset or add set points manually
                  </p>
                )}
          </Card>

          <Card className={cn('order-4 min-[900px]:order-none', innerCard)}>
            <SectionLabel className="min-[900px]:hidden">Set points</SectionLabel>
            {orderedPoints.map(point => (
              <SetPointCard
                key={point.id}
                point={point}
                onSetTemp={handleSetTemp}
                onDelete={handleDeletePoint}
                onTapTime={(p) => {
                  setEditingId(p.id)
                  setEditorOpen(true)
                }}
                disabled={isMutating}
                autoLabel={point.id === autoOnId ? 'on' : point.id === autoOffId ? 'off' : null}
              />
            ))}
            <Button
              variant="dashed"
              icon={Plus}
              full
              onClick={() => {
                setEditingId(null)
                setEditorOpen(true)
              }}
            >
              Add set point
            </Button>
            {saveError && <InlineError>{saveError}</InlineError>}
          </Card>
        </div>
      </div>

      <AICurveWizard
        open={aiWizardOpen}
        onClose={() => setAIWizardOpen(false)}
        onApply={handleApplyAICurve}
      />

      <SetPointEditor
        editingPoint={editingPoint}
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false)
          setEditingId(null)
        }}
        onCreate={handleEditorCreate}
        onUpdate={handleEditorUpdate}
        onDelete={handleDeletePoint}
      />

      <ConfirmDialog
        open={pendingConflict !== null}
        title="Move days from another curve?"
        message={pendingConflict
          ? `${pendingConflict.map(d => DAY_SHORT[d]).join(', ')} ${pendingConflict.length === 1 ? 'is' : 'are'} already part of another curve. Saving will move ${pendingConflict.length === 1 ? 'it' : 'them'} to this curve.`
          : ''}
        confirmLabel={isMutating ? 'Saving…' : 'Move & save'}
        busy={isMutating}
        onConfirm={() => void performSave(true)}
        onCancel={() => setPendingConflict(null)}
      />
    </div>
  )
}
