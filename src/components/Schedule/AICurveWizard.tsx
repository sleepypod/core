'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  X,
  Sparkles,
  Copy,
  Check,
  Share2,
  ClipboardPaste,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Plus,
  Save,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Alert, Button, GhostIcon, Modal, SectionLabel, Stepper } from '@/src/components/ds'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { displayToSetpointF, setpointFToDisplay } from '@/src/lib/tempUtils'
import {
  generatePrompt,
  parseAIResponse,
  EXAMPLE_SUGGESTIONS,
  loadTemplates,
  saveTemplate,
  deleteTemplate,
} from '@/src/lib/sleepCurve/curvePrompt'
import type { GeneratedCurve, CurveTemplate, ParseResult } from '@/src/lib/sleepCurve/curvePrompt'
import { CurveChart } from './CurveChart'
import { TONE_VAR, tempTone } from './scheduleFormat'

interface AICurveWizardProps {
  open: boolean
  onClose: () => void
  /**
   * Called when the user accepts a generated curve. The parent loads the
   * set points + bedtime/wake into local editor state — the wizard does not
   * write the schedule directly. The user reviews and presses Save in the
   * parent editor to persist.
   */
  onApply: (config: {
    setPoints: Array<{ time: string, temperature: number }>
    bedtime: string
    wakeTime: string
  }) => void
}

type Step = 0 | 1 | 2 | 3

const STEP_LABELS = ['Describe', 'Review', 'Import', 'Preview']

export function AICurveWizard({ open, onClose, onApply }: AICurveWizardProps) {
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
  const [editablePoints, setEditablePoints] = useState<Array<{ time: string, tempF: number }>>([])
  const [savedTemplates, setSavedTemplates] = useState<CurveTemplate[]>([])

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      setSavedTemplates(loadTemplates())
    }
  }, [open])

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
    }
  }, [open])

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
  /* eslint-enable react-hooks/set-state-in-effect */

  const goNext = useCallback(() => {
    if (step === 0) {
      const p = generatePrompt(preferences)
      setPrompt(p)
      const next: Step = 1
      setStep(next)
      setHighestStep(prev => Math.max(prev, next) as Step)
    }
    else if (step === 1) {
      const next: Step = 2
      setStep(next)
      setHighestStep(prev => Math.max(prev, next) as Step)
    }
    else if (step === 2 && parseResult?.success) {
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

  const handleSkipToImport = useCallback(() => {
    setStep(2)
    setHighestStep(prev => Math.max(prev, 2) as Step)
  }, [])

  const handleCopy = useCallback(async () => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(prompt)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        return
      }
      catch { /* fall through */ }
    }
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
      }
      catch { /* user cancelled */ }
    }
  }, [prompt])

  const canShare = typeof navigator !== 'undefined' && !!navigator.share

  const handlePaste = useCallback(async () => {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText()
        setJsonInput(text)
      }
      catch { /* fall through */ }
    }
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

  const updatePoint = useCallback((idx: number, field: 'time' | 'tempF', value: string | number) => {
    setEditablePoints((prev) => {
      const next = [...prev]
      if (field === 'time') next[idx] = { ...next[idx], time: value as string }
      else next[idx] = { ...next[idx], tempF: Math.max(55, Math.min(110, value as number)) }
      return next.sort((a, b) => a.time.localeCompare(b.time))
    })
  }, [])

  const addPoint = useCallback(() => {
    setEditablePoints((prev) => {
      const last = prev[prev.length - 1]
      const newTime = last ? incrementTime(last.time, 15) : '22:00'
      return [...prev, { time: newTime, tempF: 78 }].sort((a, b) => a.time.localeCompare(b.time))
    })
  }, [])

  const removePoint = useCallback((idx: number) => {
    setEditablePoints((prev) => {
      if (prev.length <= 3) return prev
      return prev.filter((_, i) => i !== idx)
    })
  }, [])

  const handleApply = useCallback(() => {
    if (!curve || editablePoints.length < 3) return
    onApply({
      setPoints: editablePoints.map(p => ({ time: p.time, temperature: p.tempF })),
      bedtime: curve.bedtime,
      wakeTime: curve.wake,
    })
    onClose()
  }, [curve, editablePoints, onApply, onClose])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Custom AI curve"
      icon={Sparkles}
      iconClassName="text-fg-2"
      width={560}
      footer={(
        <>
          <Button variant="ghost" icon={ChevronLeft} onClick={goBack} disabled={step === 0}>
            Back
          </Button>
          <div className="ml-auto flex gap-2.5">
            {step === 0 && (
              <>
                <Button icon={ClipboardPaste} onClick={handleSkipToImport}>Import</Button>
                <Button variant="primary" onClick={goNext} disabled={!preferences.trim()}>
                  Generate
                  <ChevronRight size={14} />
                </Button>
              </>
            )}
            {step > 0 && step < 3 && (
              <Button variant="primary" onClick={goNext} disabled={step === 2 && !parseResult?.success}>
                Next
                <ChevronRight size={14} />
              </Button>
            )}
            {step === 3 && (
              <>
                <Button icon={Save} onClick={handleSaveTemplate}>Save template</Button>
                <Button variant="primary" onClick={handleApply} disabled={editablePoints.length < 3}>
                  Use curve
                </Button>
              </>
            )}
          </div>
        </>
      )}
    >
      <div className="grid grid-cols-4 gap-1 border-b border-line pb-2.5">
        {STEP_LABELS.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => goToStep(i as Step)}
            disabled={i > highestStep}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'sp-label cursor-pointer justify-center border-0 bg-transparent p-0 py-1 disabled:cursor-default',
              i === step ? 'text-fg' : i <= highestStep ? 'text-fg-2' : 'text-fg-3',
            )}
          >
            {`${i + 1}. ${label}`}
          </button>
        ))}
      </div>

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
          onUpdatePoint={updatePoint}
          onAddPoint={addPoint}
          onRemovePoint={removePoint}
        />
      )}
    </Modal>
  )
}

