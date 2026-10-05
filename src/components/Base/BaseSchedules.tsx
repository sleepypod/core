'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { BASE_DAYS, BASE_PRESETS } from '@/src/hardware/base/types'
import type { BaseScope } from '@/src/hardware/base/types'
import { trpc } from '@/src/utils/trpc'
import { buttonStyle, panelStyle } from './controls'
import type { Names } from './controls'

const fieldStyle = 'min-w-0 rounded-lg border border-line-2 bg-app px-2 py-2 text-sm text-fg'
const title = (value: string) => value[0].toUpperCase() + value.slice(1)
export function BaseSchedules({ names, independent, speed, compact = false }: { names: Names, independent: boolean, speed: number, compact?: boolean }) {
  const query = trpc.base.getSchedules.useQuery({})
  const settings = trpc.settings.getAll.useQuery({})
  const [days, setDays] = useState<typeof BASE_DAYS[number]>('daily')
  const [time, setTime] = useState('22:00')
  const [side, setSide] = useState<BaseScope>('both')
  const [preset, setPreset] = useState<keyof typeof BASE_PRESETS>('sleep')
  const [error, setError] = useState('')
  const onSuccess = () => {
    setError('')
    void query.refetch()
  }
  const onError = (e: { message: string }) => setError(e.message)
  const save = trpc.base.saveSchedule.useMutation({ onSuccess, onError })
  const remove = trpc.base.deleteSchedule.useMutation({ onSuccess, onError })
  const pending = save.isPending || remove.isPending
  const scopeName = (scope: BaseScope) => scope === 'both' ? 'Both sides' : names[scope]
  const dayField = <select aria-label="Days" value={days} onChange={e => setDays(e.target.value as typeof days)} className={fieldStyle}>{BASE_DAYS.map(day => <option key={day} value={day}>{title(day)}</option>)}</select>
  const timeField = <input aria-label="Time" type="time" required value={time} onChange={e => setTime(e.target.value)} className={`${fieldStyle} font-mono [color-scheme:dark]`} />
  const sideField = <select aria-label="Schedule side" value={independent ? side : 'both'} onChange={e => setSide(e.target.value as BaseScope)} className={fieldStyle}>{(independent ? ['both', 'left', 'right'] as const : ['both'] as const).map(value => <option key={value} value={value}>{scopeName(value)}</option>)}</select>
  const presetField = (
    <select aria-label="Schedule preset" value={preset} onChange={e => setPreset(e.target.value as typeof preset)} className={fieldStyle}>
      {Object.entries(BASE_PRESETS).map(([name, position]) => (
        <option key={name} value={name}>
          {title(name)}
          {' '}
          ·
          {' '}
          {position.head}
          °/
          {position.feet}
          °
        </option>
      ))}
    </select>
  )
  return (
    <section aria-label="Schedule" className={panelStyle}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-medium">Schedule</h2>
        <span className="font-mono text-xs text-fg-3">{settings.data?.device?.timezone ?? 'Loading timezone…'}</span>
      </div>
      <p className="text-xs leading-relaxed text-fg-2">A move pauses while its side is in away mode; both sides pause if either is away. Missed adjustments are skipped.</p>
      {query.isLoading && <p role="status">Loading schedules…</p>}
      {(error || query.error) && <p role="alert" className="text-sm text-danger">{error || query.error?.message}</p>}
      {query.data?.length === 0 && <p className="text-sm text-fg-3">No scheduled positions yet.</p>}
      <ul className="flex flex-col">
        {[...(query.data ?? [])].sort((a, b) => a.time.localeCompare(b.time)).map(row => (
          <li key={row.id} className={`flex items-center gap-3 border-t border-line py-3 ${row.enabled ? '' : 'opacity-45'}`}>
            <span className="font-mono text-sm">{row.time}</span>
            <div className={`flex min-w-0 flex-1 gap-x-4 gap-y-1 ${compact ? 'flex-col' : 'flex-wrap items-baseline'}`}>
              <span className="text-sm">
                {row.presetName === 'Custom' ? Object.entries(BASE_PRESETS).find(([, value]) => value.head === row.head && value.feet === row.feet)?.[0] ?? 'Custom' : row.presetName}
                {' '}
                <span className="ml-1 font-mono text-xs text-fg-2">
                  {row.head}
                  ° /
                  {' '}
                  {row.feet}
                  °
                </span>
              </span>
              <span className={`text-xs text-fg-2 ${compact ? '' : 'order-first'}`}>
                {title(row.dayOfWeek)}
                {' '}
                ·
                {' '}
                {scopeName(row.side)}
                {!row.enabled && ' · Paused'}
              </span>
            </div>
            <button type="button" aria-label={`Delete ${title(row.dayOfWeek)} ${row.time} ${scopeName(row.side)}`} disabled={pending} onClick={() => remove.mutate({ id: row.id })} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 hover:bg-active hover:text-danger disabled:opacity-45"><Trash2 size={15} /></button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({ ...BASE_PRESETS[preset], feedRate: speed, dayOfWeek: days, time, side: independent ? side : 'both', presetName: title(preset), enabled: true })
        }}
        className={`rounded-[10px] border border-dashed border-line-2 p-3 ${compact ? 'flex flex-col gap-2' : 'flex flex-wrap items-center gap-2.5 text-sm text-fg-2'}`}
      >
        {compact
          ? (
              <>
                <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2">
                  {dayField}
                  {timeField}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {sideField}
                  {presetField}
                </div>
              </>
            )
          : (
              <>
                <span>Every</span>
                {dayField}
                <span>at</span>
                {timeField}
                <span>move</span>
                {sideField}
                <span>to</span>
                {presetField}
              </>
            )}
        <button type="submit" disabled={pending || !time || query.isLoading || query.isError} className={`${buttonStyle} flex items-center justify-center gap-1.5 ${compact ? 'w-full' : 'ml-auto'}`}>
          <Plus size={14} />
          {compact ? 'Add to schedule' : 'Add'}
        </button>
      </form>
    </section>
  )
}
