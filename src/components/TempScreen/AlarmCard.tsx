'use client'

import { Bell, Plus } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, InlineError, Skeleton } from '@/src/components/ds'
import { AlarmEditor } from '@/src/components/Schedule/AlarmEditor'
import { groupAlarms } from '@/src/components/Schedule/AlarmSection'
import type { Side } from '@/src/providers/SideProvider'
import type { NextAlarm, NextAlarmWrite } from '@/src/alarms/contract'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import { trpc } from '@/src/utils/trpc'

/** Temp edits one wake occurrence. The separate weekly editor keeps its original job. */
export function AlarmCard({ side }: { side: Side }) {
  return <NextAlarmCard key={side} side={side} />
}
function NextAlarmCard({ side }: { side: Side }) {
  const { formatTime } = useTimeFormatter()
  const utils = trpc.useUtils()
  const query = trpc.nextAlarm.get.useQuery({ side }, { refetchInterval: 30_000 })
  const schedules = trpc.schedules.getAll.useQuery({ side })
  const change = trpc.nextAlarm.change.useMutation({ retry: false })
  const [draft, setDraft] = useState<{ base: NextAlarm, time: string } | null>(null)
  const [message, setMessage] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const current = query.data
  if (query.isLoading) return <Skeleton className="h-[100px]" />
  const alarm = current?.alarm
  const group = groupAlarms(schedules.data?.alarm ?? []).find(item => item.ids.some(id => alarm?.scheduleIds.includes(id))) ?? null
  const changedDraft = draft && current?.revision !== draft.base.revision
  const pending = change.isPending || uncertain
  const localDate = (at: string) => new Intl.DateTimeFormat(undefined, { timeZone: current?.timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(at))
  const refresh = async () => {
    await query.refetch()
    setUncertain(false)
    setMessage('Latest alarm loaded. Review it before making another change.')
  }
  const save = async (input: NextAlarmWrite) => {
    setMessage('')
    try {
      const result = await change.mutateAsync(input)
      utils.nextAlarm.get.setData({ side }, result)
      setDraft(null)
      setMessage(result.schedulerUpdated ? 'One-time change saved on your Pod.' : 'Change saved; timer registration is pending and has not yet been confirmed.')
    }
    catch {
      setUncertain(true)
      setMessage('Change not confirmed. Refresh the saved alarm before trying again; your time draft is still here.')
    }
  }

  return (
    <Card className="gap-3 py-3.5">
      <section aria-label="Next alarm" className="flex flex-col gap-3">
        <div className="flex items-start gap-2.5">
          <Bell size={16} className="mt-1 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-fg-2">
              Next alarm ·
              {side}
            </p>
            {alarm && current
              ? (
                  <>
                    <p className="font-mono text-base">
                      {formatTime(alarm.time)}
                    </p>
                    {current.state === 'skipped' && <p className="text-xs text-fg-2">skipped once</p>}
                    <p className="text-xs text-fg-2">
                      {localDate(alarm.at)}
                      {' '}
                      ·
                      {' '}
                      {alarm.duration}
                      s vibration ·
                      {' '}
                      {current.timeZone}
                    </p>
                  </>
                )
              : <p className="text-sm text-fg-2">{query.error ? 'Alarm unavailable' : 'No alarm set'}</p>}
          </div>
          {!alarm && <Button icon={Plus} size="sm" disabled={!schedules.data || pending} onClick={() => setEditorOpen(true)}>Add alarm</Button>}
        </div>
        {query.error && <InlineError>{query.error.message}</InlineError>}
        {current?.reason && <p className="text-xs text-fg-2">{current.reason}</p>}
        {current?.execution && <p className="text-xs text-fg-2">{`Command ${current.execution}; physical vibration has not been verified.`}</p>}
        {current?.change && (
          <p className="text-xs text-fg-2">
            {current.change.status === 'active'
              ? `One-time change expires ${localDate(current.change.expiresAt)} at ${formatTime(new Intl.DateTimeFormat('en-GB', { timeZone: current.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(current.change.expiresAt)))}.`
              : `The temporary change is ${current.change.status}. Current weekly routines apply.`}
          </p>
        )}
        {current?.followingAt && current.state === 'skipped' && (
          <p className="text-xs text-fg-2">{`Following routine alarm: ${localDate(current.followingAt)} at ${formatTime(new Intl.DateTimeFormat('en-GB', { timeZone: current.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(current.followingAt)))}.`}</p>
        )}
        {alarm && current && (
          <div className="flex flex-wrap gap-2">
            {current.state !== 'skipped' && <Button size="sm" disabled={pending || !current.canChange} onClick={() => void save({ side, action: 'skip', expectedRevision: current.revision, expectedAt: alarm.at })}>Skip this alarm</Button>}
            <Button
              size="sm"
              disabled={pending || !current.canChange}
              onClick={() => {
                setDraft({ base: current, time: alarm.time })
                setMessage('')
              }}
            >
              Change this time
            </Button>
            {current.change && <Button size="sm" disabled={pending} onClick={() => void save({ side, action: 'restore', expectedRevision: current.revision, expectedExpiresAt: current.change?.expiresAt })}>Restore routine alarm</Button>}
            <Button size="sm" disabled={!schedules.data || pending} onClick={() => setEditorOpen(true)}>Weekly schedule</Button>
          </div>
        )}
        {!alarm && current?.change && <Button size="sm" disabled={pending} onClick={() => void save({ side, action: 'restore', expectedRevision: current.revision, expectedExpiresAt: current.change?.expiresAt })}>Clear expired change</Button>}
        {draft && (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              This alarm only
              <input
                aria-label="One-time wake time"
                type="time"
                value={draft.time}
                disabled={change.isPending}
                onChange={event => setDraft({ ...draft, time: event.target.value })}
                className="rounded-md border border-border bg-surface px-2 py-1"
              />
            </label>
            <p className="text-xs text-fg-2">Same wake date. Warm-up and the movement wake window follow this time. Weekly routines stay saved.</p>
            {changedDraft && <InlineError>The saved alarm changed. Your draft is retained; cancel and review the new alarm before editing it.</InlineError>}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending || !!changedDraft || !draft.time}
                onClick={() => void save({ side, action: 'time', time: draft.time,
                  expectedRevision: draft.base.revision, expectedAt: draft.base.alarm?.at })}
              >
                Save one-time alarm
              </Button>
              <Button size="sm" disabled={change.isPending} onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </div>
        )}
        {message && <p role="status" className="text-xs text-fg-2">{message}</p>}
        <button type="button" disabled={change.isPending} className="self-start text-xs text-fg-2 underline" onClick={() => void refresh()}>Refresh saved alarm</button>
      </section>
      <AlarmEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        side={side}
        existingGroup={group}
        onSaved={() => {
          void utils.schedules.getAll.invalidate()
          void utils.nextAlarm.get.invalidate()
        }}
      />
    </Card>
  )
}
