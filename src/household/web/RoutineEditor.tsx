import { useState } from 'react'
import { bedtimeDraftSchema, routineEventDay, type BedtimeDraft } from '@/src/lib/bedtimeRoutines'
import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import type { PersonalRoutineReview } from '../routineContract'
import type { PersonalWebWorkspace } from './workspace'
import { weekCopy, type PersonalWeek, type PersonalWebState } from './workspace'
const title = (value: string) => value[0].toUpperCase() + value.slice(1)
function NumberField({ label, value, onChange, min = 55, max = 110 }: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
}) {
  return (
    <label>
      {label}
      <input type="number" min={min} max={max} step="1" required value={Number.isNaN(value) ? '' : value} onChange={event => onChange(event.target.valueAsNumber)} />
    </label>
  )
}
function Check({ label, value, onChange }: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={value} onChange={event => onChange(event.target.checked)} />
      {label}
    </label>
  )
}
function TimeField({ label, value, onChange }: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label>
      {label}
      <input type="time" required value={value} onChange={event => onChange(event.target.value)} />
    </label>
  )
}
/** Every saved phase and alarm field remains editable, including custom snooze seconds. */
function NightFields({ draft, day, change }: {
  draft: BedtimeDraft
  day: DayOfWeek
  change: (value: BedtimeDraft) => void
}) {
  const power = (patch: Partial<BedtimeDraft['power']>) => change({ ...draft, power: { ...draft.power, ...patch } })
  const alarm = (patch: Partial<NonNullable<BedtimeDraft['alarm']>>) => {
    if (draft.alarm)
      change({ ...draft, alarm: { ...draft.alarm, ...patch } })
  }
  return (
    <>
      <Check label="Enable this night" value={draft.power.enabled} onChange={enabled => power({ enabled })} />
      <div className="grid compact">
        <TimeField label="Bedtime" value={draft.power.onTime} onChange={onTime => power({ onTime })} />
        <TimeField label="Routine end" value={draft.power.offTime} onChange={offTime => power({ offTime })} />
      </div>
      <NumberField label="Overnight target (°F)" value={draft.power.onTemperature} onChange={onTemperature => power({ onTemperature })} />
      <label>
        At routine end
        <select value={draft.power.endAction} onChange={event => power({ endAction: event.target.value as 'turn_off' | 'maintain' })}>
          <option value="turn_off">Turn temperature off</option>
          <option value="maintain">Keep the last target</option>
        </select>
      </label>
      <Check label="Include a wake alarm" value={draft.alarm !== null} onChange={enabled => change({ ...draft, alarm: enabled ? { time: '07:00', alarmTemperature: 82, vibrationIntensity: 40, vibrationPattern: 'rise', duration: 20, wakeWindow: 0, enabled: true, snoozeDuration: 300, snoozeTaper: 0 } : null })} />
      {draft.alarm && (
        <>
          <div className="grid compact">
            <TimeField label="Wake-up" value={draft.alarm.time} onChange={time => alarm({ time })} />
            <NumberField label="Wake target (°F)" value={draft.alarm.alarmTemperature} onChange={alarmTemperature => alarm({ alarmTemperature })} />
          </div>
          <p className="notice" id="routine-summary">
            {title(day)}
            {' '}
            {draft.power.onTime}
            {' '}
            →
            {' '}
            {title(routineEventDay(day, draft.alarm.time, draft.power.onTime))}
            {' '}
            {draft.alarm.time}
            . Warming begins 30 minutes before the alarm. This editor changes a private draft until you publish it.
          </p>
          <details>
            <summary>Vibration &amp; snooze</summary>
            <Check label="Enable this alarm" value={draft.alarm.enabled} onChange={enabled => alarm({ enabled })} />
            <div className="grid compact">
              <NumberField label="Vibration duration (seconds)" min={10} max={180} value={draft.alarm.duration} onChange={duration => alarm({ duration })} />
              <NumberField label="Vibration intensity (%)" min={1} max={100} value={draft.alarm.vibrationIntensity} onChange={vibrationIntensity => alarm({ vibrationIntensity })} />
            </div>
            <label>
              Vibration pattern
              <select value={draft.alarm.vibrationPattern} onChange={event => alarm({ vibrationPattern: event.target.value as 'rise' | 'double' })}>
                <option value="rise">Rise</option>
                <option value="double">Double</option>
              </select>
            </label>
            <label>
              Early wake window
              <select value={draft.alarm.wakeWindow} onChange={event => alarm({ wakeWindow: Number(event.target.value) as 0 | 10 | 15 | 20 | 30 })}>{[0, 10, 15, 20, 30].map(value => <option key={value} value={value}>{value === 0 ? 'At the scheduled time' : `Up to ${value} minutes early`}</option>)}</select>
            </label>
            <NumberField label="Snooze (seconds)" min={60} max={1800} value={draft.alarm.snoozeDuration ?? 300} onChange={snoozeDuration => alarm({ snoozeDuration })} />
            <label>
              Shorten each later snooze
              <select value={draft.alarm.snoozeTaper ?? 0} onChange={event => alarm({ snoozeTaper: Number(event.target.value) as 0 | 30 | 40 | 50 | 60 })}>
                {[0, 30, 40, 50, 60].map(value => (
                  <option key={value} value={value}>
                    {value}
                    %
                  </option>
                ))}
              </select>
            </label>
            <p className="small">Settings describe the request. Intensity and patterns still depend on your cover’s tested hardware behavior.</p>
          </details>
        </>
      )}
      <details>
        <summary>
          Overnight changes &amp; notes (
          {draft.temperatures.length}
          {' '}
          phases)
        </summary>
        {draft.temperatures.map((point, index) => (
          <fieldset key={index}>
            <legend>
              Phase
              {index + 1}
            </legend>
            <div className="grid compact">
              <TimeField label={`Phase ${index + 1} time`} value={point.time} onChange={time => change({ ...draft, temperatures: draft.temperatures.map((item, position) => position === index ? { ...item, time } : item) })} />
              <NumberField label={`Phase ${index + 1} target (°F)`} value={point.temperature} onChange={temperature => change({ ...draft, temperatures: draft.temperatures.map((item, position) => position === index ? { ...item, temperature } : item) })} />
            </div>
            <Check label={`Enable phase ${index + 1}`} value={point.enabled} onChange={enabled => change({ ...draft, temperatures: draft.temperatures.map((item, position) => position === index ? { ...item, enabled } : item) })} />
            <button type="button" onClick={() => change({ ...draft, temperatures: draft.temperatures.filter((_, position) => position !== index) })}>
              Remove phase
              {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          disabled={draft.temperatures.length >= 96}
          onClick={() => {
            const used = new Set(draft.temperatures.map(point => point.time))
            const available = Array.from({ length: 1440 }, (_, minute) => `${Math.floor(minute / 60).toString().padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`).find(time => !used.has(time)) ?? '00:00'
            change({ ...draft, temperatures: [...draft.temperatures, { time: available, temperature: draft.power.onTemperature, enabled: false }] })
          }}
        >
          Add temperature phase
        </button>
        <label>
          Private notes
          <textarea value={draft.notes} maxLength={1000} onChange={event => change({ ...draft, notes: event.target.value })} />
        </label>
      </details>
    </>
  )
}
export function NightSummary({ draft, day }: {
  draft?: BedtimeDraft
  day: DayOfWeek
}) {
  if (!draft)
    return <p>No routine.</p>
  const alarm = draft.alarm
  return (
    <div className="night-summary">
      <p>
        <strong>{draft.power.enabled ? 'Enabled' : 'Disabled'}</strong>
        {' '}
        ·
        {' '}
        {draft.power.onTime}
        {' '}
        at
        {' '}
        {draft.power.onTemperature}
        °F
        <br />
        End
        {' '}
        {title(routineEventDay(day, draft.power.offTime, draft.power.onTime))}
        {' '}
        {draft.power.offTime}
        {' '}
        ·
        {' '}
        {draft.power.endAction === 'maintain' ? 'keep last target' : 'temperature off'}
      </p>
      <p>{alarm ? `${alarm.enabled ? 'Alarm' : 'Disabled alarm'}: ${title(routineEventDay(day, alarm.time, draft.power.onTime))} ${alarm.time} · ${alarm.alarmTemperature}°F · ${alarm.duration}s vibration · ${alarm.vibrationIntensity}% ${alarm.vibrationPattern}. Early window ${alarm.wakeWindow}min; snooze ${alarm.snoozeDuration ?? 300}s, taper ${alarm.snoozeTaper ?? 0}%.` : 'No wake alarm.'}</p>
      {draft.temperatures.length > 0
        ? (
            <ul>
              {draft.temperatures.map(point => (
                <li key={point.time}>
                  {point.time}
                  {' '}
                  →
                  {' '}
                  {point.temperature}
                  °F ·
                  {' '}
                  {point.enabled ? 'enabled' : 'disabled'}
                </li>
              ))}
            </ul>
          )
        : <p>No overnight temperature changes.</p>}
      {draft.notes && (
        <p>
          {`Notes: ${draft.notes}`}
        </p>
      )}
    </div>
  )
}
function WeekReview({ workspace, review }: {
  workspace: PersonalWebWorkspace
  review: PersonalRoutineReview
}) {
  const [replaceWeek, setReplaceWeek] = useState(false), [currentEffect, setCurrentEffect] = useState(false)
  const state = workspace.getSnapshot()
  const reasons = { ready: 'Ready for your review.', unchanged: 'Your draft already matches the operating week.', draft_not_prepared: 'Save an intentional draft before replacing the operating week.', calendar_migration_required: 'Existing calendar schedules need migration before publication.', publication_disabled: 'Routine publication is not enabled yet.' }
  return (
    <section aria-label="Whole-week comparison" className="week-review">
      <h3>Review the entire week</h3>
      <p>
        {reasons[review.reason]}
        {' '}
        Times use
        {' '}
        {review.timeZone}
        .
      </p>
      <p>
        {`Temperature: ${review.temperatureZones.map(title).join(' + ')}. Scheduled vibration: ${title(review.sourceSide)} only.`}
      </p>
      {DAYS_OF_WEEK.map(day => (
        <details key={day} open={review.changes.some(change => change.dayOfWeek === day)}>
          <summary>
            {title(day)}
            {' '}
            night ·
            {' '}
            {review.changes.find(change => change.dayOfWeek === day)?.operation ?? 'unchanged'}
          </summary>
          <div className="grid compact">
            <div>
              <h4>Operating now</h4>
              <NightSummary day={day} draft={review.liveWeek.find(night => night.dayOfWeek === day)?.draft} />
            </div>
            <div>
              <h4>After publication</h4>
              <NightSummary day={day} draft={review.draftWeek.find(night => night.dayOfWeek === day)?.draft} />
            </div>
          </div>
        </details>
      ))}
      <Check label="I reviewed every night, including any removed routines." value={replaceWeek} onChange={setReplaceWeek} />
      <Check label="I understand publishing can change the current bed target." value={currentEffect} onChange={setCurrentEffect} />
      <button className="primary" type="button" disabled={!replaceWeek || !currentEffect || !review.canPublish || !state.storageReady || state.busy.includes('publication') || state.references.length > 0} onClick={() => void workspace.publish(review, { replaceWeek, currentEffect })}>Publish my operating week</button>
    </section>
  )
}
export function RoutineEditor({ workspace, state, preferredTemperatureF }: {
  workspace: PersonalWebWorkspace
  state: PersonalWebState
  preferredTemperatureF: number
}) {
  const [week, setWeek] = useState<PersonalWeek>(() => weekCopy(state.drafts?.routines ?? []))
  const [day, setDay] = useState<DayOfWeek>('sunday')
  const [error, setError] = useState('')
  const [comparison, setComparison] = useState<PersonalRoutineReview | null>(null)
  const original = state.drafts?.routines ?? []
  const dirty = JSON.stringify(week) !== JSON.stringify(weekCopy(original))
  const draft = week.find(night => night.dayOfWeek === day)?.draft
  const change = (replacement: BedtimeDraft) => {
    setComparison(null)
    setWeek(week.map(night => night.dayOfWeek === day ? { ...night, draft: replacement } : night))
  }
  const publication = workspace.dependencies.session.capabilities.personalRoutinePublication
  return (
    <article className="routine-editor">
      <div className="row">
        <h2>Your bedtime plan</h2>
        <span className="pill">{dirty ? 'Unsaved edits' : 'Private draft'}</span>
      </div>
      <p>Choose the night you go to bed. Sunday night leads to Monday morning. Save privately first; publishing is a separate step.</p>
      {publication && (
        <button
          type="button"
          disabled={state.busy.some(value => ['review', 'draft', 'draft-reload'].includes(value))}
          onClick={async () => {
            if (dirty && !confirm('Replace your unsaved editor with the current operating week?'))
              return
            const review = await workspace.reviewRoutine()
            if (review) {
              setWeek(weekCopy(review.liveWeek))
              setComparison(null)
              setError('Current operating week copied into this editor only. Save the draft before reviewing publication.')
            }
          }}
        >
          Load current bed plan into editor
        </button>
      )}
      <form onSubmit={async (event) => {
        event.preventDefault()
        setError('')
        setComparison(null)
        const invalid = week.flatMap((night) => {
          const result = bedtimeDraftSchema.safeParse(night.draft)
          return result.success ? [] : result.error.issues.map(issue => `${title(night.dayOfWeek)}: ${issue.message}`)
        })
        if (invalid.length) {
          setError(invalid.join(' '))
          return
        }
        await workspace.saveDraft(week)
      }}
      >
        <fieldset className="editor-fields" disabled={state.busy.some(value => ['draft', 'draft-reload'].includes(value))}>
          <label>
            Night beginning on
            <select value={day} onChange={event => setDay(event.target.value as DayOfWeek)}>{DAYS_OF_WEEK.map(value => <option key={value} value={value}>{title(value)}</option>)}</select>
          </label>
          {draft
            ? (
                <>
                  <NightFields draft={draft} day={day} change={change} />
                  <button
                    type="button"
                    onClick={() => {
                      setComparison(null)
                      setWeek(week.filter(night => night.dayOfWeek !== day))
                    }}
                  >
                    {`Remove ${title(day)} from draft`}
                  </button>
                </>
              )
            : (
                <div className="notice">
                  <p>
                    {`No ${title(day)} routine in this draft.`}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setComparison(null)
                      setWeek([...week, { dayOfWeek: day, draft: { power: { onTime: '22:00', offTime: '07:15', onTemperature: preferredTemperatureF, enabled: true, endAction: 'turn_off' }, temperatures: [], alarm: null, notes: '' } }])
                    }}
                  >
                    {`Add ${title(day)} night`}
                  </button>
                </div>
              )}
          <p className="small">
            {week.length}
            {' '}
            nights in this draft. Removing a night will remove its live routine only if you later publish the full week. Temperatures in this editor are Fahrenheit to preserve the Pod’s whole-degree settings.
          </p>
          <button type="submit" className="primary" disabled={state.busy.includes('draft')}>Save my private draft</button>
          <button
            type="button"
            disabled={state.busy.includes('refresh') || state.busy.includes('draft')}
            onClick={() => {
              if (!dirty || confirm('Discard unsaved edits and reload the saved draft?')) {
                setComparison(null)
                void workspace.refresh(true)
              }
            }}
          >
            Reload saved draft
          </button>
        </fieldset>
      </form>
      {error && <p role="alert" className="notice">{error}</p>}
      {publication
        ? (
            <>
              <button
                type="button"
                disabled={dirty || state.busy.includes('review') || state.busy.includes('draft')}
                onClick={async () => {
                  setComparison(await workspace.reviewRoutine())
                }}
              >
                Compare with operating week
              </button>
              {dirty && <p className="small">Save your edits before comparing or publishing.</p>}
            </>
          )
        : <p className="notice">Draft preparation is available. Publishing to the bed awaits the reviewed household rollout.</p>}
      {!dirty && comparison && state.review?.reviewRevision === comparison.reviewRevision && <WeekReview key={comparison.reviewRevision} workspace={workspace} review={comparison} />}
    </article>
  )
}
