'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  Sparkles,
  Copy,
  Check,
  Share2,
  ClipboardPaste,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Trash2,
  Plus,
  Minus,
  Save,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'
import {
  generatePrompt,
  parseAIResponse,
  EXAMPLE_SUGGESTIONS,
  loadTemplates,
  saveTemplate,
  deleteTemplate,
} from '@/src/lib/sleepCurve/curvePrompt'
import type { GeneratedCurve, CurveTemplate, ParseResult } from '@/src/lib/sleepCurve/curvePrompt'
import type { DayOfWeek } from './DaySelector'

type Side = 'left' | 'right'

interface AICurveWizardProps {
  open: boolean
  onClose: () => void
  side: Side
  selectedDays: Set<DayOfWeek>
  onApplied?: (config: {
    setPoints: Array<{ time: string; tempF: number }>
    bedtime: string
    wakeTime: string
  }) => void
}

type Step = 0 | 1 | 2 | 3

const STEP_LABELS = ['Describe', 'Review', 'Import', 'Preview']

// ─── Main Component ──────────────────────────────────────────────────

export function AICurveWizard({ open, onClose, side, selectedDays, onApplied }: AICurveWizardProps) {
  const [step, setStep] = useState<Step>(0)
  const [highestStep, setHighestStep] = useState<Step>(0)

  // Step 1: Describe
  const [preferences, setPreferences] = useState('')

  // Step 2: Review
  const [prompt, setPrompt] = useState('')
  const [copied, setCopied] = useState(false)

  // Step 3: Import
  const [jsonInput, setJsonInput] = useState('')
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)

  // Step 4: Preview
  const [curve, setCurve] = useState<GeneratedCurve | null>(null)
  const [editablePoints, setEditablePoints] = useState<Array<{ time: string; tempF: number }>>([])
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(false)
  const [savedTemplates, setSavedTemplates] = useState<CurveTemplate[]>([])

  // tRPC
  const utils = trpc.useUtils()
  const createTempSchedule = trpc.schedules.createTemperatureSchedule.useMutation()
  const deleteTempSchedule = trpc.schedules.deleteTemperatureSchedule.useMutation()
  const createPowerSchedule = trpc.schedules.createPowerSchedule.useMutation()
  const deletePowerSchedule = trpc.schedules.deletePowerSchedule.useMutation()

  // Load templates on mount
  useEffect(() => {
    if (open) {
      setSavedTemplates(loadTemplates())
    }
  }, [open])

  // Reset on close
  useEffect(() => {
    if (!open) {
      setStep(0)
      setHighestStep(0)
      setPreferences('')
      setPrompt('')
      setCopied(false)
      setJsonInput('')
      setParseResult(null)
      setCurve(null)
      setEditablePoints([])
      setApplying(false)
      setApplied(false)
    }
  }, [open])

  // Auto-parse JSON input (debounced)
  useEffect(() => {
    if (!jsonInput.trim()) {
      setParseResult(null)
      return
    }
    const timer = setTimeout(() => {
      const result = parseAIResponse(jsonInput)
      setParseResult(result)
      if (result.success) {
        setCurve(result.curve)
        setEditablePoints(
          Object.entries(result.curve.points)
            .map(([time, tempF]) => ({ time, tempF }))
            .sort((a, b) => a.time.localeCompare(b.time)),
        )
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [jsonInput])

  // ── Step Navigation ──

  const goNext = useCallback(() => {
    if (step === 0) {
      // Generate prompt
      const p = generatePrompt(preferences)
      setPrompt(p)
      const next: Step = 1
      setStep(next)
      setHighestStep(prev => Math.max(prev, next) as Step)
    } else if (step === 1) {
      const next: Step = 2
      setStep(next)
      setHighestStep(prev => Math.max(prev, next) as Step)
    } else if (step === 2 && parseResult?.success) {
      const next: Step = 3
      setStep(next)
      setHighestStep(prev => Math.max(prev, next) as Step)
    }
  }, [step, preferences, parseResult])

  const goBack = useCallback(() => {
    if (step > 0) setStep((step - 1) as Step)
  }, [step])

  const goToStep = useCallback((target: Step) => {
    if (target <= highestStep) setStep(target)
  }, [highestStep])

  // ── Actions ──

  const handleCopy = useCallback(async () => {
    // Try clipboard API first (works on HTTPS / localhost)
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(prompt)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        return
      } catch { /* fall through */ }
    }
    // Fallback: select the text in the prompt display so user can Cmd+C / long-press copy
    const el = document.getElementById('ai-prompt-text')
    if (el) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [prompt])

  const handleShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({ text: prompt })
      } catch { /* user cancelled */ }
    }
  }, [prompt])

  const canShare = typeof navigator !== 'undefined' && !!navigator.share

  const handlePaste = useCallback(async () => {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText()
        setJsonInput(text)
        return
      } catch { /* fall through */ }
    }
    // Can't read clipboard over HTTP — focus the textarea so user can paste manually
  }, [])

  const handleLoadTemplate = useCallback((template: CurveTemplate) => {
    setCurve(template)
    setEditablePoints(
      Object.entries(template.points)
        .map(([time, tempF]) => ({ time, tempF }))
        .sort((a, b) => a.time.localeCompare(b.time)),
    )
    setStep(3)
    setHighestStep(3)
  }, [])

  const handleDeleteTemplate = useCallback((name: string) => {
    deleteTemplate(name)
    setSavedTemplates(loadTemplates())
  }, [])

  const handleSaveTemplate = useCallback(() => {
    if (!curve) return
    const pointsObj: Record<string, number> = {}
    for (const p of editablePoints) pointsObj[p.time] = p.tempF
    const updated: GeneratedCurve = { ...curve, points: pointsObj }
    saveTemplate(updated)
    setSavedTemplates(loadTemplates())
  }, [curve, editablePoints])

  // Set point editing
  const updatePoint = useCallback((idx: number, field: 'time' | 'tempF', value: string | number) => {
    setEditablePoints(prev => {
      const next = [...prev]
      if (field === 'time') next[idx] = { ...next[idx], time: value as string }
      else next[idx] = { ...next[idx], tempF: Math.max(55, Math.min(110, value as number)) }
      return next.sort((a, b) => a.time.localeCompare(b.time))
    })
  }, [])

  const addPoint = useCallback(() => {
    setEditablePoints(prev => {
      const last = prev[prev.length - 1]
      const newTime = last ? incrementTime(last.time, 15) : '22:00'
      return [...prev, { time: newTime, tempF: 78 }].sort((a, b) => a.time.localeCompare(b.time))
    })
  }, [])

  const removePoint = useCallback((idx: number) => {
    setEditablePoints(prev => {
      if (prev.length <= 3) return prev
      return prev.filter((_, i) => i !== idx)
    })
  }, [])

  // Apply curve to schedule
  const handleApply = useCallback(async () => {
    if (!curve || editablePoints.length < 3) return
    setApplying(true)

    try {
      const daysArray = Array.from(selectedDays)

      for (const day of daysArray) {
        const existing = await utils.schedules.getByDay.fetch({ side, dayOfWeek: day })

        await Promise.all([
          ...existing.temperature.map((s: { id: number }) =>
            deleteTempSchedule.mutateAsync({ id: s.id }),
          ),
          ...existing.power.map((s: { id: number }) =>
            deletePowerSchedule.mutateAsync({ id: s.id }),
          ),
        ])

        await Promise.all([
          ...editablePoints.map(p =>
            createTempSchedule.mutateAsync({
              side,
              dayOfWeek: day,
              time: p.time,
              temperature: p.tempF,
              enabled: true,
            }),
          ),
          createPowerSchedule.mutateAsync({
            side,
            dayOfWeek: day,
            onTime: curve.bedtime,
            offTime: curve.wake,
            onTemperature: editablePoints[0]?.tempF ?? 78,
            enabled: true,
          }) as Promise<unknown>,
        ])
      }

      await utils.schedules.invalidate()
      setApplied(true)
      onApplied?.({
        setPoints: editablePoints,
        bedtime: curve.bedtime,
        wakeTime: curve.wake,
      })
      setTimeout(() => onClose(), 1500)
    } catch (err) {
      console.error('Failed to apply AI curve:', err)
    } finally {
      setApplying(false)
    }
  }, [curve, editablePoints, selectedDays, side, utils, createTempSchedule, deleteTempSchedule, createPowerSchedule, deletePowerSchedule, onApplied, onClose])

  // Temp range for display
  const tempRange = useMemo(() => {
    if (editablePoints.length === 0) return { min: 55, max: 110 }
    const temps = editablePoints.map(p => p.tempF)
    return { min: Math.min(...temps), max: Math.max(...temps) }
  }, [editablePoints])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-2xl bg-zinc-900 shadow-xl sm:inset-x-auto sm:inset-y-4 sm:left-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-cyan-400" />
            <span className="text-sm font-semibold text-white">Custom AI Curve</span>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-zinc-400">
            <X size={14} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex border-b border-zinc-800 px-4 py-2">
          {STEP_LABELS.map((label, i) => (
            <button
              key={label}
              onClick={() => goToStep(i as Step)}
              disabled={i > highestStep}
              className={cn(
                'flex-1 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors',
                i === step ? 'text-cyan-400' : i <= highestStep ? 'text-zinc-500' : 'text-zinc-700',
              )}
            >
              {i + 1}. {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {step === 0 && (
            <StepDescribe
              preferences={preferences}
              onPreferencesChange={setPreferences}
              templates={savedTemplates}
              onLoadTemplate={handleLoadTemplate}
              onDeleteTemplate={handleDeleteTemplate}
            />
          )}
          {step === 1 && (
            <StepReview
              prompt={prompt}
              copied={copied}
              onCopy={handleCopy}
              canShare={canShare}
              onShare={handleShare}
            />
          )}
          {step === 2 && (
            <StepImport
              jsonInput={jsonInput}
              onJsonInputChange={setJsonInput}
              parseResult={parseResult}
              onPaste={handlePaste}
            />
          )}
          {step === 3 && curve && (
            <StepPreview
              curve={curve}
              editablePoints={editablePoints}
              tempRange={tempRange}
              onUpdatePoint={updatePoint}
              onAddPoint={addPoint}
              onRemovePoint={removePoint}
              onSaveTemplate={handleSaveTemplate}
              applying={applying}
              applied={applied}
              dayCount={selectedDays.size}
              onApply={handleApply}
            />
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3">
          <button
            onClick={goBack}
            disabled={step === 0}
            className="flex items-center gap-1 text-xs text-zinc-400 disabled:opacity-30"
          >
            <ChevronLeft size={14} /> Back
          </button>

          {step < 3 && (
            <button
              onClick={goNext}
              disabled={
                (step === 0 && !preferences.trim()) ||
                (step === 2 && !parseResult?.success)
              }
              className="flex items-center gap-1 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-cyan-600 disabled:opacity-40"
            >
              {step === 0 ? 'Generate Prompt' : 'Next'} <ChevronRight size={14} />
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Step 1: Describe ────────────────────────────────────────────────

function StepDescribe({
  preferences,
  onPreferencesChange,
  templates,
  onLoadTemplate,
  onDeleteTemplate,
}: {
  preferences: string
  onPreferencesChange: (v: string) => void
  templates: CurveTemplate[]
  onLoadTemplate: (t: CurveTemplate) => void
  onDeleteTemplate: (name: string) => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs text-zinc-400">
          Describe your sleep preferences in natural language. An AI will design a personalized temperature curve.
        </p>
        <textarea
          value={preferences}
          onChange={e => onPreferencesChange(e.target.value)}
          placeholder="e.g., I run hot, bed at 11pm, wake at 6:30. Really cold first few hours..."
          rows={4}
          className="w-full rounded-xl border border-zinc-800 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:border-cyan-500/50 focus:outline-none"
        />
      </div>

      {/* Example suggestions */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Try an example</p>
        {EXAMPLE_SUGGESTIONS.map(suggestion => (
          <button
            key={suggestion}
            onClick={() => onPreferencesChange(suggestion)}
            className="block w-full rounded-lg border border-zinc-800 px-3 py-2 text-left text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-300"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {/* Saved templates */}
      {templates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Saved Curves</p>
          {templates.map(t => (
            <div key={t.name} className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2">
              <button
                onClick={() => onLoadTemplate(t)}
                className="flex flex-1 items-center gap-2 text-left"
              >
                <span className="h-2 w-2 rounded-full bg-cyan-400" />
                <span className="flex-1 text-xs font-medium text-zinc-300">{t.name}</span>
                <span className="text-[10px] text-zinc-600">
                  {t.bedtime} → {t.wake}
                </span>
              </button>
              <button
                onClick={() => onDeleteTemplate(t.name)}
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-600 hover:text-red-400"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Step 2: Review ──────────────────────────────────────────────────

function StepReview({
  prompt,
  copied,
  onCopy,
  canShare,
  onShare,
}: {
  prompt: string
  copied: boolean
  onCopy: () => void
  canShare: boolean
  onShare: () => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">
        {canShare
          ? 'Share this prompt to ChatGPT, Claude, or Gemini. Then paste the JSON response in the next step.'
          : 'Select and copy this prompt, then paste it into ChatGPT, Claude, or Gemini. Paste the JSON response in the next step.'}
      </p>

      <div className="max-h-[40vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3">
        <pre id="ai-prompt-text" className="whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-300 select-all">{prompt}</pre>
      </div>

      <div className="flex gap-2">
        {canShare && (
          <button
            onClick={onShare}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-white transition-all hover:bg-cyan-600 active:scale-[0.98]"
          >
            <Share2 size={16} /> Share Prompt
          </button>
        )}

        <button
          onClick={onCopy}
          className={cn(
            'flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all',
            canShare ? 'border border-zinc-800 bg-zinc-800/50 text-zinc-400' : 'flex-1',
            copied
              ? 'bg-emerald-500/20 text-emerald-400'
              : !canShare
                ? 'bg-cyan-500 text-white hover:bg-cyan-600 active:scale-[0.98]'
                : '',
          )}
        >
          {copied ? <><Check size={16} /> Selected!</> : <><Copy size={16} /> {canShare ? 'Copy' : 'Select All'}</>}
        </button>
      </div>
    </div>
  )
}

// ─── Step 3: Import ──────────────────────────────────────────────────

function StepImport({
  jsonInput,
  onJsonInputChange,
  parseResult,
  onPaste,
}: {
  jsonInput: string
  onJsonInputChange: (v: string) => void
  parseResult: ParseResult | null
  onPaste: () => void
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">
        Paste the AI&apos;s JSON response below. It will be validated automatically.
      </p>

      <textarea
        value={jsonInput}
        onChange={e => onJsonInputChange(e.target.value)}
        placeholder='{"name": "...", "bedtime": "22:00", "wake": "07:00", "points": {...}, "reasoning": "..."}'
        rows={8}
        className="w-full rounded-xl border border-zinc-800 bg-zinc-800/50 px-3 py-2.5 font-mono text-xs text-white placeholder:text-zinc-600 focus:border-cyan-500/50 focus:outline-none"
      />

      <button
        onClick={onPaste}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-800/50 px-4 py-2.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-700"
      >
        <ClipboardPaste size={14} /> Paste from Clipboard
      </button>

      {/* Parse result */}
      {parseResult && (
        parseResult.success ? (
          <div className="flex items-start gap-2 rounded-xl bg-emerald-500/10 px-3 py-2.5">
            <Check size={14} className="mt-0.5 shrink-0 text-emerald-400" />
            <div className="text-xs text-emerald-400">
              <span className="font-semibold">{parseResult.curve.name}</span>
              <span className="ml-1 text-emerald-400/70">
                — {Object.keys(parseResult.curve.points).length} set points, {parseResult.curve.bedtime} → {parseResult.curve.wake}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
            <p className="text-xs text-red-400">{parseResult.error}</p>
          </div>
        )
      )}
    </div>
  )
}

// ─── Step 4: Preview ─────────────────────────────────────────────────

function StepPreview({
  curve,
  editablePoints,
  tempRange,
  onUpdatePoint,
  onAddPoint,
  onRemovePoint,
  onSaveTemplate,
  applying,
  applied,
  dayCount,
  onApply,
}: {
  curve: GeneratedCurve
  editablePoints: Array<{ time: string; tempF: number }>
  tempRange: { min: number; max: number }
  onUpdatePoint: (idx: number, field: 'time' | 'tempF', value: string | number) => void
  onAddPoint: () => void
  onRemovePoint: (idx: number) => void
  onSaveTemplate: () => void
  applying: boolean
  applied: boolean
  dayCount: number
  onApply: () => void
}) {
  return (
    <div className="space-y-4">
      {/* Curve name + time badge */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white">{curve.name}</span>
        <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-[10px] font-medium text-zinc-400">
          {curve.bedtime} → {curve.wake}
        </span>
      </div>

      {/* Reasoning callout */}
      {curve.reasoning && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-800/30 px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-zinc-400">{curve.reasoning}</p>
        </div>
      )}

      {/* Temperature range badge */}
      <div className="flex justify-center">
        <span className="rounded-full bg-zinc-800 px-3 py-1 text-[10px] font-medium text-zinc-400">
          {tempRange.min}°F – {tempRange.max}°F
        </span>
      </div>

      {/* Set point list */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Set Points ({editablePoints.length})
          </p>
          <button
            onClick={onAddPoint}
            className="flex items-center gap-1 text-[10px] text-cyan-400"
          >
            <Plus size={10} /> Add
          </button>
        </div>

        <div className="max-h-[30vh] overflow-y-auto rounded-xl border border-zinc-800">
          {editablePoints.map((point, idx) => (
            <div
              key={`${point.time}-${idx}`}
              className={cn(
                'flex items-center gap-2 px-3 py-2',
                idx > 0 && 'border-t border-zinc-800/50',
              )}
            >
              {/* Time */}
              <input
                type="time"
                value={point.time}
                onChange={e => onUpdatePoint(idx, 'time', e.target.value)}
                className="w-20 rounded bg-zinc-800 px-2 py-1 text-xs text-white [color-scheme:dark]"
              />

              {/* Temp bar visual */}
              <div className="flex flex-1 items-center gap-2">
                <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={cn(
                      'absolute inset-y-0 left-0 rounded-full',
                      point.tempF <= 74 ? 'bg-blue-500' : point.tempF <= 82 ? 'bg-violet-500' : 'bg-orange-500',
                    )}
                    style={{ width: `${((point.tempF - 55) / 55) * 100}%` }}
                  />
                </div>
              </div>

              {/* Temp stepper */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onUpdatePoint(idx, 'tempF', point.tempF - 1)}
                  className="flex h-6 w-6 items-center justify-center rounded bg-zinc-800 text-zinc-400"
                >
                  <Minus size={10} />
                </button>
                <span className={cn(
                  'w-10 text-center text-xs font-medium tabular-nums',
                  point.tempF <= 74 ? 'text-blue-400' : point.tempF <= 82 ? 'text-zinc-300' : 'text-orange-400',
                )}>
                  {point.tempF}°
                </span>
                <button
                  onClick={() => onUpdatePoint(idx, 'tempF', point.tempF + 1)}
                  className="flex h-6 w-6 items-center justify-center rounded bg-zinc-800 text-zinc-400"
                >
                  <Plus size={10} />
                </button>
              </div>

              {/* Delete */}
              <button
                onClick={() => onRemovePoint(idx)}
                disabled={editablePoints.length <= 3}
                className="flex h-6 w-6 items-center justify-center text-zinc-600 hover:text-red-400 disabled:opacity-30"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Save template + Apply */}
      <div className="flex gap-2">
        <button
          onClick={onSaveTemplate}
          className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-800/50 px-4 py-3 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-700"
        >
          <Save size={14} /> Save
        </button>

        <button
          onClick={onApply}
          disabled={applying || applied}
          className={cn(
            'flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all',
            applied
              ? 'bg-emerald-500/20 text-emerald-400'
              : 'bg-cyan-500 text-white hover:bg-cyan-600 active:scale-[0.98]',
            'disabled:opacity-60',
          )}
        >
          {applying ? (
            <><Loader2 size={16} className="animate-spin" /> Applying...</>
          ) : applied ? (
            <><Check size={16} /> Applied!</>
          ) : (
            `Apply to ${dayCount} ${dayCount === 1 ? 'day' : 'days'}`
          )}
        </button>
      </div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function incrementTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = (h * 60 + m + minutes) % (24 * 60)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
