'use client'

import { useState } from 'react'
import { Button, Card } from '@/src/components/ds'
import type { BasePosition } from '@/src/hardware/base/types'
import { trpc } from '@/src/utils/trpc'

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
const fieldStyle = 'rounded-ctl border border-line-2 bg-field p-2 text-sm text-fg'
export function BaseSchedules({ target, onSelectTarget }: { target: BasePosition, onSelectTarget: (position: BasePosition) => void }) {
  const query = trpc.base.getSchedules.useQuery({})
  const settings = trpc.settings.getAll.useQuery({})
  const [day, setDay] = useState<typeof DAYS[number]>('monday')
  const [time, setTime] = useState('22:00')
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const onSuccess = () => {
    setError('')
    setEditingId(null)
    void query.refetch()
  }
  const onError = (e: { message: string }) => setError(e.message)
  const save = trpc.base.saveSchedule.useMutation({ onSuccess, onError })
  const remove = trpc.base.deleteSchedule.useMutation({ onSuccess, onError })
  const pending = save.isPending || remove.isPending
  return (
    <Card>
      <h2 className="font-medium">Scheduled positions</h2>
      <p className="text-sm text-fg-2">Move the whole bed at a set time. Paused while either side is in away mode. Missed adjustments are skipped.</p>
      <p className="text-xs text-fg-2">
        Device timezone:
        {settings.data?.device?.timezone ?? 'Loading…'}
      </p>
      {query.isLoading && <p role="status">Loading schedules…</p>}
      {(error || query.error) && <p role="alert" className="text-sm text-danger">{error || query.error?.message}</p>}
      {query.data?.length === 0 && <p className="py-3 text-sm text-fg-2">No scheduled positions yet.</p>}
      <ul className="flex flex-col gap-3">
        {[...(query.data ?? [])].sort((a, b) => DAYS.indexOf(a.dayOfWeek) - DAYS.indexOf(b.dayOfWeek) || a.time.localeCompare(b.time)).map(row => (
          <li key={row.id} className="flex flex-wrap items-center gap-3 border-t border-line pt-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="capitalize">
                {row.dayOfWeek}
                {' '}
                <span className="font-mono">{row.time}</span>
              </p>
              <p className="text-xs text-fg-2">
                {row.head}
                ° head ·
                {' '}
                {row.feet}
                ° feet ·
                {' '}
                {row.feedRate}
                % speed
              </p>
            </div>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                setEditingId(row.id)
                setDay(row.dayOfWeek)
                setTime(row.time)
                onSelectTarget({ head: row.head, feet: row.feet, feedRate: row.feedRate })
              }}
            >
              Edit
            </Button>
            <Button size="sm" disabled={pending} onClick={() => save.mutate({ ...row, enabled: !row.enabled })}>{row.enabled ? 'Pause' : 'Enable'}</Button>
            <Button size="sm" disabled={pending} onClick={() => remove.mutate({ id: row.id })}>Delete</Button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex flex-col gap-3 border-t border-line pt-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({ ...target, id: editingId ?? undefined, dayOfWeek: day, time, enabled: editingId === null ? true : query.data?.find(row => row.id === editingId)?.enabled ?? true })
        }}
      >
        <p className="text-sm">
          Schedule selected target:
          <span className="font-mono">
            {target.head}
            ° /
            {' '}
            {target.feet}
            ° ·
            {' '}
            {target.feedRate}
            %
          </span>
        </p>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs text-fg-2">
            Day
            <select value={day} onChange={e => setDay(e.target.value as typeof day)} className={fieldStyle}>{DAYS.map(d => <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>)}</select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-fg-2">
            Time
            <input type="time" required value={time} onChange={e => setTime(e.target.value)} className={fieldStyle} />
          </label>
        </div>
        <Button type="submit" disabled={pending || !time || query.isLoading || query.isError}>{editingId === null ? 'Add scheduled position' : 'Save scheduled position'}</Button>
        {editingId !== null && <Button onClick={() => setEditingId(null)}>Cancel edit</Button>}
      </form>
    </Card>
  )
}
