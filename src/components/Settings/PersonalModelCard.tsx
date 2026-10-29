'use client'

import { useRef, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { stageModelSchema } from '@/src/lib/personal-stage-model'
import { Button, Card, CardHeader, InlineError, Toggle } from '@/src/components/ds'

import { ModelScorecard, modelScore } from './ModelScorecard'

/** Uploads only save candidates. Activation is a separate, explicit user action. */
export function PersonalModelCard({ side }: { side: 'left' | 'right' }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const utils = trpc.useUtils()
  const model = trpc.sleepStages.getModel.useQuery({ side })
  const library = trpc.sleepStages.listModels.useQuery({ side })
  const [choice, setChoice] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const refresh = () => {
    void utils.sleepStages.getModel.invalidate({ side })
    void utils.sleepStages.listModels.invalidate({ side })
    void utils.biometrics.getSleepStages.invalidate()
  }
  const activate = trpc.sleepStages.setModelActive.useMutation({ onSuccess: refresh })
  const select = trpc.sleepStages.selectModel.useMutation({ onSuccess: () => {
    setMessage('Model selected and active.')
    refresh()
  } })
  const upload = trpc.sleepStages.uploadModel.useMutation({ onSuccess: (result) => {
    setChoice(String(result.id))
    setMessage('Model saved. Choose “Use this model” to activate it.')
    refresh()
  } })
  const models = library.data ?? []
  const selectedId = choice ?? String(models.find(m => m.selected)?.id ?? models[0]?.id ?? '')
  const selected = models.find(m => String(m.id) === selectedId)
  const stored = model.data?.model
  const busy = reading || upload.isPending || select.isPending || activate.isPending
  const metrics = choice === 'rules' ? undefined : selected ? selected.metrics : stored?.metrics
  const score = modelScore(metrics)
  const version = choice === 'rules' ? 'Rules only' : selected?.version ?? stored?.version
  const kind = selected?.kind ?? stored?.kind
  const error = fileError ?? upload.error?.message ?? select.error?.message ?? activate.error?.message ?? library.error?.message ?? model.error?.message

  async function readFile(file: File) {
    setFileError(null)
    setMessage(null)
    setReading(true)
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Choose a model JSON file smaller than 10 MB.')
      let value: unknown
      try {
        value = JSON.parse(await file.text())
      }
      catch { throw new Error('This file is not valid JSON. Choose candidate.json from a training run.') }
      const parsed = stageModelSchema.safeParse(value)
      if (!parsed.success) throw new Error('This JSON is not a supported sleep-stage model. Choose candidate.json from a training run.')
      await upload.mutateAsync({ side, model: parsed.data })
    }
    catch (error) {
      setFileError(error instanceof Error ? error.message : 'Could not upload this model.')
    }
    finally { setReading(false) }
  }

  return (
    <Card className="@container gap-5 p-5 min-[900px]:p-7">
      <CardHeader title="Staging model" right={<Button size="sm" disabled={busy || library.isLoading || model.isLoading} onClick={() => fileInput.current?.click()}>Upload model</Button>} />
      <p className="-mt-3 text-sm text-fg-2">
        {version
          ? (
              <>
                <code className="break-all font-mono text-fg">{version}</code>
                {choice !== 'rules' && ` · ${kind === 'forest' ? 'Random forest' : 'Logistic regression'}${score.nights ? ` · ${score.nights} held-out nights` : ''}`}
              </>
            )
          : 'None stored. Upload a model from a training run to get started.'}
      </p>
      {version && choice !== 'rules' && <ModelScorecard metrics={metrics} />}
      <div className="border-t border-line pt-5">
        <p className="mb-3 text-xs uppercase tracking-wider text-fg-3">Switch model</p>
        <div role="radiogroup" aria-label="Saved models" className="flex flex-col gap-1">
          {models.map(m => (
            <label key={m.id} className={`flex cursor-pointer items-center gap-3 rounded-ctl px-3 py-3 text-sm ${String(m.id) === selectedId ? 'bg-active' : ''}`}>
              <input
                type="radio"
                className="accent-[var(--status-ok)]"
                name={`model-${side}`}
                value={m.id}
                checked={String(m.id) === selectedId}
                disabled={busy}
                onChange={() => {
                  setChoice(String(m.id))
                  setMessage(null)
                }}
                aria-label={m.version}
              />
              <code className="min-w-0 flex-1 break-all font-mono">{m.version}</code>
              <code className="font-mono">{modelScore(m.metrics).kappa?.toFixed(2) ?? '—'}</code>
              <span className="w-16 text-right text-xs text-ok">{m.active ? 'Active' : ''}</span>
            </label>
          ))}
          <label className={`flex cursor-pointer items-center gap-3 rounded-ctl px-3 py-3 text-sm ${choice === 'rules' ? 'bg-active' : ''}`}>
            <input
              type="radio"
              className="accent-[var(--status-ok)]"
              name={`model-${side}`}
              value="rules"
              checked={choice === 'rules'}
              disabled={busy}
              onChange={() => {
                setChoice('rules')
                setMessage(null)
              }}
            />
            <span className="flex-1">Rules only</span>
            <span className="text-xs text-fg-2">{model.data?.active ? 'Fallback' : 'Active'}</span>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-fg-3">Choose a model to review its scores, then apply it.</p>
          <Button
            size="sm"
            disabled={busy || (choice === 'rules' ? !model.data?.active : !selected || selected.active)}
            onClick={() => {
              if (choice === 'rules') activate.mutate({ side, active: false })
              else if (selected) select.mutate({ side, id: selected.id, active: true })
            }}
          >
            {choice === 'rules' ? 'Use rules only' : 'Use this model'}
          </Button>
        </div>
      </div>
      <input
        ref={fileInput}
        className="sr-only"
        aria-label="Upload model"
        type="file"
        accept=".json,application/json"
        disabled={busy || library.isLoading || model.isLoading}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void readFile(file)
        }}
      />
      {stored && (!selected || selected.selected) && choice !== 'rules' && (
        <div className="flex items-center gap-2 text-sm">
          <span>Stage nights with this model</span>
          <Toggle
            on={model.data?.active ?? false}
            disabled={busy}
            label="Stage nights with this model"
            onChange={(active) => {
              setMessage(null)
              activate.mutate({ side, active })
            }}
          />
        </div>
      )}
      <p className="text-xs text-fg-2">Uploads are saved for this side without replacing or activating another model.</p>
      {stored && <p className="text-xs text-fg-2">{model.data?.active ? 'Nights are staged by the active model; the rules below are the fallback when it cannot stage a night.' : 'Nights are staged by the rules below. Activate a model to use it instead.'}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {error && <InlineError>{error}</InlineError>}
    </Card>
  )
}
