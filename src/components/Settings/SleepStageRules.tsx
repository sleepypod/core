'use client'

import { useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, SegmentedControl, SelectValue, Skeleton, Slider, Toggle } from '@/src/components/ds'
import { useSideNames } from '@/src/hooks/useSideNames'
import { stageRulesetSchema, type StageClassifier, type StageRuleset } from '@/src/lib/sleep-stage-rules'
import {
  AddRuleButton,
  FallbackRow,
  LimitsRow,
  LowSignalRow,
  RuleList,
  Seen,
  SpikeRow,
  TransitionsRow,
} from './SleepStageRows'
import { ChangesCard, StagePreviewCard, type PreviewNights, type PreviewOutput } from './SleepStagePreview'
import {
  findQuickAdjust,
  formatMetricValue,
  formatSignedMinutes,
  shortDate,
  withConditionValue,
  type QuickAdjust,
} from './sleepStageEditing'

type Side = 'left' | 'right'

const sameRuleset = (a: StageRuleset, b: StageRuleset) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Sleep stage rules for one side, read as sentences: the ordered rules that
 * turn each epoch's heart rate, HRV, breathing and movement into
 * wake/light/deep/REM, the signal limits and cleanup around them, and a
 * preview of what the draft would change before it is saved. Values are
 * click-to-edit; only the row being edited shows controls.
 */
