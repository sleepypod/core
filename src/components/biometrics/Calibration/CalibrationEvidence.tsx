'use client'

import { useLingui } from '@lingui/react/macro'
import { Upload } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Card, CardHeader } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import type { SetupProgress } from './evaluation-setup'
import {
  aggregate,
  barHeight,
  clockLabel,
  compareTone,
  coverage,
  nightLabel,
  shortDuration,
  TRACE,
  traceTicks,
  tracePath,
  type ConfigLabel,
  type JobLike,
  type NightScore,
  type RunStatus,
  type Split,
} from './calibration-model'

export interface DatasetNight {
  cohortId: string
  split: Split
  startMs: number
  endMs: number
  score: NightScore | null
  /** Reference sources ("watch + ring"); null = no reference for this night. */
  reference: string | null
}

const SPLIT_LETTER: Record<Split, string> = { tuning: 'T', validation: 'V', holdout: 'H' }
const splitTone = (split: Split) => split === 'holdout' ? 'text-warn' : 'text-fg-3'

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function formatDay(ms: number, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(ms)
  }
  catch {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(ms)
  }
}

/** The frozen nights the backtest replays, split whole into tuning/validation/holdout. */
export function DatasetCard({ dataset, nights, selected, onSelect, onImport, onFreeze, setup, timezone }: {
  dataset: { createdAtMs: number, byteLength: number, available: boolean } | null
  nights: DatasetNight[]
  selected: string | null
  onSelect: (cohortId: string) => void
  onImport: () => void
  onFreeze: () => void
  setup: SetupProgress
  timezone: string
}) {
  const { t } = useLingui()
  const counts = { tuning: 0, validation: 0, holdout: 0 }
  for (const n of nights) counts[n.split]++
  const sources = [...new Set(nights.flatMap(n => n.reference ? n.reference.split(' + ') : []))]
  const explainer = dataset
    ? sources.length
      ? t`Frozen copy of ${nights.length} nights and ${sources.join(' + ')} reference. Later edits or deletions do not touch it. Whole nights are split before scoring; a split is not evidence on its own.`
      : t`Frozen copy of ${nights.length} nights. Later edits or deletions do not touch it. Whole nights are split before scoring; a split is not evidence on its own.`
    : t`No dataset is frozen for this side yet. Freezing takes the newest nights a reference covers, with their RAW archives, so a backtest can replay them.`
  const running = !['idle', 'done', 'failed'].includes(setup.step)
  const status = {
    idle: null,
    linking: t`Linking Watch data already on the pod…`,
    choosing: t`Choosing nights the reference covers…`,
    freezing: t`Freezing the nights…`,
    inspecting: t`Reading RAW archives · ${setup.done ?? 0} / ${setup.total ?? 0}`,
    retaining: t`Retaining the archives…`,
    protocol: t`Setting up the replay…`,
    queueing: t`Queueing the backtest…`,
    done: t`Frozen and queued. The backtest replays every split; results appear as each finishes.`,
    failed: setup.error ?? t`Freezing failed.`,
  }[setup.step]
  return (
    <Card className="gap-3">
      <CardHeader
        title={t`Evaluation dataset`}
        subtitle={explainer}
        right={dataset && (
          <span className="whitespace-nowrap font-mono text-[11px] text-fg-2">
            {dataset.available ? t`frozen ${formatDay(dataset.createdAtMs, timezone)} · ${formatBytes(dataset.byteLength)}` : t`released`}
          </span>
        )}
      />
      {nights.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="listbox" aria-label={t`Dataset nights`}>
          {nights.map((n) => {
            const label = nightLabel(n.cohortId)
            const on = n.cohortId === selected
            return (
              <button
                key={n.cohortId}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onSelect(n.cohortId)}
                className={cn('flex min-w-[92px] cursor-pointer flex-col gap-0.5 rounded-ctl border px-2.5 py-1.5 text-left', on ? 'border-fg bg-active' : 'border-line bg-transparent hover:bg-active')}
              >
                <span className={cn('flex justify-between gap-2 text-xs', on ? 'text-fg' : 'text-fg-2')}>
                  {`${label.weekday} ${label.day}`}
                  <span className={cn('font-mono text-[10px] tracking-[0.06em]', splitTone(n.split))}>{SPLIT_LETTER[n.split]}</span>
                </span>
                <span className="font-mono text-[11px] text-fg-3">{n.reference ?? t`no reference`}</span>
              </button>
            )
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-3.5 text-xs text-fg-2">
        {nights.length > 0 && (
          <>
            <span>
              <span className="font-mono text-fg-3">T</span>
              {` ${t`tuning`} · ${counts.tuning}`}
            </span>
            <span>
              <span className="font-mono text-fg-3">V</span>
              {` ${t`validation`} · ${counts.validation}`}
            </span>
            <span>
              <span className="font-mono text-warn">H</span>
              {` ${t`holdout`} · ${counts.holdout}`}
            </span>
          </>
        )}
        <button type="button" onClick={onImport} className="ml-auto flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs text-fg-2 hover:text-fg">
          <Upload size={12} />
          {t`Import reference`}
        </button>
        <button type="button" disabled={running} onClick={onFreeze} className="cursor-pointer border-0 bg-transparent p-0 text-xs text-fg-2 hover:text-fg disabled:cursor-default disabled:opacity-45">{t`Freeze a new dataset`}</button>
      </div>
      {status && <p role="status" className={cn('font-mono text-[11px]', setup.step === 'failed' ? 'text-danger' : setup.step === 'done' ? 'text-ok' : 'text-warn')}>{status}</p>}
    </Card>
  )
}

const fmt1 = (v: number | null) => v === null ? '—' : v.toFixed(1)

/** "What the saved profile did": per-night error, one night's trace, and the split table. */
/** What is missing before a backtest can replay the saved profile. */
export type BacktestReadiness = 'no-reference' | 'no-dataset' | 'no-experiment' | 'ready'

export function BacktestCard({ side, group, readiness, run, nights, scores, selected, onSelect, trace, timezone, h24 }: {
  side: 'left' | 'right'
  group: { latest: JobLike } | null
  readiness: BacktestReadiness
  run: RunStatus | null
  nights: DatasetNight[]
  scores: NightScore[]
  selected: DatasetNight | null
  onSelect: (cohortId: string) => void
  trace: { job: JobLike, contentHash: string, previous: ConfigLabel } | null
  timezone: string
  h24: boolean
}) {
  const { t } = useLingui()
  const statusText = run && (run.kind === 'done' ? t`done · ${shortDuration(run.durationMs)}` : run.kind === 'running' ? t`running` : run.kind === 'queued' ? t`queued` : t`failed`)
  const statusTone = run ? { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', muted: 'text-fg-3' }[run.tone] : ''

  const pending = {
    'no-reference': t`No backtest yet. Import a reference for this side, then freeze nights that have it; the replay scores the previous and saved profiles against it. Nothing here changes the pod.`,
    'no-dataset': t`No backtest yet. Freeze a new dataset below; it replays the newest referenced nights through the previous and saved profiles. Nothing here changes the pod.`,
    'no-experiment': t`No backtest yet. This dataset has no waveform replay; freeze a new dataset below to set one up. Nothing here changes the pod.`,
    'ready': t`No backtest has replayed the saved profile yet. Saving a change replays the frozen dataset on its tuning, validation and holdout nights; nothing here changes the pod.`,
  }[readiness]

  // Up to two weeks of nights; older ones stay in the table aggregates.
  const shown: Array<DatasetNight | null> = nights.length ? nights.slice(-14) : Array.from({ length: 7 }, () => null)
  const split = (s: Split) => aggregate(scores, 'heart_rate', s)
  const rows: Array<{ label: string, trust?: boolean, previous: number | null, saved: number | null, unit: string, higherIsBetter?: boolean, percent?: boolean }> = [
    { label: t`HR error · tuning`, ...split('tuning'), unit: '' },
    { label: t`HR error · validation`, ...split('validation'), unit: '' },
    { label: t`HR error · holdout`, trust: true, ...split('holdout'), unit: '' },
    { label: t`Night covered`, ...coverage(scores), unit: '%', higherIsBetter: true, percent: true },
    { label: t`HRV index error`, ...aggregate(scores, 'window_ibi_variability_v1'), unit: ' ms' },
    { label: t`Breathing error`, ...aggregate(scores, 'breathing_rate'), unit: ' br/m' },
  ]
  const cell = (v: number | null, percent?: boolean, unit = '') => v === null ? '—' : percent ? `${Math.round(v * 100)}%` : `${v.toFixed(1)}${unit}`

  return (
    <Card className="gap-3.5">
      <CardHeader
        title={t`What the saved profile did`}
        subtitle={<span className="text-xs">{group ? t`Backtest ${group.latest.id.slice(0, 4)}. Frozen dataset replayed through the previous and saved profiles; nothing here changes the pod.` : pending}</span>}
        right={statusText
          ? <span className={cn('whitespace-nowrap font-mono text-[11px]', statusTone)}>{statusText}</span>
          : <span className="whitespace-nowrap font-mono text-[11px] text-fg-3">{t`not run`}</span>}
      />

      <div className="flex items-baseline justify-between text-xs text-fg-2">
        <span>{t`HR error per night · bpm vs reference`}</span>
        <span className="font-mono text-[11px] text-fg-3">{t`click a night`}</span>
      </div>
      <div className="grid gap-2 px-0.5" style={{ gridTemplateColumns: `repeat(${Math.max(shown.length, 1)}, minmax(0, 1fr))` }}>
        {shown.map((n, i) => {
          if (!n) {
            return (
              <div key={i} aria-hidden className="flex flex-col gap-1">
                <div className="h-[72px] w-full border-b border-line" />
                <div className="font-mono text-[10px] text-fg-3">·</div>
                <div className="flex flex-col gap-px font-mono text-[10px] text-fg-3">
                  <span>—</span>
                  <span>—</span>
                </div>
              </div>
            )
          }
          const on = n.cohortId === selected?.cohortId
          const prev = n.score?.previous.heart_rate.mae ?? null, saved = n.score?.saved.heart_rate.mae ?? null
          const label = nightLabel(n.cohortId)
          return (
            <button
              key={n.cohortId}
              type="button"
              aria-label={t`${label.weekday} ${label.day}: previous ${fmt1(prev)}, saved ${fmt1(saved)} bpm`}
              aria-pressed={on}
              onClick={() => onSelect(n.cohortId)}
              className="flex cursor-pointer flex-col gap-1 border-0 bg-transparent p-0"
            >
              <div className="flex h-[72px] w-full items-end gap-0.5 border-b border-line">
                <div className="flex-1 rounded-t-[2px] bg-calib-prev" style={{ height: barHeight(prev) }} />
                <div className={cn('flex-1 rounded-t-[2px]', n.score?.hasReference ? 'bg-calib-saved' : 'bg-calib-none')} style={{ height: barHeight(saved) }} />
              </div>
              <div className={cn('flex w-full justify-between font-mono text-[10px]', on ? 'text-fg' : 'text-fg-3')}>
                {label.weekday.slice(0, 2)}
                <span className={splitTone(n.split)}>{SPLIT_LETTER[n.split]}</span>
              </div>
              <div className="flex w-full flex-col gap-px text-left font-mono text-[10px]">
                <span className="text-fg-2">{fmt1(prev)}</span>
                <span className={n.score?.hasReference ? 'text-calib-saved' : 'text-fg-3'}>{fmt1(saved)}</span>
              </div>
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-3 font-mono text-[11px] text-fg-2">
        <span>
          <span className="mr-[5px] inline-block size-2 rounded-[2px] bg-calib-prev" />
          {t`previous`}
        </span>
        <span>
          <span className="mr-[5px] inline-block size-2 rounded-[2px] bg-calib-saved" />
          {t`saved`}
        </span>
        <span className="text-warn">{t`H holdout`}</span>
      </div>

      <div className="h-px bg-line" />
      {selected && trace && trace.job.evaluationScope === 'retained_waveform_replay'
        ? <NightTrace key={`${trace.job.id}:${selected.cohortId}`} side={side} night={selected} trace={trace} timezone={timezone} h24={h24} />
        : (
            <p className="text-xs text-fg-2">
              {selected && trace
                ? t`This backtest compared stored readings, so there is no recomputed heart-rate trace to draw.`
                : group ? t`Pick a scored night to see its heart-rate trace.` : t`Each night's heart rate against the reference appears here once a backtest has run.`}
            </p>
          )}

      <div className="h-px bg-line" />
      <div className="grid grid-cols-[minmax(0,1fr)_72px_72px] items-baseline gap-x-3 gap-y-2 text-[13px]">
        <span />
        <span className="text-right font-mono text-[11px] text-fg-3">{t`previous`}</span>
        <span className="text-right font-mono text-[11px] text-fg-3">{t`saved`}</span>
        {rows.map((r) => {
          const tone = compareTone(r.previous, r.saved, r.higherIsBetter)
          return (
            <div key={r.label} className="contents">
              <span className={r.trust ? 'text-fg' : 'text-fg-2'}>{r.label}</span>
              <span className="text-right font-mono text-fg-2">{cell(r.previous, r.percent, r.unit)}</span>
              <span className={cn('text-right font-mono', tone === 'better' ? 'text-calib-better' : tone === 'worse' ? 'text-warn' : 'text-fg')}>{cell(r.saved, r.percent, r.unit)}</span>
            </div>
          )
        })}
      </div>
      <p className="text-xs text-fg-3">{t`Holdout is the number to trust; tuning nights were used to pick these values.`}</p>
    </Card>
  )
}

/** One night: reference, previous and saved heart rate on a 40–100 bpm scale. */
function NightTrace({ side, night, trace, timezone, h24 }: {
  side: 'left' | 'right'
  night: DatasetNight
  trace: { job: JobLike, contentHash: string, previous: ConfigLabel }
  timezone: string
  h24: boolean
}) {
  const { t } = useLingui()
  const base = { id: trace.job.id, expectedContentHash: trace.contentHash, cohortId: night.cohortId, offset: 0, limit: 500 }
  const saved = trpc.biometricTuning.getBacktestNumericTrace.useQuery({ ...base, configuration: 'candidate' }, { staleTime: Infinity })
  const previous = trpc.biometricTuning.getBacktestNumericTrace.useQuery({ ...base, configuration: trace.previous }, { staleTime: Infinity })
  const reference = trpc.biometricTuning.getBacktestReferenceTrace.useQuery({ id: trace.job.id, expectedContentHash: trace.contentHash, cohortId: night.cohortId, metric: 'heart_rate', offset: 0, limit: 500 },
    { staleTime: Infinity, enabled: night.reference !== null })
  const label = nightLabel(night.cohortId)
  const savedSide = (saved.data?.items ?? []).filter(i => i.side === side)
  const points = (rows: Array<{ timestampMs: number, heartRate: number | null }>) => rows.map(r => ({ t: r.timestampMs, v: r.heartRate }))
  const refPoints = (reference.data?.items ?? []).filter(r => r.compatibility === null && typeof r.value === 'number').map(r => ({ t: r.startMs, v: r.value as number }))
  const truncated = Boolean(saved.data?.nextCursor || previous.data?.nextCursor || reference.data?.nextCursor)
  const ticks = traceTicks(night.startMs, night.endMs)
  const yAt = (bpm: number) => TRACE.height - ((bpm - TRACE.minBpm) / (TRACE.maxBpm - TRACE.minBpm)) * TRACE.height
  const quality = savedSide.length ? savedSide.reduce((s, r) => s + (r.qualityScore ?? 0), 0) / savedSide.length : null
  const note = night.reference === null
    ? t`no reference device · excluded from error`
    : quality === null ? night.reference : `${night.reference} · ${t`quality`} ${quality.toFixed(2)}`
  return (
    <>
      <div className="flex items-baseline justify-between text-xs text-fg-2">
        <span>{t`Heart rate · ${label.weekday} ${label.day}`}</span>
        <span className="font-mono text-[11px] text-fg-3">{note}</span>
      </div>
      <div className="relative rounded-ctl border border-line bg-app px-2.5 pb-1.5 pt-2.5">
        <svg width="100%" height="120" viewBox={`0 0 ${TRACE.width} ${TRACE.height}`} preserveAspectRatio="none" className="block" role="img" aria-label={t`Heart-rate trace`}>
          {[100, 70, 40].map(bpm => <line key={bpm} x1="0" y1={Math.min(yAt(bpm), TRACE.height - 1)} x2={TRACE.width} y2={Math.min(yAt(bpm), TRACE.height - 1)} stroke="var(--border-1)" />)}
          <path d={tracePath(refPoints, night.startMs, night.endMs)} fill="none" stroke="var(--text-2)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
          <path d={tracePath(points(previous.data?.items ?? []), night.startMs, night.endMs)} fill="none" stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <path d={tracePath(points(savedSide), night.startMs, night.endMs)} fill="none" stroke="var(--calib-saved)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="flex justify-between pt-1 font-mono text-[10px] text-fg-3">
          {ticks.map(tick => <span key={tick}>{clockLabel(tick, timezone, h24)}</span>)}
        </div>
        <div className="pointer-events-none absolute right-3 top-2.5 flex flex-col items-end gap-[34px] font-mono text-[10px] text-fg-3">
          <span>100</span>
          <span>70</span>
          <span>40</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 font-mono text-[11px] text-fg-2">
        <span className="text-calib-saved">{`— ${t`saved`}`}</span>
        <span className="text-fg-3">{`┄ ${t`previous`}`}</span>
        <span>{`— ${t`reference`}`}</span>
        {truncated && <span className="text-fg-3">{t`first 500 readings`}</span>}
      </div>
    </>
  )
}
