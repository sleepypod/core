'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { defaultConfig, type BiometricConfig } from '@/src/biometrics/algorithms/registry-core'
import { trpc } from '@/src/utils/trpc'
import { cn } from '@/lib/utils'
import { InlineError, SegmentedControl, Skeleton } from '@/src/components/ds'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'
import { numericReportViewSchema } from './report-view'
import {
  actorOf,
  activityTime,
  baselineLabel,
  changedPaths,
  draftFrom,
  lifecycle,
  nightScores,
  overridesFor,
  paramDiffs,
  runStatus,
  savedBacktest,
  shortDuration,
  type Draft,
  type NightScore,
  type Split,
} from './calibration-model'
import { LifecycleStrip, RestoreMenu, RestoreDialog, type RestoreTarget } from './CalibrationControls'
import { ProfileCard } from './CalibrationProfileCard'
import { BacktestCard, DatasetCard, type BacktestReadiness, type DatasetNight } from './CalibrationEvidence'
import { ActivityCard, type ActivityRow } from './CalibrationActivity'
import { WatchDeviationTrend } from './WatchDeviationTrend'
import { useEvaluationSetup } from './evaluation-setup'

type Side = 'left' | 'right'
export type CalibrationTool = 'references' | 'backtests'
const NIL = '00000000-0000-0000-0000-000000000000'
const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')

