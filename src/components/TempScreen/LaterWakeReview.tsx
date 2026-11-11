'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { LaterAlarmPreview, NextAlarm } from '@/src/alarms/contract'
import { Button, InlineError } from '@/src/components/ds'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import { trpc } from '@/src/utils/trpc'

interface Props {
  base: NextAlarm
  current: NextAlarm | undefined
  now: number
  unavailable: boolean
  confirmedRefresh: number
  onSaved(result: NextAlarm & { schedulerUpdated: boolean }): void
  onUncertain(): void
  onClose(): void
}

/** A one-occurrence review; only the server can accept the unexpired displayed plan. */
export function LaterWakeReview({ base, current, now, unavailable, confirmedRefresh, onSaved, onUncertain, onClose }: Props) {
  const { formatTime } = useTimeFormatter()
  const [time, setTime] = useState(base.alarm?.time ?? '')
  const [preview, setPreview] = useState<LaterAlarmPreview | null>(null)
  const [error, setError] = useState<{ message: string, field: boolean, source: 'preview' | 'save', refresh: number } | null>(null)
  const errorId = useId()
  const guidanceId = useId()
  const previewRequest = trpc.nextAlarm.previewLater.useMutation({ retry: false })
  const applyRequest = trpc.nextAlarm.applyLater.useMutation({ retry: false })
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const busy = previewRequest.isPending || applyRequest.isPending
  const changed = !unavailable && !!current && (current.revision !== base.revision || current.alarm?.at !== base.alarm?.at)
  // Only an explicit, successful read after uncertainty reconciles a lost save response.
  const activeError = error?.source === 'save' && confirmedRefresh > error.refresh ? null : error
  const operationalError = activeError?.message ?? (unavailable
    ? 'The saved alarm is unavailable. Use Refresh saved alarm below before continuing.'
    : changed ? 'The saved alarm changed. Close this review and check the latest wake plan.' : '')
  const expired = !!preview && (now >= Date.parse(preview.expiresAt) || now < Date.parse(preview.generatedAt))
  const blocked = unavailable || changed || !current?.canChange
  const clock = (at: string) => formatTime(new Intl.DateTimeFormat('en-GB', {
    timeZone: base.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(at)))
  const date = (at: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: base.timeZone, weekday: 'long', month: 'short', day: 'numeric',
  }).format(new Date(at))
  const review = async () => {
    if (blocked || !base.alarm || busy) return
    setError(null)
    setPreview(null)
    try {
      const result = await previewRequest.mutateAsync({ side: base.side, time, expectedAt: base.alarm.at, expectedRevision: base.revision })
      if (active.current) setPreview(result)
    }
    catch (failure) {
      if (active.current) {
        const field = failure instanceof Error && 'data' in failure && !!failure.data && typeof failure.data === 'object'
          && 'code' in failure.data && failure.data.code === 'BAD_REQUEST'
        setError({ message: failure instanceof Error ? failure.message : 'Could not load the preview. Refresh the saved alarm and try again.', field, source: 'preview', refresh: confirmedRefresh })
      }
    }
  }
  const apply = async () => {
    if (!preview || busy || blocked || expired) return
    setError(null)
    try {
      const result = await applyRequest.mutateAsync({ preview })
      if (active.current) onSaved(result)
    }
    catch {
      if (!active.current) return
      setPreview(null)
      setError({ message: 'The change is not confirmed. Refresh the saved alarm before trying again. It may already have been saved.', field: false, source: 'save', refresh: confirmedRefresh })
      onUncertain()
    }
  }
  return (
    <section aria-label="Later wake review" className="flex flex-col gap-3 border-t border-border pt-4">
      <div>
        <h3 className="text-base font-medium">Wake later once</h3>
        {base.alarm && <p className="mt-1 text-sm text-fg-2">{`${date(base.alarm.at)} · ${base.timeZone}`}</p>}
      </div>
      <label className="flex flex-wrap items-center justify-between gap-3 text-sm">
        Later wake time
        <input
          aria-label="Later wake time"
          aria-invalid={activeError?.field || undefined}
          aria-describedby={activeError?.field ? `${guidanceId} ${errorId}` : guidanceId}
          type="time"
          value={time}
          disabled={busy}
          onChange={(event) => {
            setTime(event.target.value)
            setPreview(null)
            setError(null)
          }}
          className="min-h-11 rounded-md border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg"
        />
      </label>
      <p id={guidanceId} className="text-sm text-fg-2">Review warming and vibration before saving. Your weekly schedule stays the same.</p>
      <div id={errorId} role="alert" aria-atomic="true">{operationalError && <InlineError>{operationalError}</InlineError>}</div>
      {preview && (
        <div aria-label="Proposed wake plan" className="space-y-3">
          <p className="text-base font-medium">{`${clock(preview.before.alarm?.at ?? preview.proposed.at)} → ${clock(preview.proposed.at)}`}</p>
          <dl className="space-y-3 text-sm">
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt>Start warming</dt>
              <dd>{`${clock(preview.proposed.warmingStartsAt)} toward ${preview.proposed.targetF}°F`}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt>Vibration</dt>
              <dd>{`${clock(preview.proposed.at)} for ${preview.proposed.duration} seconds`}</dd>
            </div>
            {preview.proposed.wakeWindow > 0 && (
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                <dt>Movement wake window</dt>
                <dd>{`From ${clock(preview.proposed.earliestVibrationAt)}`}</dd>
              </div>
            )}
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt>Warm hold ends</dt>
              <dd>{clock(preview.proposed.warmingEndsAt)}</dd>
            </div>
          </dl>
          <p className="text-sm text-fg-2">{`This one-time change expires ${date(preview.proposed.changeExpiresAt)} at ${clock(preview.proposed.changeExpiresAt)}. Then the weekly schedule applies.`}</p>
          <p className="text-sm text-fg-2">Only this Pod side is included. Phone alarms, lights, shades and audio are unchanged; review them separately.</p>
          {expired
            ? <p role="status" className="text-sm text-fg">Preview expired. Review the current plan again before saving.</p>
            : <p className="text-xs text-fg-2">This preview is valid for up to 90 seconds. Saving confirms the schedule, not physical warming or vibration.</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {preview && !expired
          ? <Button size="sm" disabled={busy || blocked} onClick={() => void apply()}>{applyRequest.isPending ? 'Saving…' : 'Save this later wake'}</Button>
          : <Button size="sm" disabled={busy || blocked || !time} onClick={() => void review()}>{previewRequest.isPending ? 'Loading preview…' : expired ? 'Refresh preview' : 'Preview later wake'}</Button>}
        <Button size="sm" disabled={busy} onClick={onClose}>Close review</Button>
      </div>
    </section>
  )
}
