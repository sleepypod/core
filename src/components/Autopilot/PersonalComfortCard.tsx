'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Button, SegmentedControl } from '@/src/components/ds'
import { useSideNames } from '@/src/hooks/useSideNames'
import type { Side } from '@/src/hardware/types'
import type { ComfortStatus } from '@/src/comfort/contract'
import type { ComfortConfig, ComfortFeedback } from '@/src/comfort/policy'
import { Card } from './primitives'
import { ComfortSignals } from './ComfortSignals'
import { ComfortOwnerReview } from './ComfortOwnerReview'
import { PreviewNightReports } from './PreviewNightReports'

const fieldClass = 'rounded-ctl border border-line bg-surface px-3 py-2 text-sm text-fg'

export function PersonalComfortCard() {
  const [side, setSide] = useState<Side>('left')
  const { sideName } = useSideNames()
  const utils = trpc.useUtils()
  const query = trpc.comfort.get.useQuery({ side }, { refetchInterval: 5_000 })
  const refresh = () => {
    void utils.comfort.get.invalidate()
  }
  const configuration = trpc.comfort.configure.useMutation({ onSuccess: refresh })
  const mode = trpc.comfort.mode.useMutation({ onSuccess: refresh })
  const feedback = trpc.comfort.feedback.useMutation({ onSuccess: refresh })
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Personal comfort</h2>
          <p className="mt-1 text-sm text-fg-2">Learn from your check-ins. Review proposed changes before activation.</p>
        </div>
        <SegmentedControl
          ariaLabel="Personal comfort side"
          value={side}
          onChange={(value) => {
            configuration.reset()
            mode.reset()
            feedback.reset()
            setSide(value)
          }}
          options={(['left', 'right'] as const).map(value => ({ value, label: sideName(value) }))}
        />
      </div>
      {query.isLoading && <p className="mt-4 text-sm text-fg-2" role="status">Reading personal comfort settings…</p>}
      {query.error && <p className="mt-4 text-sm text-danger" role="alert">Could not refresh personal comfort. Displayed observations may be old.</p>}
      {query.data && (
        <PersonalComfortDetails
          key={`${side}:${JSON.stringify(query.data.state?.config)}`}
          data={query.data}
          pending={configuration.isPending || mode.isPending || feedback.isPending || Boolean(query.error)}
          onConfigure={config => configuration.mutate({ side, config })}
          onMode={value => mode.mutate({ side, mode: value })}
          onFeedback={report => feedback.mutate({ side, feedback: report })}
        />
      )}
      {(configuration.error || mode.error || feedback.error) && <p className="mt-4 text-sm text-danger" role="alert">{configuration.error?.message ?? mode.error?.message ?? feedback.error?.message}</p>}
      {query.data?.features.nightReports && <PreviewNightReports key={side} side={side} />}
      {query.data?.features.ownerActivation && <ComfortOwnerReview key={`owner:${side}:${JSON.stringify(query.data.state?.config)}`} side={side} />}
      {feedback.isSuccess && <p className="mt-3 text-sm text-fg-2" role="status">Check-in saved.</p>}
    </Card>
  )
}