/** Wall clock for relative times, ticking at `intervalMs`. */
function useNowMs(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function asConfig(value: unknown): BiometricConfig | null {
  const v = value as BiometricConfig | null
  return v && typeof v === 'object' && v.heart_rate && v.breathing_rate && v.hrv_index && v.sleep_stages ? v : null
}

/**
 * Biometric calibration (design 2a): the saved profile against the previous
 * one, what the processor is running, the frozen dataset and backtest that
 * judged the change, and who did what. Agents act through the same API, so
 * their saves, runs and requests show up here as they happen.
 */
export function CalibrationPage({ side, onSideChange, onOpenTool }: {
  side: Side
  onSideChange: (side: Side) => void
  onOpenTool: (tool: CalibrationTool) => void
}) {
  const { t } = useLingui()
  const { leftName, rightName } = useSideNames()
  const timeFormat = useTimeFormat()
  const h24 = timeFormat === '24h'
  const utils = trpc.useUtils()

  const overview = trpc.biometricTuning.getProfileOverview.useQuery({ side }, { refetchInterval: 5000 })
  const binding = overview.data?.desired.binding
  const savedId = binding?.desiredRevisionId ?? null
  const previousId = binding?.previousRevisionId ?? null
  const savedRevision = trpc.biometricTuning.getProfileRevision.useQuery({ id: savedId ?? NIL }, { enabled: Boolean(savedId), staleTime: Infinity })
  const previousRevision = trpc.biometricTuning.getProfileRevision.useQuery({ id: previousId ?? NIL }, { enabled: Boolean(previousId), staleTime: Infinity })
  const status = trpc.biometricTuning.getActivationStatus.useQuery({ side }, { refetchInterval: 5000 })
  const history = trpc.biometricTuning.listActivationHistory.useQuery({ side }, { refetchInterval: 15000 })
  const revisions = trpc.biometricTuning.listProfileRevisions.useQuery({ side }, { refetchInterval: 30000 })
  const datasets = trpc.biometricTuning.listDatasets.useQuery({ side }, { refetchInterval: 30000 })
  const imports = trpc.biometricTuning.listImports.useQuery({ side }, { refetchInterval: 30000 })
  const experiments = trpc.biometricTuning.listExperiments.useQuery({ side }, { refetchInterval: 30000 })
  const legacy = trpc.biometricTuning.countLegacyReferences.useQuery({ side }, { refetchInterval: 60000 })
  const settings = trpc.settings.getAll.useQuery({}, { staleTime: 60000 })
  const timezone = settings.data?.device.timezone ?? 'UTC'

  const backtests = trpc.biometricTuning.listBacktests.useQuery({ side }, {
    refetchInterval: query => query.state.data?.items.some(job => job.state === 'queued' || job.state === 'running' || job.state === 'cancel_requested') ? 3000 : 15000,
  })
  const jobs = useMemo(() => backtests.data?.items ?? [], [backtests.data])
  const savedHash = overview.data?.desired.hash ?? null
  const group = useMemo(() => savedBacktest(jobs, savedId, savedHash), [jobs, savedId, savedHash])
  const run = runStatus(group?.jobs ?? [])

  const finished = (group?.jobs ?? []).filter(job => job.state === 'succeeded')
  const summaries = trpc.useQueries(q => finished.map(job => q.biometricTuning.getBacktestSummary({ id: job.id }, { staleTime: 60000 })))

  const datasetId = group?.datasetId ?? datasets.data?.items.find(d => d.available)?.id ?? null
  const listed = datasets.data?.items.find(d => d.id === datasetId)
  const fetched = trpc.biometricTuning.getDataset.useQuery({ id: datasetId ?? NIL }, { enabled: Boolean(datasetId) && !listed && Boolean(datasets.data) })
  const dataset = listed ?? fetched.data ?? null

  // The replay a save re-runs: the one behind the current evidence, else the
  // newest set up on this dataset (waveform replay first, since only it
  // recomputes the numbers these parameters change).
  const onDataset = (experiments.data?.items ?? []).filter(e => e.datasetId === datasetId)
  const experimentId = group?.experimentId ?? (onDataset.find(e => e.protocol.mode === 'signal_replay') ?? onDataset[0])?.id ?? jobs[0]?.experimentId ?? null
  const readiness: BacktestReadiness = experimentId
    ? 'ready'
    : dataset ? 'no-experiment' : (imports.data?.items ?? []).some(i => i.available) || (legacy.data?.vitals ?? 0) > 0 ? 'no-dataset' : 'no-reference'
  const setup = useEvaluationSetup({ side, timezone, savedRevisionId: savedId, generation: binding?.generation ?? 0 })

  const saved = overview.data?.desired.resolved ?? null
  const previous = previousId ? asConfig(previousRevision.data?.resolved) : defaultConfig
  const previousHash = previousId ? previousRevision.data?.resolvedHash ?? null : null

  // Draft follows the saved profile; a new save (here or by an agent) resets it.
  const savedKey = `${side}:${overview.data?.desired.hash ?? ''}`
  const [draftState, setDraftState] = useState<{ key: string, draft: Draft } | null>(null)
  const draft = saved ? (draftState?.key === savedKey ? draftState.draft : draftFrom(saved)) : null
  const setDraft = (next: Draft) => setDraftState({ key: savedKey, draft: next })
  const dirty = saved && draft ? changedPaths(draft, saved).length > 0 : false

  // Per-night scores across the splits that finished.
  const scores = useMemo(() => {
    const rows: NightScore[] = []
    finished.forEach((job, i) => {
      const parsed = numericReportViewSchema.safeParse(summaries[i]?.data?.report)
      if (parsed.success) rows.push(...nightScores(parsed.data, job.split, baselineLabel(job, previousHash)))
    })
    return rows
  }, [finished, summaries, previousHash])

  const [selected, setSelected] = useState<string | null>(null)
  const assignments = dataset?.manifest.splitProtocol.assignments ?? []
  const nights: DatasetNight[] = assignments.map((a) => {
    const score = scores.find(s => s.cohortId === a.cohortId)
    const sources = (imports.data?.items ?? []).filter(i => i.available)
      .filter(i => i.summary.startMs !== null && i.summary.endMs !== null && i.summary.startMs < a.endMs && i.summary.endMs > a.startMs)
      .map(i => i.summary.source)
    return { cohortId: a.cohortId, split: a.split, startMs: a.startMs, endMs: a.endMs, score: score ?? null,
      reference: score && !score.hasReference ? null : [...new Set(sources)].join(' + ') || (score ? t`reference` : null) }
  })
  const selectedNight = nights.find(n => n.cohortId === selected) ?? nights.find(n => n.split === 'holdout' && n.score?.hasReference) ?? nights.find(n => n.score) ?? null
  const traceJob = selectedNight ? finished.find(job => job.split === selectedNight.split) : undefined
  const traceSummary = traceJob ? summaries[finished.indexOf(traceJob)]?.data : undefined

  /* ─── Mutations ─────────────────────────────────────────────────────── */
  const createRevision = trpc.biometricTuning.createProfileRevision.useMutation()
  const activate = trpc.biometricTuning.activateProfile.useMutation()
  const enqueue = trpc.biometricTuning.enqueueBacktest.useMutation()
  const [saveError, setSaveError] = useState<string>()
  const pending = useRef<{ fingerprint: string, key: string } | undefined>(undefined)
  const saving = createRevision.isPending || activate.isPending || enqueue.isPending

  function refresh() {
    void utils.biometricTuning.getProfileOverview.invalidate({ side })
    void utils.biometricTuning.getActivationStatus.invalidate({ side })
    void utils.biometricTuning.listActivationHistory.invalidate({ side })
    void utils.biometricTuning.listProfileRevisions.invalidate({ side })
    void utils.biometricTuning.listBacktests.invalidate({ side })
  }

  async function saveAndRequest() {
    if (!binding || !draft || !saved || !dirty) return
    setSaveError(undefined)
    const overrides = overridesFor((savedRevision.data?.overrides ?? []) as Array<{ path: string, value: unknown }>, draft, defaultConfig)
    const fingerprint = JSON.stringify({ side, generation: binding.generation, savedId, overrides })
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: randomKey() }
    const key = pending.current.key
    try {
      const revision = await createRevision.mutateAsync({ side, ...(savedId ? { parentRevisionId: savedId } : {}), overrides,
        origin: 'manual', requester: 'web-calibration', idempotencyKey: key })
      const event = await activate.mutateAsync({ side, revisionId: revision.id, expectedGeneration: binding.generation,
        expectedResolvedHash: revision.resolvedHash, boundary: 'next_session', requester: 'web-calibration', idempotencyKey: key, allowUnvalidated: true })
      // Re-run the evidence for the new profile on the same frozen dataset,
      // every split, so the table always compares like with like. Each
      // holdout exposure is counted by the job store.
      const splits = new Set(assignments.map(a => a.split))
      if (experimentId) {
        for (const split of (['tuning', 'validation', 'holdout'] as Split[]).filter(s => splits.size === 0 || splits.has(s))) {
          await enqueue.mutateAsync({ experimentId, candidateRevisionId: revision.id, expectedBindingGeneration: event.generation, split, idempotencyKey: `${key}:${split}` })
        }
      }
      pending.current = undefined
    }
    catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : t`Save failed.`)
    }
    finally {
      refresh()
    }
  }

  const [restore, setRestore] = useState<RestoreTarget | null>(null)

  /* ─── Activity ──────────────────────────────────────────────────────── */
  const nowMs = useNowMs(15_000)
  const activity = useMemo(() => {
    const rows: ActivityRow[] = []
    const byId = new Map((revisions.data?.items ?? []).map(r => [r.id, r]))
    const resolvedOf = (id: string | null) => id ? asConfig(byId.get(id)?.resolved) : defaultConfig
    for (const event of history.data?.items ?? []) {
      const requester = actorOf(event.requester)
      if (event.action === 'activate') {
        const revision = event.nextRevisionId ? byId.get(event.nextRevisionId) : undefined
        const before = resolvedOf(event.previousRevisionId), after = resolvedOf(event.nextRevisionId)
        const diffs = before && after ? paramDiffs(before, after) : []
        rows.push({ id: `${event.id}:saved`, atMs: revision?.createdAtMs ?? event.createdAtMs,
          actor: revision ? actorOf(revision.requester, revision.origin) : requester, what: t`Saved the profile`,
          detail: diffs.length ? diffs.join(' · ') : null })
        rows.push({ id: `${event.id}:requested`, atMs: event.createdAtMs, actor: requester, what: t`Requested activation · generation ${event.generation}`, detail: null })
      }
      else if (event.action === 'rollback') rows.push({ id: event.id, atMs: event.createdAtMs, actor: requester, what: t`Restored the previous profile and requested it`, detail: null })
      else if (event.action === 'reset') rows.push({ id: event.id, atMs: event.createdAtMs, actor: requester, what: t`Restored system defaults and requested them`, detail: null })
      else rows.push({ id: event.id, atMs: event.createdAtMs, actor: { kind: 'pod', name: 'pod' }, what: event.action === 'migration' ? t`Migrated sleep-stage settings into the profile` : t`Fell back to a compatible profile`, detail: event.reason })
      if (event.state === 'applied') rows.push({ id: `${event.id}:ack`, atMs: event.updatedAtMs, actor: { kind: 'pod', name: 'pod' }, what: t`Processor acknowledged generation ${event.generation}`, detail: null })
      if (event.state === 'failed') rows.push({ id: `${event.id}:failed`, atMs: event.updatedAtMs, actor: { kind: 'pod', name: 'pod' }, what: t`Processor rejected generation ${event.generation}`, detail: event.reason })
    }
    const splitLabel: Record<Split, string> = { tuning: t`tuning`, validation: t`validation`, holdout: t`holdout` }
    for (const job of jobs.slice(0, 20)) {
      if (job.state !== 'succeeded' && job.state !== 'failed') continue
      const index = finished.findIndex(f => f.id === job.id)
      const parsed = index >= 0 ? numericReportViewSchema.safeParse(summaries[index]?.data?.report) : null
      let detail: string | null = null
      if (parsed?.success) {
        const rows = nightScores(parsed.data, job.split, baselineLabel(job, previousHash)).filter(n => n.previous.heart_rate.mae !== null && n.saved.heart_rate.mae !== null)
        if (rows.length) {
          const avg = (pick: (n: NightScore) => number) => (rows.reduce((s, n) => s + pick(n), 0) / rows.length).toFixed(1)
          detail = t`${splitLabel[job.split]} HR error ${avg(n => n.previous.heart_rate.mae as number)} → ${avg(n => n.saved.heart_rate.mae as number)} bpm · ${shortDuration(job.updatedAtMs - job.createdAtMs)}`
        }
      }
      rows.push({ id: job.id, atMs: job.updatedAtMs, actor: { kind: 'pod', name: 'pod' },
        what: job.state === 'succeeded' ? t`Finished a backtest on ${splitLabel[job.split]} nights` : t`Backtest on ${splitLabel[job.split]} nights failed`,
        detail: job.state === 'failed' ? job.error : detail })
    }
    for (const d of datasets.data?.items ?? []) {
      rows.push({ id: d.id, atMs: d.createdAtMs, actor: { kind: 'pod', name: 'pod' }, what: t`Froze a dataset of ${d.manifest.splitProtocol.assignments.length} nights`, detail: null })
    }
    for (const i of imports.data?.items ?? []) {
      rows.push({ id: i.id, atMs: i.createdAtMs, actor: { kind: 'pod', name: 'pod' }, what: t`Stored a ${i.summary.source} reference import`, detail: t`${i.summary.accepted} records` })
    }
    return rows.sort((a, b) => b.atMs - a.atMs).map(row => ({ ...row, when: activityTime(row.atMs, nowMs, timezone, h24) }))
  }, [history.data, revisions.data, jobs, datasets.data, imports.data, summaries, finished, previousHash, nowMs, timezone, h24, t])

  /* ─── Render ────────────────────────────────────────────────────────── */
  const error = overview.error ?? status.error
  if (error) return <InlineError>{error.message}</InlineError>
  if (!overview.data || !binding || !saved || !draft || (savedId && !savedRevision.data) || (previousId && !previousRevision.data)) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10" />
        <div className="grid gap-4 @min-[1040px]:grid-cols-[minmax(0,1fr)_420px]">
          <Skeleton className="h-[520px]" />
          <Skeleton className="h-[520px]" />
        </div>
      </div>
    )
  }

  const event = status.data?.event ?? null
  const savedActor = savedRevision.data ? actorOf(savedRevision.data.requester, savedRevision.data.origin) : null
  const strip = lifecycle({
    nowMs,
    saved: savedRevision.data && savedActor ? { actor: savedActor, atMs: savedRevision.data.createdAtMs } : null,
    bindingUpdatedAtMs: binding.updatedAtMs,
    generation: binding.generation,
    request: event && status.data?.isCurrent
      ? { observedState: status.data.observedState, createdAtMs: event.createdAtMs, updatedAtMs: event.updatedAtMs, previousIsDefaults: event.previousRevisionId === null }
      : null,
    runtimeReported: overview.data.runtimeStatus === 'receipts_available',
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3.5 text-[13px]">
        <SegmentedControl
          ariaLabel={t`Biometric calibration side`}
          value={side}
          onChange={onSideChange}
          options={[{ value: 'left', label: leftName }, { value: 'right', label: rightName }]}
        />
        <LifecycleStrip {...strip} />
        <RestoreMenu className="ml-auto" disabled={saving} hasPrevious={binding.generation > 0} onSelect={setRestore} />
      </div>

      <div className="grid items-start gap-4 @min-[1040px]:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-4">
          <ProfileCard
            saved={saved}
            previous={previous ?? defaultConfig}
            previousIsDefaults={!previousId}
            draft={draft}
            onDraft={setDraft}
            disabled={saving}
            actor={savedActor}
            savedAgo={savedRevision.data ? activityTime(savedRevision.data.createdAtMs, nowMs, timezone, h24) : null}
            scores={scores}
          />
          <DatasetCard
            dataset={dataset}
            nights={nights}
            selected={selectedNight?.cohortId ?? null}
            onSelect={setSelected}
            onImport={() => onOpenTool('references')}
            onFreeze={setup.run}
            setup={setup.progress}
            timezone={timezone}
          />
          <WatchDeviationTrend side={side} timezone={timezone} />
          <SensorLine sensors={overview.data.sensorCalibration} hash={overview.data.desired.hash} />
        </div>

        <div className="flex min-w-0 flex-col gap-4 @min-[1040px]:sticky @min-[1040px]:top-4">
          <BacktestCard
            side={side}
            group={group}
            readiness={readiness}
            run={run}
            nights={nights}
            scores={scores}
            selected={selectedNight}
            onSelect={setSelected}
            trace={traceJob && traceSummary?.available ? { job: traceJob, contentHash: traceSummary.contentHash, previous: baselineLabel(traceJob, previousHash) } : null}
            timezone={timezone}
            h24={h24}
          />
          <div className="flex gap-2 text-[13px]">
            {/* Clean, the primary reads as the page's resting answer ("keep it"), not a dead control. */}
            <button
              type="button"
              disabled={saving}
              aria-disabled={!dirty || undefined}
              onClick={() => { if (dirty) void saveAndRequest() }}
              className={cn('flex-1 whitespace-nowrap rounded-ctl border-0 bg-fg p-[9px] font-medium text-inverse disabled:cursor-default disabled:opacity-45', dirty ? 'cursor-pointer' : 'cursor-default')}
            >
              {saving ? t`Saving…` : dirty ? t`Save and request` : t`Keep saved profile`}
            </button>
            <button
              type="button"
              disabled={binding.generation === 0 || saving}
              onClick={() => setRestore('previous')}
              className="cursor-pointer whitespace-nowrap rounded-ctl border border-line-2 bg-transparent px-3.5 py-[9px] text-fg-2 hover:text-fg disabled:cursor-default disabled:opacity-45"
            >
              {t`Restore previous`}
            </button>
          </div>
          <p className="text-center text-xs text-fg-3">
            {dirty ? t`Overwrites the saved profile and requests it; the current one becomes previous.` : t`Nothing changes until you move a control or restore.`}
          </p>
          {saveError ? <InlineError>{saveError}</InlineError> : null}
          <ActivityCard rows={activity} timezone={timezone} />
        </div>
      </div>

      {restore
        ? (
            <RestoreDialog
              key={`${restore}:${binding.generation}`}
              side={side}
              target={restore}
              binding={binding}
              onClose={() => setRestore(null)}
              onDone={() => {
                setRestore(null)
                refresh()
              }}
            />
          )
        : null}
    </div>
  )
}

