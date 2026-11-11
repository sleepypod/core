import { journalHabits, type JournalContext } from '@/src/journal/context'
import type { ContextTimeDraft, ContextTimeKey, JournalContextDraft, JournalHabit } from '@/src/journal/contextDraft'
import { journalWallTimeCandidates } from '@/src/journal/contextClock'

const fieldClass = 'w-full min-h-11 min-w-0 rounded-ctl border border-line bg-surface px-3 py-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg'
const labels = { caffeine: 'Caffeine', alcohol: 'Alcohol', exercise: 'Exercise' }
const amounts = { caffeine: 'Total caffeine (mg)', alcohol: 'Total alcohol (US standard drinks)', exercise: 'Total exercise (minutes)' }
const timeLabels = { caffeine: 'Last caffeine', alcohol: 'Last drink', exercise: 'Exercise finished', bedtimeAt: 'Reported bedtime', lastMealAt: 'Last meal' }

export function JournalContextEditor({ draft, timeZone, error, onChange }: { draft: JournalContextDraft, timeZone: string, error?: string, onChange(value: JournalContextDraft): void }) {
  const habitChange = (habit: JournalHabit, value: Partial<JournalContextDraft['habits'][JournalHabit]>) => {
    const next = { ...draft, habits: { ...draft.habits, [habit]: { ...draft.habits[habit], ...value } } }
    if (value.status && value.status !== 'yes') {
      next.habits[habit].amount = ''
      next.times = { ...next.times, [habit]: { value: '' } }
    }
    onChange(next)
  }
  const timeField = (name: ContextTimeKey) => <JournalTimeField label={timeLabels[name]} value={draft.times[name]} timeZone={timeZone} onChange={value => onChange({ ...draft, times: { ...draft.times, [name]: value } })} />
  return (
    <div className="space-y-4 border-t border-line pt-5">
      <div className="max-w-prose space-y-1">
        <h3 className="font-medium">The day before</h3>
        <p className="text-sm text-fg-2">Log only what you remember. Blank amounts and times stay unknown.</p>
      </div>
      {journalHabits.map(habit => (
        <div key={habit} className="space-y-3 border-b border-line pb-4">
          <label className="flex flex-wrap items-center justify-between gap-3 text-sm font-medium">
            {labels[habit]}
            <select className={`${fieldClass} max-w-48 font-normal`} aria-label={`${labels[habit]} status`} value={draft.habits[habit].status} onChange={event => habitChange(habit, { status: event.target.value as JournalContext[JournalHabit]['status'] })}>
              <option value="not_logged">Not logged</option>
              <option value="none">None</option>
              <option value="yes">Yes</option>
            </select>
          </label>
          {draft.habits[habit].status === 'yes' && (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <label className="min-w-0 space-y-1 text-sm">
                <span>{amounts[habit]}</span>
                <input className={fieldClass} aria-label={amounts[habit]} type="number" min={0} step="any" max={habit === 'caffeine' ? 10000 : habit === 'alcohol' ? 100 : 1440} value={draft.habits[habit].amount} onChange={event => habitChange(habit, { amount: event.target.value })} />
                {habit === 'alcohol' && (
                  <span className="block text-xs text-fg-2">
                    One US standard drink contains 14 g of alcohol.
                    {' '}
                    <a className="underline underline-offset-4" href="https://www.niaaa.nih.gov/alcohols-effects-health/what-standard-drink" target="_blank" rel="noreferrer">Check drink sizes</a>
                    .
                  </span>
                )}
              </label>
              {timeField(habit)}
            </div>
          )}
        </div>
      ))}
      <details className="space-y-3">
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">Bedtime, meal and stress context</summary>
        <p className="max-w-prose text-sm text-fg-2">Add bedtime to compare when habits happened before sleep. This is your recollection, separate from measured sleep.</p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {timeField('bedtimeAt')}
          {timeField('lastMealAt')}
          <label className="space-y-1 text-sm">
            <span>Stress compared with your usual day</span>
            <select className={fieldClass} aria-label="Stress compared with your usual day" value={draft.stress} onChange={event => onChange({ ...draft, stress: event.target.value as JournalContext['stress'] })}>
              <option value="not_logged">Not logged</option>
              <option value="lower">Lower</option>
              <option value="usual">Usual</option>
              <option value="higher">Higher</option>
            </select>
          </label>
        </div>
      </details>
      <p className="max-w-prose break-words text-xs text-fg-2">
        {`Times use ${timeZone}. Use the day before this wake date or the wake date itself. Context is saved on your Pod and is not sent to AI.`}
      </p>
      {error && <p role="alert" className="max-w-prose text-sm text-danger">{error}</p>}
    </div>
  )
}

function JournalTimeField({ label, value, timeZone, onChange }: { label: string, value: ContextTimeDraft, timeZone: string, onChange(value: ContextTimeDraft): void }) {
  const candidates = value.value ? journalWallTimeCandidates(value.value, timeZone) : []
  return (
    <div className="min-w-0 space-y-2 text-sm">
      <label className="block min-w-0 space-y-1">
        <span>{label}</span>
        <input className={fieldClass} type="datetime-local" step={60} value={value.value} onChange={event => onChange({ value: event.target.value })} />
      </label>
      {candidates.length > 1 && (
        <label className="block space-y-1">
          <span>This clock time occurs twice</span>
          <select className={fieldClass} aria-label={`${label} clock occurrence`} value={value.occurrence ?? ''} onChange={event => onChange({ ...value, occurrence: event.target.value ? Number(event.target.value) : undefined })}>
            <option value="">Choose occurrence</option>
            {candidates.map((instant, index) => (
              <option key={instant} value={instant}>
                {index === 0 ? 'Earlier' : 'Later'}
                {' '}
                ·
                {' '}
                {new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset' }).format(instant)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

export function JournalContextSummary({ context, timeZone }: { context: JournalContext, timeZone: string }) {
  const time = (value?: number) => value === undefined ? 'not logged' : new Intl.DateTimeFormat('en', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(value)
  return (
    <div className="space-y-1 text-sm">
      {journalHabits.map(habit => (
        <p key={habit}>
          {labels[habit]}
          :
          {' '}
          {context[habit].status.replace('_', ' ')}
          {' '}
          · amount
          {' '}
          {context[habit].amount ?? 'unknown'}
          {' '}
          {context[habit].unit === 'usStandardDrinks' ? 'US standard drinks' : context[habit].unit}
          {' '}
          ·
          {' '}
          {timeLabels[habit].toLowerCase()}
          :
          {' '}
          {time(context[habit].lastAt)}
        </p>
      ))}
      <p>{`Reported bedtime: ${time(context.bedtimeAt)} · last meal: ${time(context.lastMealAt)} · stress: ${context.stress.replace('_', ' ')}`}</p>
      <p>{timeZone}</p>
    </div>
  )
}
