'use client'

import { useState, type FormEvent } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Button } from '@/src/components/ds'
import type { Side } from '@/src/hardware/types'
import type { PreviewReportItem } from '@/src/comfort/report-contract'

function duration(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000)
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
function reportLabel(item: PreviewReportItem) {
  if (item.summary.state === 'source_expired') return 'Source expired'
  if (item.review && !item.reviewCurrent) return 'Review needs refreshing'
  if (item.countsAsOwnerConfirmedNight) return 'Owner confirmed'
  if (item.review?.outcome === 'needs_retest') return 'Retest requested'
  return item.summary.state === 'collecting' ? 'Collecting' : item.summary.reviewable ? 'Ready for review' : 'Needs more evidence'
}

export function PreviewNightReports({ side }: { side: Side }) {
  const [selection, setSelection] = useState<{ side: Side, id: string } | null>(null)
  const selected = selection?.side === side ? selection.id : null
  const reports = trpc.comfort.reports.useQuery({ side }, { refetchInterval: 60_000 })
  return (
    <section className="mt-6 border-t border-line pt-5" aria-label="Preview night reports">
      <h3 className="font-medium">Preview night reports</h3>
      <p className="mt-1 text-sm text-fg-2">Review recorded proposals, holds and gaps before confirming a real overnight session. Baseline-data dates are separate.</p>
      {reports.isLoading && <p className="mt-3 text-sm" role="status">Reading Preview reports…</p>}
      {reports.error
        ? <p className="mt-3 text-sm text-danger" role="alert">Reports could not be refreshed. Night progress is unavailable.</p>
        : reports.data && (
          <>
            <p className="mt-3 text-sm">{`Owner-confirmed nights: ${reports.data.ownerConfirmedNights} / ${reports.data.targetNights} minimum`}</p>
            <p className="mt-1 text-xs text-fg-2">Confirmation requires at least four hours of fresh occupied observation intervals. These are sampled checks, not measured sleep duration. Reviews never activate the bed.</p>
            {reports.data.items.length === 0
              ? <p className="mt-3 text-sm text-fg-2">No overnight Preview report has been recorded.</p>
              : (
                  <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                    {reports.data.items.map(item => (
                      <li key={item.summary.id}>
                        <button className="w-full rounded-ctl border border-line p-3 text-left text-sm hover:bg-active" onClick={() => setSelection({ side, id: item.summary.id })} aria-pressed={selected === item.summary.id}>
                          <span className="block font-medium">{item.summary.localDate}</span>
                          <span className="mt-1 block text-xs text-fg-2">{`${reportLabel(item)} · ${item.summary.observationCount} checks · ${duration(item.summary.occupiedObservationMs)} occupied intervals`}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
          </>
        )}
      {selected && <NightReport key={`${side}:${selected}`} side={side} id={selected} />}
    </section>
  )
}

function NightReport({ side, id }: { side: Side, id: string }) {
  const [afterId, setAfterId] = useState<number | undefined>()
  // Retain the current page while fetching so paging does not collapse details or erase review drafts.
  const report = trpc.comfort.report.useQuery({ side, id, afterId }, { placeholderData: previous => previous })
  const utils = trpc.useUtils()
  const review = trpc.comfort.reviewReport.useMutation({ onSuccess: () => {
    void utils.comfort.reports.invalidate({ side })
    void utils.comfort.report.invalidate({ side, id })
  } })
  const data = report.data
  const clock = (at: number) => new Date(at).toLocaleString(undefined, { timeZone: data?.summary.metadata.timezone ?? 'UTC', dateStyle: 'medium', timeStyle: 'short' })
  const range = (values: { minimum: number, maximum: number } | null) => values ? `${values.minimum}–${values.maximum}°F` : 'Unavailable'
  return (
    <div className="mt-4 space-y-4 rounded-ctl border border-line p-4 text-sm" aria-label="Selected Preview report">
      {report.isLoading && <p role="status">Reading recorded observations…</p>}
      {report.error && <p role="alert" className="text-danger">The report is unavailable. Refresh before reviewing.</p>}
      {data && !report.error && (
        <>
          <div>
            <h4 className="font-medium">{`${data.summary.localDate} · ${reportLabel(data)}`}</h4>
            <p className="mt-1 text-xs text-fg-2">{`${clock(data.summary.metadata.start)} → ${clock(data.summary.metadata.end)} (${data.summary.metadata.timezone})`}</p>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs text-fg-2">Recorded occupied intervals</dt>
              <dd>{duration(data.summary.occupiedObservationMs)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-2">Proposals / recorded checks</dt>
              <dd>{`${data.summary.eligibleCount} / ${data.summary.observationCount}`}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-2">Sensor-ready checks</dt>
              <dd>{`${data.summary.sensorReadyCount} / ${data.summary.observationCount}`}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-2">Manual-pause checks</dt>
              <dd>{data.summary.manualPauseCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-2">Proposed targets</dt>
              <dd>{range(data.summary.proposedRangeF)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-2">Reported targets</dt>
              <dd>{range(data.summary.reportedRangeF)}</dd>
            </div>
          </dl>
          <p className="text-xs text-fg-2">{`${data.summary.runs} runtime session(s) · ${data.summary.configurations} configuration(s) · ${data.summary.gapCount} journal gap(s) over 90 seconds. First/last recorded checks: ${clock(data.summary.firstAt)} / ${clock(data.summary.lastAt)}.`}</p>
          {data.summary.issues.length > 0 && <ul className="list-disc space-y-1 pl-5 text-fg-2">{data.summary.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
          <details>
            <summary className="cursor-pointer">Recorded reasons and gaps</summary>
            <ul className="mt-2 space-y-2 text-xs text-fg-2">{data.summary.reasons.map(reason => <li key={reason.message}>{`${reason.count} checks: ${reason.message}`}</li>)}</ul>
            <ul className="mt-3 space-y-1 text-xs text-fg-2">{data.summary.gaps.map((gap, index) => <li key={index}>{`${clock(gap.from)} → ${clock(gap.to)}: no continuous journal coverage`}</li>)}</ul>
            {data.summary.gapCount > data.summary.gaps.length && <p className="mt-1 text-xs text-fg-2">Showing the first 20 gaps.</p>}
          </details>
          <details>
            <summary className="cursor-pointer">Recorded observations</summary>
            <ol className="mt-3 max-h-72 space-y-3 overflow-y-auto text-xs">
              {data.observations.map(observation => (
                <li key={observation.id}>
                  <time dateTime={new Date(observation.at).toISOString()}>{clock(observation.at)}</time>
                  <p className="text-fg-2">{observation.message}</p>
                  <p>{`Proposed ${observation.proposedF === null ? 'unavailable' : `${observation.proposedF}°F`} · reported ${observation.reportedF === null ? 'unavailable' : `${observation.reportedF}°F`}`}</p>
                </li>
              ))}
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              {afterId !== undefined && <Button disabled={report.isFetching} onClick={() => setAfterId(undefined)}>First observations</Button>}
              {data.nextAfterId !== null && <Button disabled={report.isFetching} onClick={() => setAfterId(data.nextAfterId ?? undefined)}>Next observations</Button>}
            </div>
          </details>
          {data.review && <p className="text-xs text-fg-2">{`Saved review (${clock(data.review.at)}): ${data.review.outcome === 'reviewed' ? 'owner confirmed actual night' : 'needs retest'}. ${data.review.note}`}</p>}
          {data.summary.state === 'closed' && (
            <form
              key={`${data.summary.digest}:${data.review?.id ?? 'none'}`}
              className="space-y-3 border-t border-line pt-4"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault()
                const values = new FormData(event.currentTarget)
                review.mutate({ side, id, digest: data.summary.digest, expectedReviewId: data.review?.id ?? null,
                  outcome: values.get('outcome') === 'reviewed' ? 'reviewed' : 'needs_retest',
                  confirmedActualNight: values.get('actualNight') === 'on', note: String(values.get('note') ?? '') })
              }}
            >
              <label className="grid gap-1">
                Review conclusion
                <select name="outcome" className="rounded-ctl border border-line bg-surface p-2" defaultValue="needs_retest">
                  <option value="needs_retest">Needs more observation or retest</option>
                  <option value="reviewed" disabled={!data.summary.reviewable}>Reviewed actual Preview night</option>
                </select>
              </label>
              <label className="flex items-start gap-3">
                <input type="checkbox" name="actualNight" className="mt-1 accent-primary" />
                <span>I used this side for an actual overnight Preview session and reviewed these observations.</span>
              </label>
              <label className="grid gap-1">
                Review notes
                <textarea name="note" maxLength={2000} rows={3} className="w-full rounded-ctl border border-line bg-surface p-2" />
              </label>
              <Button type="submit" disabled={review.isPending || report.isFetching}>Save review</Button>
            </form>
          )}
        </>
      )}
      {review.error && <p role="alert" className="text-danger">{`${review.error.message} Refresh the report before retrying.`}</p>}
      {review.isSuccess && <p role="status" className="text-fg-2">Review saved. Activation requires a separate owner review.</p>}
      <Button
        disabled={report.isFetching || review.isPending}
        onClick={() => {
          review.reset()
          void report.refetch()
        }}
      >
        Refresh report
      </Button>
    </div>
  )
}