function SensorLine({ sensors, hash }: { sensors: Array<{ id: number, sensorType: string, status: string, freshness: 'expired' | 'current' | 'unknown' }>, hash: string }) {
  const { t } = useLingui()
  const [full, setFull] = useState(false)
  const current = sensors.filter(s => s.status === 'completed')
  // One line, as the mock has it: sensors grouped by freshness ("capacitance, piezo current").
  const freshness = { current: t`current`, expired: t`expired`, unknown: t`freshness unknown` }
  const value = current.length
    ? (['current', 'expired', 'unknown'] as const).flatMap((f) => {
        const types = current.filter(s => s.freshness === f).map(s => s.sensorType)
        return types.length ? [`${types.join(', ')} ${freshness[f]}`] : []
      }).join(' · ')
    : t`not reported`
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[13px] text-fg-2">
      <span>
        {t`Measured sensor calibration for this side:`}
        {' '}
        <span className="font-mono">{value}</span>
        {t`. Separate from the profile.`}
      </span>
      <span className="font-mono text-xs">
        {t`config id`}
        {' '}
        <span className={full ? 'break-all' : undefined}>{full ? hash : `${hash.slice(0, 4)}…${hash.slice(-2)}`}</span>
        {' · '}
        <button type="button" onClick={() => setFull(!full)} className="cursor-pointer border-0 bg-transparent p-0 font-mono text-xs text-fg-3 hover:text-fg">
          {full ? t`hide` : t`show`}
        </button>
      </span>
    </div>
  )
}
