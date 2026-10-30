'use client'

import { useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, DayPicker, InlineError, PageHeader, SectionLabel, SegmentedControl, Skeleton, Stepper, Toggle } from '@/src/components/ds'
import { bedtimeDraftSchema, type BedtimeDraft, type RoutineSide, type RoutineSnapshot } from '@/src/lib/bedtimeRoutines'
import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import { formatSetpointF } from '@/src/lib/tempUtils'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import { TimeInput } from './TimeInput'
import { formatDayRange } from './scheduleFormat'
import { ConfirmDialog } from './ConfirmDialog'

const defaultDraft: BedtimeDraft = {
  power: { onTime: '22:00', offTime: '07:00', onTemperature: 75, enabled: false, endAction: 'turn_off' },
  temperatures: [], alarm: null, notes: '',
}
const defaultAlarm: NonNullable<BedtimeDraft['alarm']> = { time: '06:30', vibrationPattern: 'rise', vibrationIntensity: 50, duration: 30, alarmTemperature: 80, wakeWindow: 0, snoozeDuration: 300, snoozeTaper: 0, enabled: false }

/** Imported routines retain explicit power times even when no temperature phases exist. */
export function BedtimeSchedule({ side, name, onBack }: { side: RoutineSide, name: string, onBack?: () => void }) {
  const query = trpc.routines.get.useQuery({ side })
  const { formatTime } = useTimeFormatter()
  const [editing, setEditing] = useState<{ days: DayOfWeek[], draft: BedtimeDraft, originals: RoutineSnapshot[] } | null>(null)
  if (query.isLoading) return <Skeleton className="h-40" />
  if (query.error) return <Card><InlineError>{query.error.message}</InlineError></Card>
  if (!query.data) return null
  const originals = query.data.routines
  if (editing) return <BedtimeRoutineEditor key={`${side}:${editing.days.join(',')}`} side={side} name={name} {...editing} onClose={() => setEditing(null)} />

  const groups = new Map<string, { days: DayOfWeek[], draft: BedtimeDraft }>()
  for (const routine of query.data.routines) {
    const fingerprint = JSON.stringify(routine.draft)
    const group = groups.get(fingerprint)
    if (group) group.days.push(routine.dayOfWeek)
    else groups.set(fingerprint, { days: [routine.dayOfWeek], draft: routine.draft })
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader title={`${name}'s bedtime routines`} back={onBack ? 'Schedule' : undefined} onBack={onBack} right={query.data.canCreate ? <Button icon={Plus} onClick={() => setEditing({ days: [], draft: structuredClone(defaultDraft), originals })}>New routine</Button> : undefined} />
      <p className="text-sm text-fg-2">Choose the nights you go to bed. Morning temperatures and the wake alarm stay with that night.</p>
      {groups.size === 0 && <Card dashed><span className="text-fg-2">{query.data.canCreate ? 'No bedtime routines yet. New routines start paused.' : 'This side uses calendar schedules. Keep using its curve editor until those schedules are migrated.'}</span></Card>}
      {[...groups.values()].map(group => (
        <Card key={group.days.join(',')}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="font-medium">{formatDayRange(group.days)}</span>
              <span className="text-sm text-fg-2">
                {formatTime(group.draft.power.onTime)}
                {' '}
                →
                {' '}
                {formatTime(group.draft.power.offTime)}
                {group.draft.power.offTime < group.draft.power.onTime ? ' next day' : ''}
                {' '}
                ·
                {' '}
                {group.draft.power.enabled ? 'Scheduled' : 'Paused'}
              </span>
              <span className="text-xs text-fg-2">
                {group.draft.temperatures.length}
                {' '}
                temperature phases ·
                {' '}
                {group.draft.alarm?.enabled ? `Wake at ${formatTime(group.draft.alarm.time)}` : 'Wake alarm off'}
              </span>
            </div>
            <Button icon={Pencil} onClick={() => setEditing({ ...group, draft: structuredClone(group.draft), originals })}>
              {`Edit ${formatDayRange(group.days)}`}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  )
}

/** Freeze original revisions with the draft, so refetches cannot silently authorize overwrites. */
export function BedtimeRoutineEditor({ side, name, days: originalDays, draft: initialDraft, originals, onClose }: {
  side: RoutineSide
  name: string
  days: DayOfWeek[]
  draft: BedtimeDraft
  originals: RoutineSnapshot[]
  onClose: () => void
}) {
  const [baseline] = useState(() => structuredClone(originals))
  const [days, setDays] = useState<DayOfWeek[]>([...originalDays])
  const [draft, setDraft] = useState(() => structuredClone(initialDraft))
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<'replace' | 'delete' | null>(null)
  const [savedPendingScheduler, setSavedPendingScheduler] = useState(false)
  const mutation = trpc.routines.replace.useMutation()
  const utils = trpc.useUtils()
  const { unit } = useTemperatureUnit()
  const formatTarget = (value: number) => formatSetpointF(value, unit)
  const patchPower = (update: Partial<BedtimeDraft['power']>) => setDraft(current => ({ ...current, power: { ...current.power, ...update } }))
  const patchAlarm = (update: Partial<NonNullable<BedtimeDraft['alarm']>>) => setDraft(current => ({ ...current, alarm: { ...(current.alarm ?? defaultAlarm), ...update } }))
  const patchPhase = (index: number, update: Partial<BedtimeDraft['temperatures'][number]>) => setDraft(current => ({ ...current, temperatures: current.temperatures.map((point, position) => position === index ? { ...point, ...update } : point) }))
  const nextDay = (time: string) => time < draft.power.onTime ? 'Following morning' : 'Starting night'

  const save = async (remove = false, confirmed = false) => {
    setError(null)
    if (!remove && days.length === 0) {
      setError('Choose at least one night.')
      return
    }
    const parsed = bedtimeDraftSchema.safeParse(draft)
    if (!remove && !parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Review the routine.')
      return
    }
    if (!remove && !confirmed && days.some(day => !originalDays.includes(day) && baseline.some(row => row.dayOfWeek === day))) {
      setConfirmation('replace')
      return
    }
    const affected = [...new Set([...originalDays, ...(remove ? [] : days)])]
    try {
      const result = await mutation.mutateAsync({ side, changes: affected.map(dayOfWeek => ({
        dayOfWeek,
        expectedRevision: baseline.find(row => row.dayOfWeek === dayOfWeek)?.revision ?? null,
        replacement: !remove && days.includes(dayOfWeek) && parsed.success ? parsed.data : null,
      })) })
      await Promise.all([utils.routines.get.invalidate({ side }), utils.schedules.getAll.invalidate(), utils.schedules.getByDay.invalidate()])
      if (!result.schedulerApplied) {
        setSavedPendingScheduler(true)
        setError('Routine saved, but scheduler registration is pending. Check controller diagnostics before relying on it.')
        return
      }
      onClose()
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the routine.') }
    finally { setConfirmation(null) }
  }
  const disabled = mutation.isPending || savedPendingScheduler
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader title={originalDays.length ? `Edit ${name}'s routine` : `New routine for ${name}`} back="Routines" onBack={onClose} right={<Button variant="primary" disabled={disabled} onClick={() => void save()}>{mutation.isPending ? 'Saving…' : 'Save routine'}</Button>} />
      <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
        <Card>
          <SectionLabel>Nights you go to bed</SectionLabel>
          <DayPicker days={DAYS_OF_WEEK.map(day => day.slice(0, 3))} labels={DAYS_OF_WEEK.map(day => `${day} night`)} value={days.map(day => DAYS_OF_WEEK.indexOf(day))} onChange={indices => setDays(indices.map(index => DAYS_OF_WEEK[index]))} />
          <p className="text-xs text-fg-2">A Saturday night routine continues into Sunday morning. Moving a routine moves its power times, phases and wake alarm together.</p>
        </Card>
        <Card>
          <div className="flex items-center justify-between">
            <SectionLabel>Power and temperature</SectionLabel>
            <Toggle label="Routine enabled" on={draft.power.enabled} onChange={enabled => patchPower({ enabled })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TimeInput label="Power on" value={draft.power.onTime} onChange={onTime => patchPower({ onTime })} />
            <TimeInput label="End time" value={draft.power.offTime} onChange={offTime => patchPower({ offTime })} />
          </div>
          <span className="text-xs text-fg-2">
            {`End: ${nextDay(draft.power.offTime)}. ${draft.power.enabled ? 'Runs on the selected nights.' : 'Paused; saving keeps this routine off.'}`}
          </span>
          <span className="text-xs text-fg-2">Starting temperature</span>
          <Stepper label="Starting temperature" value={draft.power.onTemperature} onChange={onTemperature => patchPower({ onTemperature })} format={formatTarget} />
          <SegmentedControl ariaLabel="At end time" value={draft.power.endAction} onChange={endAction => patchPower({ endAction })} options={[{ value: 'turn_off', label: 'Turn off' }, { value: 'maintain', label: 'Keep temperature' }]} />
        </Card>
        <Card>
          <div className="flex items-center justify-between gap-3">
            <SectionLabel>Temperature phases</SectionLabel>
            <Button icon={Plus} disabled={draft.temperatures.length >= 96} onClick={() => setDraft(current => ({ ...current, temperatures: [...current.temperatures, { time: '01:00', temperature: current.power.onTemperature, enabled: false }] }))}>Add phase</Button>
          </div>
          {draft.temperatures.length === 0 && <p className="text-sm text-fg-2">The starting temperature holds for this routine.</p>}
          {draft.temperatures.map((point, index) => (
            <div key={index} className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
              <TimeInput label={`Phase ${index + 1} time`} value={point.time} onChange={time => patchPhase(index, { time })} />
              <Stepper label={`Phase ${index + 1} temperature`} value={point.temperature} onChange={temperature => patchPhase(index, { temperature })} format={formatTarget} />
              <Toggle label={`Phase ${index + 1} enabled`} on={point.enabled} onChange={enabled => patchPhase(index, { enabled })} />
              <Button icon={Trash2} onClick={() => setDraft(current => ({ ...current, temperatures: current.temperatures.filter((_point, position) => position !== index) }))}>
                {`Remove phase ${index + 1}`}
              </Button>
              <span className="text-xs text-fg-2">{nextDay(point.time)}</span>
            </div>
          ))}
        </Card>
        <Card>
          <div className="flex items-center justify-between">
            <SectionLabel>Wake alarm</SectionLabel>
            <Toggle label="Wake alarm enabled" on={draft.alarm?.enabled ?? false} onChange={enabled => patchAlarm({ enabled })} />
          </div>
          {draft.alarm && (
            <>
              <TimeInput label="Wake time" value={draft.alarm.time} onChange={time => patchAlarm({ time })} />
              <p className="text-xs text-fg-2">
                {nextDay(draft.alarm.time)}
                . The alarm follows the routine’s enabled switch. Wake temperature includes warm-up and a post-alarm hold.
              </p>
              <SegmentedControl ariaLabel="Vibration pattern" value={draft.alarm.vibrationPattern} onChange={vibrationPattern => patchAlarm({ vibrationPattern })} options={[{ value: 'rise', label: 'Rise' }, { value: 'double', label: 'Double' }]} />
              <div className="flex flex-col gap-2">
                <span className="text-xs text-fg-2">Snooze for</span>
                <Stepper label="Snooze duration" value={(draft.alarm.snoozeDuration ?? 300) / 60} min={1} max={30} format={value => `${value} min`} onChange={minutes => patchAlarm({ snoozeDuration: minutes * 60 })} />
                <label className="flex flex-col gap-2 text-sm">
                  Snooze taper
                  <select className="rounded-ctl border border-line-2 bg-field p-2" value={draft.alarm.snoozeTaper ?? 0} onChange={event => patchAlarm({ snoozeTaper: Number(event.target.value) as NonNullable<BedtimeDraft['alarm']>['snoozeTaper'] })}>{[0, 30, 40, 50, 60].map(value => <option key={value} value={value}>{value === 0 ? 'Off' : `${value}% shorter each time`}</option>)}</select>
                </label>
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-fg-2">Vibration intensity</span>
                  <Stepper label="Vibration intensity" value={draft.alarm.vibrationIntensity} min={1} max={100} format={value => `${value}%`} onChange={vibrationIntensity => patchAlarm({ vibrationIntensity })} />
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-fg-2">Vibration duration</span>
                  <Stepper label="Vibration duration" value={draft.alarm.duration} min={10} max={180} step={5} format={value => `${value}s`} onChange={duration => patchAlarm({ duration })} />
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-fg-2">Wake temperature</span>
                  <Stepper label="Wake temperature" value={draft.alarm.alarmTemperature} format={formatTarget} onChange={alarmTemperature => patchAlarm({ alarmTemperature })} />
                </div>
              </div>
              <label className="flex flex-col gap-2 text-sm">
                Wake window
                <select className="rounded-ctl border border-line-2 bg-field p-2" value={draft.alarm.wakeWindow} onChange={event => patchAlarm({ wakeWindow: Number(event.target.value) as NonNullable<BedtimeDraft['alarm']>['wakeWindow'] })}>{[0, 10, 15, 20, 30].map(value => <option key={value} value={value}>{value === 0 ? 'Exact time' : `${value} minutes`}</option>)}</select>
              </label>
            </>
          )}
        </Card>
        <Card>
          <label className="flex flex-col gap-2 text-sm">
            Notes
            <textarea className="rounded-ctl border border-line-2 bg-field p-3" maxLength={1000} value={draft.notes} onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))} />
          </label>
        </Card>
        {originalDays.length > 0 && <Button icon={Trash2} onClick={() => setConfirmation('delete')}>Delete routine</Button>}
      </fieldset>
      {error && <InlineError>{error}</InlineError>}
      <ConfirmDialog open={confirmation !== null} busy={mutation.isPending} onCancel={() => setConfirmation(null)} onConfirm={() => void save(confirmation === 'delete', true)} title={confirmation === 'delete' ? 'Delete routine?' : 'Replace routines on the selected nights?'} message={confirmation === 'delete' ? 'Removes the power times, temperature phases and wake alarm for these nights.' : 'Existing routines on the newly selected nights will be replaced together. Newer changes from another app will still be protected.'} confirmLabel={confirmation === 'delete' ? 'Delete routine' : 'Replace and save'} />
    </div>
  )
}
