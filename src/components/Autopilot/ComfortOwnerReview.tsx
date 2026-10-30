'use client'

import { useEffect, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Button } from '@/src/components/ds'
import type { Side } from '@/src/hardware/types'
import { qualificationInstructions, qualificationKindSchema, qualificationLabels, type OwnerReview, type QualificationKind } from '@/src/comfort/owner-contract'

/** Review data comes only from the server; this form submits a reference and an owner observation. */
export function ComfortOwnerReview({ side }: { side: Side }) {
  const utils = trpc.useUtils()
  const query = trpc.comfort.owner.useQuery({ side }, { refetchOnWindowFocus: false })
  const [kind, setKind] = useState<QualificationKind>('presence_empty')
  const [review, setReview] = useState<OwnerReview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')
  const [clock, setClock] = useState(Date.now)
  useEffect(() => {
    if (!review) return
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [review])
  const refresh = () => {
    setReview(null)
    setConfirmed(false)
    setNote('')
    void utils.comfort.owner.invalidate()
    void utils.comfort.get.invalidate()
  }
  const prepare = trpc.comfort.prepareOwnerReview.useMutation({ onSuccess: (value) => {
    setClock(Date.now())
    setConfirmed(false)
    setNote('')
    setReview(value)
  } })
  const confirm = trpc.comfort.confirmOwnerReview.useMutation({ onSuccess: refresh })
  const retest = trpc.comfort.retestQualification.useMutation({ onSuccess: refresh })
  const pending = prepare.isPending || confirm.isPending || retest.isPending
  const expired = review !== null && (clock >= review.expiresAt || clock < review.at)
  const data = query.data
  const evidence = review?.snapshot.evidence
  const time = (at: number) => new Date(at).toLocaleString()
  const error = query.error ?? prepare.error ?? confirm.error ?? retest.error
  const begin = (purpose: OwnerReview['purpose']) => {
    setReview(null)
    confirm.reset()
    retest.reset()
    prepare.mutate({ side, purpose, kind: purpose === 'qualification' ? kind : null })
  }
  return (
    <section className="mt-6 space-y-4 border-t border-line pt-5" aria-label="Owner activation review">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Qualification & activation</h3>
        <Button variant="ghost" disabled={pending || query.isFetching} onClick={() => { void query.refetch() }}>Refresh evidence</Button>
      </div>
      <p className="text-sm text-fg-2">Recorded signals and command acknowledgments are separate from your physical observations. These thermal checks do not enable automatic base movement, music vibration or house automations.</p>
      {query.isLoading && <p role="status" className="text-sm">Reading qualification evidence…</p>}
      {error && <p role="alert" className="text-sm text-danger">{error.message}</p>}
      {data && (
        <>
          <p className="text-sm font-medium">
            {data.active ? 'Owner activation current' : 'Activation requires review'}
            {' '}
            ·
            {' '}
            {data.nights.length}
            /7 matching nights
          </p>
          {data.reasons.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-fg-2">{data.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
          <div className="space-y-2">
            {qualificationKindSchema.options.map((value) => {
              const record = data.qualifications.find(item => item.kind === value)
              const current = record && JSON.stringify(record.evidence.identity) === JSON.stringify(data.identity)
              return (
                <div key={value} className="flex flex-wrap items-center justify-between gap-2 rounded-ctl border border-line p-3 text-sm">
                  <div>
                    <p>{qualificationLabels[value]}</p>
                    <p className="mt-1 text-xs text-fg-2">{record ? `${!data.identity ? 'Waiting for fresh controller identity' : current ? record.outcome === 'confirmed' ? 'Owner confirmed' : 'Needs retest' : 'Earlier configuration; repeat'} · ${time(record.at)}` : 'Not yet qualified'}</p>
                  </div>
                  {record?.outcome === 'confirmed' && <Button variant="ghost" disabled={pending} onClick={() => retest.mutate({ side, kind: value, expectedId: record.id })}>Needs retest</Button>}
                </div>
              )
            })}
          </div>
          <label className="block text-sm">
            Attended check
            <select
              className="mt-2 block w-full rounded-ctl border border-line bg-surface p-3 text-fg"
              value={kind}
              disabled={pending || data.active}
              onChange={(event) => {
                setKind(event.target.value as QualificationKind)
                setReview(null)
              }}
            >
              {qualificationKindSchema.options.map(value => <option key={value} value={value}>{qualificationLabels[value]}</option>)}
            </select>
          </label>
          <p className="text-sm text-fg-2">{qualificationInstructions[kind]}</p>
          <div className="flex flex-wrap gap-3">
            <Button disabled={pending || data.active || !data.identity || Boolean(query.error)} onClick={() => begin('qualification')}>Inspect check evidence</Button>
            <Button variant="primary" disabled={pending || !data.canActivate || Boolean(query.error)} onClick={() => begin('activation')}>Review activation</Button>
          </div>
          {data.application && data.application.outcome !== 'acknowledged' && (
            <div className="rounded-ctl border border-line p-4 text-sm">
              <p className="font-medium">Unconfirmed temperature command</p>
              <p className="mt-2 text-fg-2">
                Requested
                {data.application.targetF}
                °F at
                {time(data.application.reservedAt)}
                . Its outcome is unknown; it will not be retried automatically.
              </p>
              <Button className="mt-3" disabled={pending} onClick={() => begin('resolution')}>Inspect recovery evidence</Button>
            </div>
          )}
        </>
      )}
      {review && (
        <div className="space-y-3 rounded-ctl border border-line bg-active p-4 text-sm" aria-label="Prepared owner review">
          <p className="font-medium">{review.purpose === 'activation' ? 'Activate bounded thermal comfort' : review.purpose === 'resolution' ? 'Archive uncertainty and return to Preview' : qualificationLabels[review.kind ?? kind]}</p>
          <p className="text-xs text-fg-2">
            Build
            {review.snapshot.identity.build.slice(0, 12)}
            {' '}
            · Pod
            {review.snapshot.identity.hardware.slice(0, 12)}
            {' '}
            · captured
            {time(review.at)}
          </p>
          {evidence && (
            <dl className="grid grid-cols-2 gap-2">
              <dt>Firmware report</dt>
              <dd>
                {evidence.powered ? 'On' : evidence.offConfirmed ? 'Off' : 'Power state unavailable'}
                {' '}
                ·
                {' '}
                {evidence.targetF === null ? 'No target' : `${evidence.targetF}°F`}
                {' '}
                ·
                {' '}
                {time(evidence.observedAt)}
              </dd>
              <dt>Calibrated presence</dt>
              <dd>
                {evidence.presence}
                {evidence.presenceAt ? ` · ${time(evidence.presenceAt)}` : ''}
              </dd>
              <dt>Temperature acknowledgment</dt>
              <dd>{evidence.applicationAt ? time(evidence.applicationAt) : 'Not part of this check'}</dd>
              <dt>Wake acknowledgment</dt>
              <dd>{evidence.alarmAt ? time(evidence.alarmAt) : 'Not part of this check'}</dd>
            </dl>
          )}
          {review.purpose === 'activation' && (
            <>
              <p>
                {review.snapshot.identity.policy.minimumF}
                –
                {review.snapshot.identity.policy.maximumF}
                °F · at most 1°F per 30 minutes · six-hour manual pause. The controller never powers your side on. Missing or unsafe inputs withdraw adjustments.
              </p>
              <ul className="list-disc pl-5">
                {review.snapshot.nights.map(night => (
                  <li key={night.summary.id}>
                    {night.summary.localDate}
                    :
                    {' '}
                    {(night.eligibleMs / 3_600_000).toFixed(1)}
                    {' '}
                    hours of eligible observations, owner review #
                    {night.reviewId}
                  </li>
                ))}
              </ul>
              <p className="text-fg-2">This evidence qualifies bounded operation; it does not demonstrate improved sleep or clinical accuracy. A build, routine, calibration, policy or qualification change requires a new review.</p>
            </>
          )}
          {review.purpose === 'resolution' && <p>The original uncertain command and this review stay in the audit record. This does not mark the command successful or replay it. Preview resumes with a six-hour pause.</p>}
          <label className="block">
            Observation or note (optional)
            <textarea className="mt-2 block w-full rounded-ctl border border-line bg-surface p-3" maxLength={2000} value={note} disabled={pending} onChange={event => setNote(event.target.value)} />
          </label>
          <label className="flex items-start gap-3">
            <input type="checkbox" checked={confirmed} disabled={pending || expired} onChange={event => setConfirmed(event.target.checked)} />
            <span>{review.purpose === 'qualification' ? 'I attended this check and confirm the physical observations described above.' : review.purpose === 'activation' ? 'I reviewed these observations and authorize bounded thermal adjustments for this side.' : 'I reviewed the uncertain outcome and want to return to Preview without retrying it.'}</span>
          </label>
          <p role="status" className="text-xs text-fg-2">{expired ? 'Review expired. Inspect fresh evidence before confirming.' : `Review expires in ${Math.max(0, Math.ceil((review.expiresAt - clock) / 1000))} seconds.`}</p>
          <div className="flex gap-3">
            <Button variant="primary" disabled={pending || !confirmed || expired} onClick={() => confirm.mutate({ side, id: review.id, confirmed: true, note })}>{review.purpose === 'activation' ? 'Activate thermal comfort' : review.purpose === 'resolution' ? 'Return to Preview' : 'Confirm attended check'}</Button>
            <Button variant="ghost" disabled={pending} onClick={() => setReview(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {confirm.isSuccess && <p role="status" className="text-sm text-fg-2">Owner review saved. No physical effect is inferred from this confirmation.</p>}
    </section>
  )
}
