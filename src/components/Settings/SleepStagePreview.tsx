'use client'

import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { Button, Card, InlineError, SegmentedControl, Skeleton, StageBar } from '@/src/components/ds'
import { formatDurationHM } from '@/src/lib/sleep-stages'
import type { StageClassifier } from '@/src/lib/sleep-stage-rules'
import { pct as percent, shortDate, STAGE_COLOR, STAGE_LABELS } from './sleepStageEditing'

export type PreviewOutput = inferRouterOutputs<AppRouter>['sleepStages']['previewClassifier']
export type ClassifierChange = inferRouterOutputs<AppRouter>['sleepStages']['getClassifier']['changes'][number]
export type PreviewNights = 1 | 7

const NIGHT_OPTIONS = [{ value: '1', label: 'Last night' }, { value: '7', label: '7 nights' }]

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`

/**
 * The saved rules against the draft over the previewed nights: stage split
 * and quality of each, where they disagree, and what the draft would change.
 */
export function StagePreviewCard({ data, error, nights, onNightsChange, dirty, canSave, saving, onSave, onDiscard }: {
  data: PreviewOutput | undefined
  error: string | null
  nights: PreviewNights
  onNightsChange: (n: PreviewNights) => void
  dirty: boolean
  canSave: boolean
  saving: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  const saved = data?.saved ?? null
  const candidate = data?.candidate ?? null
  const perNight = nights > 1 ? ' per night' : ''

  const deltaRow = (label: string, from: string | null, to: string | null) => (
    <div className="flex justify-between gap-3 text-[13px]">
      <span className="text-fg-2">{label}</span>
      <span className="font-mono">{from === null || to === null ? '—' : from === to ? to : `${from} → ${to}`}</span>
    </div>
  )

  return (
    <>
      <Card>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px] font-medium">Preview</span>
          <SegmentedControl
            size="sm"
            ariaLabel="Preview nights"
            value={String(nights)}
            options={NIGHT_OPTIONS}
            onChange={v => onNightsChange(v === '7' ? 7 : 1)}
          />
        </div>
        {error && <InlineError>{error}</InlineError>}
        {!data && !error && <Skeleton className="h-[120px]" />}
        {data && !saved && !candidate && <span className="text-[13px] text-fg-2">No night with vitals to preview yet.</span>}
        {data && (saved || candidate) && (
          <div className="flex flex-col gap-3.5">
            <PreviewRow label="Saved" stages={saved} />
            <PreviewRow label="These rules" stages={candidate} />
            {data.changed && data.enteredBedAt !== null && data.leftBedAt !== null && (
              <ChangedStrip changed={data.changed} start={data.enteredBedAt} end={data.leftBedAt} />
            )}
            <div className="h-px bg-line" />
            <div className="flex flex-col gap-2">
              {deltaRow(`Wake${perNight}`, saved ? formatDurationHM(saved.durations.wake) : null, candidate ? formatDurationHM(candidate.durations.wake) : null)}
              {deltaRow(`Deep${perNight}`, saved ? formatDurationHM(saved.durations.deep) : null, candidate ? formatDurationHM(candidate.durations.deep) : null)}
              {data.hasReference
                ? deltaRow('Agreement with watch', saved?.agreement ? pct(saved.agreement.accuracy) : null, candidate?.agreement ? pct(candidate.agreement.accuracy) : null)
                : <span className="text-xs text-fg-3">Import Apple Watch stages from the iOS app to see how closely each set of rules agrees with it.</span>}
            </div>
            <div className="flex gap-3 font-mono text-[11px]">
              {(['wake', 'rem', 'light', 'deep'] as const).map(s => <span key={s} style={{ color: STAGE_COLOR[s] }}>{STAGE_LABELS[s]}</span>)}
            </div>
          </div>
        )}
      </Card>
      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" disabled={!dirty || !canSave || saving} onClick={onSave}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button disabled={!dirty || saving} onClick={onDiscard}>Discard</Button>
      </div>
      <span className="text-center text-xs text-fg-3">Past nights are re-scored too.</span>
    </>
  )
}

function PreviewRow({ label, stages }: { label: string, stages: NonNullable<PreviewOutput['saved']> | null }) {
  if (!stages) return null
  const d = stages.distribution
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span>{label}</span>
        <span className="font-mono text-fg-2" aria-label={`${label} quality`}>
          {`Q ${stages.qualityScore}`}
          {stages.agreement?.kappa != null && ` · κ ${stages.agreement.kappa.toFixed(2)}`}
        </span>
      </div>
      <StageBar awake={d.wake} rem={d.rem} light={d.light} deep={d.deep} />
    </div>
  )
}

/** Where the draft disagrees with the saved rules across the latest night. */
function ChangedStrip({ changed, start, end }: { changed: NonNullable<PreviewOutput['changed']>, start: number, end: number }) {
  const span = Math.max(1, end - start)
  const at = (t: number) => `${Math.min(100, Math.max(0, ((t - start) / span) * 100))}%`
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs text-fg-2">
        <span>Changed epochs</span>
        <span className="font-mono">{`${percent(changed.changed, changed.total)}%`}</span>
      </div>
      <div className="relative h-1" aria-label="Changed epochs">
        {changed.segments.map((s, i) => (
          <span
            key={i}
            className="absolute inset-y-0 rounded-sm bg-fg"
            style={{ left: at(s.start), width: `calc(${at(s.end)} - ${at(s.start)})` }}
          />
        ))}
      </div>
    </div>
  )
}

/** Recent saves with their effect on watch agreement, each revertable. */
export function ChangesCard({ changes, onRevert, disabled }: {
  changes: ClassifierChange[]
  onRevert: (classifier: StageClassifier | null) => void
  disabled?: boolean
}) {
  return (
    <Card>
      <span className="text-[15px] font-medium">Changes</span>
      {changes.length === 0 && <span className="text-[13px] text-fg-2">Nothing changed yet. Saved changes and their effect show here.</span>}
      {changes.map((ch) => {
        const before = ch.agreementBefore
        const after = ch.agreementAfter
        const tone = before === null || after === null ? 'text-fg-3' : after > before ? 'text-ok' : after < before ? 'text-warn' : 'text-fg-2'
        return (
          <div key={ch.id} className="flex flex-col gap-1 border-t border-line py-2.5">
            <div className="flex justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate">{ch.summary}</span>
              <span className="shrink-0 font-mono text-[11px] text-fg-3">{shortDate(ch.changedAt)}</span>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className={`font-mono ${tone}`}>
                {before === null || after === null ? 'no watch data' : `watch ${pct(before)} → ${pct(after)}`}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRevert(ch.before)}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs text-fg-2 hover:text-fg disabled:cursor-default disabled:opacity-45"
              >
                Revert
              </button>
            </div>
          </div>
        )
      })}
    </Card>
  )
}
