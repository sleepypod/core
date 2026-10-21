'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { stageModelSchema } from '@/src/lib/personal-stage-model'
import { Button, Card, CardHeader, InlineError, Toggle } from '@/src/components/ds'

/** Uploads only save candidates. Activation is a separate, explicit user action. */
export function PersonalModelCard({ side }: { side: 'left' | 'right' }) {
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
  const metrics = selected?.metrics ?? stored?.metrics
  const score = metrics?.lono as { kappa?: number, nights?: number } | undefined
  const kappa = typeof score?.kappa === 'number' && Number.isFinite(score.kappa) ? score.kappa.toFixed(2) : null
  const version = selected?.version ?? stored?.version
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
    <Card className="gap-3 p-4">
      <CardHeader
        title="Personal model"
        right={stored && (!selected || selected.selected) && (
          <Toggle
            on={model.data?.active ?? false}
            disabled={busy}
            label="Stage nights with this model"
            onChange={(active) => {
              setMessage(null)
              activate.mutate({ side, active })
            }}
          />
        )}
      />
      <p className="text-sm text-fg-2">
        {version
          ? (
              <>
                {kind === 'forest' ? 'Random forest' : 'Logistic regression'}
                {' '}
                <code className="break-all rounded bg-field px-1 font-mono">{version}</code>
                {kappa !== null && (
                  <>
                    {' '}
                    ·
                    <code className="rounded bg-field px-1 font-mono">
                      {`κ ${kappa}`}
                    </code>
                    {' '}
                    against the Watch, held out
                    {score?.nights ? ` over ${score.nights} nights` : ''}
                  </>
                )}
              </>
            )
          : 'None stored. Upload candidate.json from a training run to get started.'}
      </p>
      {kappa !== null && <p className="text-xs text-fg-2">κ (kappa) measures agreement with Watch stages after accounting for chance. 1 is perfect agreement, 0 is chance-level agreement; negative values are worse than chance. This is not a measure of clinical accuracy.</p>}
      {models.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            Saved models
            <select
              aria-label="Saved models"
              className="w-full min-w-0 rounded border border-line-2 bg-field p-2"
              value={selectedId}
              disabled={busy}
              onChange={(event) => {
                setChoice(event.target.value)
                setMessage(null)
              }}
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.version}
                  {' '}
                  · #
                  {m.id}
                  {m.active ? ' · Active' : m.selected ? ' · Selected, off' : ''}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            disabled={busy || !selected || selected.active}
            onClick={() => {
              if (selected) select.mutate({ side, id: selected.id, active: true })
            }}
          >
            Use this model
          </Button>
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Upload model JSON
        <input
          aria-label="Upload model JSON"
          type="file"
          accept=".json,application/json"
          disabled={busy || library.isLoading || model.isLoading}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void readFile(file)
          }}
        />
      </label>
      <p className="text-xs text-fg-2">Uploads are saved for this side without replacing or activating another model.</p>
      {stored && (
        <p className="text-xs text-fg-2">
          {model.data?.active
            ? (
                <>
                  Nights are staged by
                  {' '}
                  <code className="break-all font-mono">{stored.version}</code>
                  ; the rules below are the fallback when it cannot stage a night.
                </>
              )
            : 'Off: nights are staged by the rules below. Turn on to stage with the selected model instead; the rules remain the fallback.'}
        </p>
      )}
      {message && <p role="status" className="text-sm">{message}</p>}
      {error && <InlineError>{error}</InlineError>}
    </Card>
  )
}