const FIELD = 'w-full rounded-ctl border border-line-2 bg-field px-3 py-[9px] text-fg outline-none placeholder:text-fg-3 focus:border-fg-3'

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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-[13px] text-fg-2">
          Describe your sleep preferences in natural language. An AI will design a personalized temperature curve.
        </p>
        <textarea
          value={preferences}
          onChange={e => onPreferencesChange(e.target.value)}
          placeholder="e.g., I run hot, bed at 11pm, wake at 6:30. Really cold first few hours..."
          rows={4}
          aria-label="Sleep preferences"
          className={cn(FIELD, 'text-sm')}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel>Try an example</SectionLabel>
        {EXAMPLE_SUGGESTIONS.map(suggestion => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPreferencesChange(suggestion)}
            className="block w-full cursor-pointer rounded-ctl border border-line-2 bg-transparent px-3 py-2 text-left text-[13px] text-fg-2 transition-colors hover:bg-active hover:text-fg"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {templates.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Saved curves</SectionLabel>
          {templates.map(t => (
            <div key={t.name} className="flex items-center gap-2 rounded-ctl border border-line-2 px-3 py-1.5">
              <button
                type="button"
                onClick={() => onLoadTemplate(t)}
                className="flex flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left"
              >
                <span className="flex-1 text-[13px] text-fg">{t.name}</span>
                <span className="font-mono text-[11px] text-fg-2">{`${t.bedtime} → ${t.wake}`}</span>
              </button>
              <GhostIcon icon={X} size={14} label={`Delete ${t.name}`} onClick={() => onDeleteTemplate(t.name)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-fg-2">
        {canShare
          ? 'Share this prompt to ChatGPT, Claude, or Gemini. Then paste the JSON response in the next step.'
          : 'Select and copy this prompt, then paste it into ChatGPT, Claude, or Gemini. Paste the JSON response in the next step.'}
      </p>

      <div className="max-h-[40vh] overflow-y-auto rounded-ctl border border-line bg-code p-3">
        <pre id="ai-prompt-text" className="select-all whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-fg-2">{prompt}</pre>
      </div>

      <div className="flex gap-2">
        {canShare && (
          <Button variant="primary" icon={Share2} className="flex-1" onClick={onShare}>
            Share prompt
          </Button>
        )}
        <Button
          variant={canShare ? 'secondary' : 'primary'}
          icon={copied ? Check : Copy}
          className={cn(!canShare && 'flex-1', copied && 'border-ok-line text-ok')}
          onClick={onCopy}
        >
          {copied ? 'Selected' : canShare ? 'Copy' : 'Select all'}
        </Button>
      </div>
    </div>
  )
}

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
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-fg-2">
        Paste the AI&apos;s JSON response below. It will be validated automatically.
      </p>

      <textarea
        value={jsonInput}
        onChange={e => onJsonInputChange(e.target.value)}
        placeholder='{"name": "...", "bedtime": "22:00", "wake": "07:00", "points": {...}, "reasoning": "..."}'
        rows={8}
        aria-label="AI response JSON"
        className={cn(FIELD, 'font-mono text-xs')}
      />

      <Button icon={ClipboardPaste} full onClick={onPaste}>
        Paste from clipboard
      </Button>

      {parseResult && (
        parseResult.success
          ? (
              <div className="flex items-start gap-2 rounded-ctl border border-ok-line px-3 py-2.5 text-[13px] text-ok">
                <Check size={14} className="mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium">{parseResult.curve.name}</span>
                  <span className="font-mono text-xs">
                    {` — ${Object.keys(parseResult.curve.points).length} set points, ${parseResult.curve.bedtime} → ${parseResult.curve.wake}`}
                  </span>
                </span>
              </div>
            )
          : <Alert tone="danger">{parseResult.error}</Alert>
      )}
    </div>
  )
}

function StepPreview({
  curve,
  editablePoints,
  onUpdatePoint,
  onAddPoint,
  onRemovePoint,
}: {
  curve: GeneratedCurve
  editablePoints: Array<{ time: string, tempF: number }>
  onUpdatePoint: (idx: number, field: 'time' | 'tempF', value: string | number) => void
  onAddPoint: () => void
  onRemovePoint: (idx: number) => void
}) {
  const { unit } = useTemperatureUnit()
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-medium">{curve.name}</span>
        <span className="font-mono text-xs text-fg-2">{`${curve.bedtime} → ${curve.wake}`}</span>
      </div>

      {editablePoints.length >= 2 && (
        <CurveChart setPoints={editablePoints.map(p => ({ time: p.time, temperature: p.tempF }))} height={160} />
      )}

      {curve.reasoning && (
        <p className="rounded-ctl border border-line px-3 py-2.5 text-xs leading-relaxed text-fg-2">{curve.reasoning}</p>
      )}

      <div className="flex flex-col gap-2">
        <SectionLabel right={<Button size="sm" variant="ghost" icon={Plus} onClick={onAddPoint}>Add</Button>}>
          {`Set points (${editablePoints.length})`}
        </SectionLabel>

        <div className="flex max-h-[30vh] flex-col overflow-y-auto">
          {editablePoints.map((point, idx) => (
            <div key={`${point.time}-${idx}`} className="flex items-center gap-2.5 border-t border-line py-2">
              <span
                className="block size-2 shrink-0 rounded-full"
                style={{ background: TONE_VAR[tempTone(point.tempF)] }}
              />
              <input
                type="time"
                value={point.time}
                aria-label={`Set point ${idx + 1} time`}
                onChange={e => onUpdatePoint(idx, 'time', e.target.value)}
                className="w-[110px] rounded-ctl border border-line-2 bg-field px-2 py-1 font-mono text-xs text-fg"
              />
              <span className="flex-1" />
              <Stepper
                value={Math.round(setpointFToDisplay(point.tempF, unit) ?? point.tempF)}
                min={Math.round(setpointFToDisplay(55, unit) ?? 55)}
                max={Math.round(setpointFToDisplay(110, unit) ?? 110)}
                label={`set point ${idx + 1} temperature`}
                onChange={v => onUpdatePoint(idx, 'tempF', Math.round(displayToSetpointF(v, unit) ?? point.tempF))}
              />
              <GhostIcon
                icon={Trash2}
                size={14}
                label={`Remove set point ${idx + 1}`}
                className="-mr-2 text-fg-3"
                disabled={editablePoints.length <= 3}
                onClick={() => onRemovePoint(idx)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function incrementTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = (h * 60 + m + minutes) % (24 * 60)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