export function PersonalComfortDetails({ data, pending, onConfigure, onMode, onFeedback }: {
  data: ComfortStatus
  pending: boolean
  onConfigure(config: ComfortConfig): void
  onMode?(mode: 'off' | 'preview'): void
  onFeedback(feedback: ComfortFeedback): void
}) {
  const state = data.state
  const clock = (at: number) => new Date(at).toLocaleString(undefined, { timeZone: data.timezone ?? 'UTC', dateStyle: 'medium', timeStyle: 'short' })
  const saveRange = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!state) return
    const fields = new FormData(event.currentTarget)
    onConfigure({ ...state.config, mode: state.config.mode === 'preview' ? 'preview' : 'off', minimumF: Number(fields.get('minimum')), maximumF: Number(fields.get('maximum')) })
  }
  const saveFeedback = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    onFeedback({ date: String(fields.get('date')), comfort: String(fields.get('comfort')) as ComfortFeedback['comfort'] })
  }
  return (
    <div className="mt-5 space-y-5">
      <div className="rounded-ctl border border-line bg-active p-4 text-sm">
        <p className="font-medium">{state?.config.mode === 'preview' ? 'Preview only' : state?.config.mode === 'active' ? data.activation.current ? 'Active personal comfort' : 'Activation withheld' : 'Personal comfort off'}</p>
        <p className="mt-1 text-fg-2">{state?.config.mode === 'active' ? 'Bounded thermal adjustments use your existing routine. Manual controls and live safety guards retain priority.' : 'Preview does not adjust the bed. Your existing routines and rules continue.'}</p>
        <p className="mt-2">{data.fault ?? data.decision?.reason ?? (data.evaluatedAt === null ? 'No evaluation recorded yet.' : 'Waiting for a current evaluation.')}</p>
        {data.evaluatedAt !== null && (
          <p className="mt-2 text-xs text-fg-2">
            Last evaluation:
            {' '}
            <time dateTime={new Date(data.evaluatedAt).toISOString()}>{clock(data.evaluatedAt)}</time>
          </p>
        )}
        {data.runtime === 'stopped' && <p className="mt-2 text-fg-2">The Preview service is stopped.</p>}
      </div>
      {data.learning && (
        <div className="rounded-ctl border border-line p-4 text-sm">
          <h3 className="font-medium">Learning from similar nights</h3>
          <p className="mt-2 text-fg-2">{data.learning.reason}</p>
          <p className="mt-2">{`${data.learning.nights} matched nights · ${data.learning.requiredNights} minimum · ${data.learning.validationNights} later nights held out for validation`}</p>
          {data.learning.modelErrorF !== null && <p className="mt-2 text-xs text-fg-2">{`Comfort-label error: model ${data.learning.modelErrorF.toFixed(2)}°F · simpler baseline ${data.learning.baselineErrorF?.toFixed(2)}°F`}</p>}
          {data.learning.suggestedOffsetF !== null && <p className="mt-2">{`Research suggestion: ${data.learning.suggestedOffsetF > 0 ? '+' : ''}${data.learning.suggestedOffsetF}°F. Not applied to the bed.`}</p>}
        </div>
      )}
      {state && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={pending || (Boolean(data.fault) && state.config.mode !== 'preview')}
              variant="primary"
              onClick={() => {
                const next = state.config.mode !== 'off' ? 'off' : 'preview'
                if (onMode) onMode(next)
                else onConfigure({ ...state.config, mode: next })
              }}
            >
              {state.config.mode === 'active' ? 'Stop personal comfort' : state.config.mode === 'preview' ? 'Stop Preview' : 'Start Preview'}
            </Button>
            <span className="text-sm text-fg-2">
              {`Learned offset ${state.offsetF > 0 ? '+' : ''}${state.offsetF}°F · maximum change 1°F`}
            </span>
          </div>
          {state.pausedUntil > data.generatedAt && (
            <p className="text-sm text-fg-2">
              {`Manual pause until ${clock(state.pausedUntil)}.`}
            </p>
          )}
          {data.decision?.eligible && data.decision.proposedF !== null && (
            <p className="text-sm">
              Proposed target:
              {' '}
              <strong>
                {data.decision.proposedF}
                °F
              </strong>
              . This is a proposal, not a hardware action.
            </p>
          )}
          {data.features.roomAware && (
            <div className="space-y-3">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={state.config.roomAware === true}
                  disabled={pending || Boolean(data.fault)}
                  onChange={event => onConfigure({ ...state.config, mode: state.config.mode === 'preview' ? 'preview' : 'off', roomAware: event.target.checked })}
                />
                <span>
                  Include bedroom climate
                  <span className="mt-1 block text-xs text-fg-2">Qualified temperature and humidity can add up to 1°F within the total 3°F comfort offset. Stale or conflicting inputs hold adjustments. Your wake-up warming and vibration keep priority.</span>
                </span>
              </label>
              {state.config.roomAware && (
                <div aria-label="Bedroom comfort contribution" className="rounded-ctl border border-line p-3 text-sm">
                  <p>
                    {data.bedroom?.state === 'ready' && data.bedroom.expiresAt !== null && data.bedroom.expiresAt <= data.generatedAt
                      ? 'Bedroom readings expired. Waiting for new readings.'
                      : data.bedroom?.reason ?? 'Waiting for a current bedroom evaluation.'}
                  </p>
                  <Link href="/home" className="mt-2 inline-block text-xs text-cool underline">Review bedroom devices and freshness</Link>
                </div>
              )}
            </div>
          )}
          {data.features.sensorAware && (
            <div className="space-y-3">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={state.config.sensorAware === true}
                  disabled={pending || Boolean(data.fault)}
                  onChange={event => onConfigure({ ...state.config, mode: state.config.mode === 'preview' ? 'preview' : 'off', sensorAware: event.target.checked, followBedtime: event.target.checked && state.config.followBedtime === true })}
                />
                <span>
                  Use Pod sensor guard in Preview
                  <span className="mt-1 block text-xs text-fg-2">Hold proposals when qualified readings are missing or both recent summaries differ substantially from your baseline.</span>
                </span>
              </label>
              {state.config.sensorAware && <ComfortSignals signals={data.signals} />}
            </div>
          )}
          {data.features.followBedtime && (
            <div className="space-y-2 text-sm">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={state.config.followBedtime === true}
                  disabled={pending || Boolean(data.fault) || !state.config.sensorAware}
                  onChange={event => onConfigure({ ...state.config, mode: state.config.mode === 'preview' ? 'preview' : 'off', followBedtime: event.target.checked })}
                />
                <span>
                  Follow earlier or later bed entry in Preview
                  <span className="mt-1 block text-xs text-fg-2">Requires the Pod sensor guard and ten minutes of observed presence. Temperature phases shift by at most 30 minutes; power and alarms stay fixed. Bed entry is not measured sleep onset.</span>
                </span>
              </label>
              {state.config.followBedtime && (
                <div className="rounded-ctl border border-line p-3" aria-label="Bed-entry timing observation">
                  <p>{data.timing?.reason ?? 'Waiting for a current bed-entry evaluation.'}</p>
                  {data.timing?.selection && (
                    <p className="mt-1 text-xs text-fg-2">
                      {`Observed entry ${clock(data.timing.selection.entryAt)} · selected shift ${data.timing.selection.shiftMinutes > 0 ? '+' : ''}${data.timing.selection.shiftMinutes} min.`}
                    </p>
                  )}
                  {data.timing?.state === 'ready' && (
                    <p className="mt-1 text-xs text-fg-2">{`Scheduled baseline ${data.timing.scheduledBaselineF}°F · timing Preview baseline ${data.timing.phaseBaselineF}°F.`}</p>
                  )}
                </div>
              )}
            </div>
          )}
          {state.config.mode === 'active' && <p className="text-sm text-fg-2">Changing comfort settings switches personal comfort Off and requires a new activation review.</p>}
          <form onSubmit={saveRange} className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs text-fg-2">
              Minimum °F
              <input className={`${fieldClass} w-24`} name="minimum" type="number" min="55" max="110" step="1" required defaultValue={state.config.minimumF} />
            </label>
            <label className="grid gap-1 text-xs text-fg-2">
              Maximum °F
              <input className={`${fieldClass} w-24`} name="maximum" type="number" min="55" max="110" step="1" required defaultValue={state.config.maximumF} />
            </label>
            <Button type="submit" disabled={pending || Boolean(data.fault)}>Save range</Button>
          </form>
        </>
      )}
      <form onSubmit={saveFeedback} className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
        <label className="grid gap-1 text-xs text-fg-2">
          Sleep date (
          {data.timezone ?? 'unavailable'}
          )
          <input key={data.deviceDate} className={fieldClass} name="date" type="date" required defaultValue={data.deviceDate ?? ''} max={data.deviceDate ?? undefined} />
        </label>
        <label className="grid gap-1 text-xs text-fg-2">
          How did the bed feel?
          <select className={fieldClass} name="comfort" defaultValue="comfortable">
            <option value="comfortable">Comfortable</option>
            <option value="warm">Too warm</option>
            <option value="cold">Too cold</option>
          </select>
        </label>
        <Button type="submit" disabled={pending || Boolean(data.fault) || !data.deviceDate}>Save check-in</Button>
      </form>
      <p className="text-xs text-fg-2">
        {data.activation.reason}
        {' '}
        Use the separate owner review below to qualify and activate thermal adjustments.
      </p>
      <details className="border-t border-line pt-3 text-sm">
        <summary className="cursor-pointer text-fg-2">Recent observations</summary>
        {data.history.length === 0
          ? <p className="mt-3 text-fg-2">No observations recorded.</p>
          : (
              <ol className="mt-3 space-y-3">
                {data.history.slice(0, 10).map((entry, index) => (
                  <li key={`${entry.at}:${index}`}>
                    <time className="text-xs text-fg-2" dateTime={new Date(entry.at).toISOString()}>{clock(entry.at)}</time>
                    <p>{entry.message}</p>
                    {entry.timing?.selection && (
                      <p className="text-xs text-fg-2">{`Bed-entry Preview: ${entry.timing.state} · ${entry.timing.selection.shiftMinutes} min shift. ${entry.timing.reason}`}</p>
                    )}
                    {entry.kind === 'preview' && (
                      <p className="text-xs text-fg-2">
                        Reported target:
                        {entry.reportedF === null ? 'unavailable' : `${entry.reportedF}°F`}
                        {' '}
                        · Owner:
                        {entry.owner ?? 'unavailable'}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
      </details>
    </div>
  )
}