export function SleepStageRules({ side, onSideChange }: { side: Side, onSideChange: (side: Side) => void }) {
  const utils = trpc.useUtils()
  const { leftName, rightName } = useSideNames()
  const query = trpc.sleepStages.getClassifier.useQuery({ side }, {
    refetchInterval: query => query.state.data?.pending ? 5000 : false,
  })
  const save = trpc.sleepStages.setClassifier.useMutation({
    onSuccess: () => utils.sleepStages.getClassifier.invalidate({ side }),
  })
  const model = trpc.sleepStages.getModel.useQuery({ side })
  const setModelActive = trpc.sleepStages.setModelActive.useMutation({
    onSuccess: () => {
      utils.sleepStages.getModel.invalidate({ side })
      utils.biometrics.getSleepStages.invalidate()
    },
  })

  const saved = query.data?.pending?.classifier.ruleset ?? query.data?.classifier.ruleset
  const [draft, setDraft] = useState<StageRuleset | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [nights, setNights] = useState<PreviewNights>(1)
  // Re-seed the draft when the side or its stored ruleset changes — by value,
  // so a background refetch of the same rules keeps unsaved edits.
  const seed = saved ? `${side}:${JSON.stringify(saved)}` : null
  const [seeded, setSeeded] = useState<string | null>(null)
  if (seed !== seeded) {
    setSeeded(seed)
    setDraft(saved ?? null)
    setEditing(null)
  }

  const validation = draft ? stageRulesetSchema.safeParse(draft) : null
  const preview = useStagePreview(side, validation?.success ? validation.data : null, query.data?.classifier.ruleset ?? null, nights)

  if (query.error) {
    return (
      <Card>
        <InlineError>{`Failed to load sleep stage rules: ${query.error.message}`}</InlineError>
      </Card>
    )
  }
  if (!draft || !query.data || !saved || !validation) {
    return (
      <div className="grid items-start gap-3.5 @min-[800px]:grid-cols-[minmax(0,1fr)_300px]">
        <Skeleton className="h-[420px]" />
        <Skeleton className="h-[260px]" />
      </div>
    )
  }

  const { isDefault, presets, changes } = query.data
  const dirty = !sameRuleset(draft, saved)
  const update = (patch: Partial<StageRuleset>) => setDraft({ ...draft, ...patch })
  const busy = save.isPending
  const data = preview.data
  const stats = data?.candidate?.stats ?? null
  const seenLabel = nights > 1 ? `last ${data?.nights ?? nights} nights` : 'last night'
  const ranges = stats?.metricRanges ?? {}
  const lastChange = changes[0]

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {query.data.pending && (
        <p role="status" className="text-sm">
          {`Saved change ${query.data.pending.generation}; waiting for processor adoption. Displayed nights still use the acknowledged rules.`}
        </p>
      )}
      {(query.data.pending?.warning ?? query.data.provenance?.warning) && (
        <InlineError>{query.data.pending?.warning ?? query.data.provenance?.warning}</InlineError>
      )}
      <PersonalModelCard
        model={model.data ?? null}
        busy={setModelActive.isPending}
        error={setModelActive.error?.message ?? null}
        onToggle={active => setModelActive.mutate({ side, active })}
      />
      {/* Toolbar: profile, state, preset, reset */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[13px]">
        <SegmentedControl
          ariaLabel="Stage rules side"
          value={side}
          options={[{ value: 'left', label: leftName }, { value: 'right', label: rightName }]}
          onChange={onSideChange}
        />
        <span className="text-fg-2">
          {`Profile: ${isDefault ? 'System defaults' : 'Custom rules'}`}
          {lastChange && ` · changed ${shortDate(lastChange.changedAt)}`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <SelectValue
            label="Start from preset"
            value=""
            disabled={busy}
            options={[{ value: '', label: 'Load preset' }, ...presets.map(p => ({ value: p.id, label: p.label }))]}
            onChange={(id) => {
              const preset = presets.find(p => p.id === id)
              if (!preset) return
              setDraft(preset.classifier.ruleset)
              setEditing(null)
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={RotateCcw}
            disabled={(isDefault && !query.data.pending) || busy}
            onClick={() => save.mutate({ side, classifier: null })}
          >
            Reset to default
          </Button>
        </span>
      </div>

      <div className="grid items-start gap-3.5 @min-[800px]:grid-cols-[minmax(0,1fr)_300px]">
        {/* Freeze the editor while a save is in flight: the refetch it triggers
            re-seeds the draft, which would silently drop edits typed meanwhile. */}
        <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0">
          <QuickAdjustCard draft={draft} saved={saved} preview={data} onChange={setDraft} />

          <Card>
            <CardHeader
              title="Stage rules"
              subtitle="Each 5-minute epoch takes the first rule that matches, top to bottom. Click any value to change it. Applied changes re-score past nights too."
            />
            <div className="flex flex-col">
              <RuleList
                label="Rule"
                rules={draft.rules}
                onChange={rules => update({ rules })}
                editingKey={editing}
                onEdit={setEditing}
                stats={stats?.rules ?? null}
                hitCaption="of epochs"
                ranges={ranges}
                seenLabel={seenLabel}
              />
              <FallbackRow
                fallback={draft.fallback}
                editing={editing === 'fallback'}
                onEdit={on => setEditing(on ? 'fallback' : null)}
                onChange={fallback => update({ fallback })}
                stats={stats?.rules && stats.rules.hits.length === draft.rules.length ? stats.rules : null}
              />
            </div>
            <AddRuleButton label="Rule" rules={draft.rules} onChange={rules => update({ rules })} onEdit={setEditing} />
          </Card>

          <Card>
            <CardHeader title="Signal" subtitle="Readings outside these limits are ignored before the rules run." />
            <div className="flex flex-col">
              <LimitsRow
                outliers={draft.outliers}
                onChange={outliers => update({ outliers })}
                editing={editing === 'limits'}
                onEdit={on => setEditing(on ? 'limits' : null)}
                ranges={ranges}
                seenLabel={seenLabel}
              />
              <SpikeRow
                value={draft.outliers.heartRateSpikeStdDevs}
                onChange={heartRateSpikeStdDevs => update({ outliers: { ...draft.outliers, heartRateSpikeStdDevs } })}
                editing={editing === 'spike'}
                onEdit={on => setEditing(on ? 'spike' : null)}
                dropped={stats?.spikesDropped ?? null}
                readings={stats?.heartRateReadings ?? null}
                seenLabel={seenLabel}
              />
              <LowSignalRow
                value={draft.lowSignalBelow}
                onChange={lowSignalBelow => update({ lowSignalBelow })}
                editing={editing === 'lowSignal'}
                onEdit={on => setEditing(on ? 'lowSignal' : null)}
                lowSignalNights={stats?.lowSignalNights ?? null}
                nights={data?.nights ?? nights}
              >
                <RuleList
                  label="Low-signal rule"
                  nested
                  rules={draft.lowSignalRules}
                  onChange={lowSignalRules => update({ lowSignalRules })}
                  editingKey={editing}
                  onEdit={setEditing}
                  stats={stats?.lowSignalRules ?? null}
                  hitCaption="on those nights"
                  ranges={ranges}
                  seenLabel={seenLabel}
                />
                <AddRuleButton nested label="Low-signal rule" rules={draft.lowSignalRules} onChange={lowSignalRules => update({ lowSignalRules })} onEdit={setEditing} />
              </LowSignalRow>
            </div>
          </Card>

          <Card>
            <CardHeader title="Cleanup" subtitle="Applied after the rules." />
            <div className="flex flex-col">
              <div className="flex items-center justify-between gap-3 border-t border-line py-2.5 text-sm">
                <span>
                  {'Smooth single-epoch blips '}
                  <span className="text-fg-2">(A-B-A becomes A-A-A)</span>
                  {stats && draft.smoothIsolatedEpochs && <Seen>{`fixed ${stats.smoothed} ${seenLabel}`}</Seen>}
                </span>
                <Toggle label="Smooth single-epoch blips" on={draft.smoothIsolatedEpochs} onChange={smoothIsolatedEpochs => update({ smoothIsolatedEpochs })} />
              </div>
              <TransitionsRow
                transitions={draft.transitions}
                onChange={transitions => update({ transitions })}
                editing={editing === 'transitions'}
                onEdit={on => setEditing(on ? 'transitions' : null)}
                fixes={stats?.transitionFixes ?? null}
                seenLabel={seenLabel}
              />
            </div>
          </Card>

          {!validation.success && (
            <InlineError>{validation.error.issues[0]?.message ?? 'These rules are not valid'}</InlineError>
          )}
          {save.error && <InlineError>{save.error.message}</InlineError>}
        </fieldset>

        <div className="flex min-w-0 flex-col gap-3.5 @min-[800px]:sticky @min-[800px]:top-4">
          <StagePreviewCard
            data={data}
            error={preview.error}
            nights={nights}
            onNightsChange={setNights}
            dirty={dirty}
            canSave={validation.success}
            saving={busy}
            onSave={() => save.mutate({ side, classifier: { engine: 'rules', ruleset: draft } })}
            onDiscard={() => {
              setDraft(saved)
              setEditing(null)
            }}
          />
          <ChangesCard
            changes={changes}
            disabled={busy}
            onRevert={(classifier: StageClassifier | null) => save.mutate({ side, classifier })}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The personal model stored on the pod for this side (trained on a Mac from the pod's nights with the
 * Apple Watch as the label) and the switch that makes it stage the side's nights. The rules below stay
 * the fallback for any night the model cannot stage.
 */
function PersonalModelCard({ model, busy, error, onToggle }: {
  model: { model: { version: string, kind: string, metrics?: Record<string, unknown> } | null, uploadedAt: number | null, active: boolean } | null
  busy: boolean
  error: string | null
  onToggle: (active: boolean) => void
}) {
  const stored = model?.model ?? null
  const lono = stored?.metrics?.lono as { kappa?: number | null, nights?: number | null } | undefined
  const kappa = lono?.kappa != null ? lono.kappa.toFixed(2) : null
  return (
    <Card className="gap-2 p-4">
      <CardHeader
        title="Personal model"
        subtitle={stored
          ? `${stored.kind === 'forest' ? 'Random forest' : 'Logistic regression'} ${stored.version}${kappa ? ` · κ ${kappa} against the Watch, held out${lono?.nights ? ` over ${lono.nights} nights` : ''}` : ''}`
          : 'None stored. Train one on a Mac with scripts/train-personal-models.py and it appears here.'}
        right={stored && (
          <Toggle
            on={model?.active ?? false}
            disabled={busy}
            label="Stage nights with this model"
            onChange={onToggle}
          />
        )}
      />
      {stored && (
        <p className="text-xs text-fg-2">
          {model?.active
            ? 'Nights are staged by the model; the rules below are the fallback when it cannot stage a night.'
            : 'Off: nights are staged by the rules below. Turn on to stage with the model instead; the rules remain the fallback.'}
        </p>
      )}
      {error && <InlineError>{error}</InlineError>}
    </Card>
  )
}

/**
 * Debounced preview of the draft. Re-runs when the draft, the saved rules
 * (after a save) or the night span change; an invalid draft shows no
 * result until it is valid again.
 */
function useStagePreview(side: Side, ruleset: StageRuleset | null, saved: StageRuleset | null, nights: PreviewNights) {
  const preview = trpc.sleepStages.previewClassifier.useMutation()
  const { mutate } = preview
  // useMutation drops `data` the moment the next request starts, which would
  // swap the card for a skeleton on every slider tick. Keep the last result
  // on screen until the next one lands.
  const [last, setLast] = useState<PreviewOutput | undefined>(undefined)
  if (preview.data && preview.data !== last) setLast(preview.data)
  const data = ruleset ? preview.data ?? last : undefined
  const key = useMemo(() => (ruleset ? JSON.stringify(ruleset) : null), [ruleset])
  const savedKey = useMemo(() => (saved ? JSON.stringify(saved) : null), [saved])

  useEffect(() => {
    if (!key || !savedKey) return
    const t = setTimeout(() => mutate({ side, nights, classifier: { engine: 'rules', ruleset: JSON.parse(key) as StageRuleset } }), 400)
    return () => clearTimeout(t)
  }, [side, key, savedKey, nights, mutate])

  return { data, error: preview.error?.message ?? null }
}

/**
 * Two sliders over the thresholds people change most: the movement that
 * counts as wake and the HR ratio that counts as deep. Each moves the
 * matching value in the rules below and reads out the per-night effect.
 */
function QuickAdjustCard({ draft, saved, preview, onChange }: {
  draft: StageRuleset
  saved: StageRuleset
  preview: PreviewOutput | undefined
  onChange: (r: StageRuleset) => void
}) {
  const wake = findQuickAdjust(draft, 'wake', 'movement')
  const deep = findQuickAdjust(draft, 'deep', 'hrRatio')
  if (!wake && !deep) return null

  const effect = (stage: 'wake' | 'deep') => {
    const a = preview?.saved?.durations[stage]
    const b = preview?.candidate?.durations[stage]
    if (a === undefined || b === undefined || a === b) return 'unchanged'
    return `${formatSignedMinutes(b - a)} ${stage} / night`
  }

  const row = (target: QuickAdjust, title: string, sub: string, min: number, max: number, step: number, stage: 'wake' | 'deep') => {
    const original = saved.rules[target.rule]?.when[target.condition]
    const from = original && original.metric === target.metric ? original.value : null
    return (
      <div className="grid items-center gap-x-4 gap-y-1.5 min-[640px]:grid-cols-[200px_minmax(0,1fr)_200px]">
        <div>
          <div className="text-sm">{title}</div>
          <div className="text-xs text-fg-2">{`Rule ${target.rule + 1} · ${sub}`}</div>
        </div>
        <Slider
          label={title}
          value={Math.min(max, Math.max(min, target.value))}
          min={min}
          max={max}
          step={step}
          onChange={v => onChange(withConditionValue(draft, target, v))}
        />
        <div className="font-mono text-xs text-fg-2 min-[640px]:text-right">
          {from !== null && from !== target.value && `${formatMetricValue(target.metric, from)} → `}
          {formatMetricValue(target.metric, target.value)}
          {` · ${effect(stage)}`}
        </div>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader title="Quick adjust" subtitle="Moves the matching values in the rules below." />
      {wake && row(wake, 'Wake sensitivity', 'movement threshold', 0, 400, 5, 'wake')}
      {deep && row(deep, 'Deep sleep', 'HR ratio threshold', 0.8, 1, 0.005, 'deep')}
    </Card>
  )
}
