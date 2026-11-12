import type { ExperimentPlan, ExperimentSchedule } from '@/src/comfort/experiments/contract'
import { experimentNights } from '@/src/comfort/experiments/nights'
import { experimentDate } from './experimentPresentation'

const skipped: Record<ExperimentSchedule['skipped'][number]['reason'], string> = {
  not_scheduled: 'No bedtime routine', already_started: 'Bedtime already passed', unbounded_routine: 'Routine needs a clear end',
  overlapping_routines: 'Overlapping routines', wake_overlap: 'Wake warming overlaps bedtime', conflicting_alarms: 'Conflicting wake alarms',
  too_short: 'Less than four hours before wake warming', needs_following_night: 'No consecutive follow-up night',
}
export function ExperimentPlanSummary({ plan, format }: { plan: ExperimentPlan, format(value: number): string }) {
  const nights = experimentNights(plan)
  const time = (instant: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: plan.context.timezone }).format(instant)
  const wakes = plan.version === 2
    ? [...new Set(plan.schedule.windows.map(window => window.wake
        ? `Warming at ${time(window.wake.startsAt)} toward ${format(window.wake.temperatureF)}; wake at ${time(window.wake.at)} with ${window.wake.vibrationSeconds}s vibration.`
        : 'No wake warming inside this experiment window.'))]
    : []
  return (
    <div className="experiment-summary">
      <p>
        <strong>{format(plan.context.baselineF)}</strong>
        {' '}
        current setting ·
        {' '}
        <strong>{format(plan.variantF)}</strong>
        {' '}
        comparison setting
      </p>
      <p>
        16 nights,
        {' '}
        {experimentDate(nights[0].date)}
        –
        {experimentDate(nights[15].date)}
        . Only your existing scheduled nights are included.
      </p>
      <p><strong>Your wake plan stays the same.</strong></p>
      {wakes.length === 1 ? <p>{wakes[0]}</p> : <p>Wake times vary across these nights. Open the night plan below to review each boundary.</p>}
      <p className="experiment-muted">
        {plan.context.timezone}
        {' '}
        · Dates refer to bedtime, not the following morning.
      </p>
    </div>
  )
}
export function ExperimentNightPlan({ plan, format }: { plan: ExperimentPlan, format(value: number): string }) {
  const nights = experimentNights(plan)
  const time = (instant: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: plan.context.timezone }).format(instant)
  return (
    <div className="experiment-calendar">
      <p>
        <strong>{format(plan.context.baselineF)}</strong>
        {' '}
        current setting ·
        {' '}
        <strong>{format(plan.variantF)}</strong>
        {' '}
        comparison setting
      </p>
      <p className="experiment-muted">
        {plan.context.timezone}
        {' '}
        · Dates refer to the evening you go to bed.
      </p>
      {plan.version === 1 && <p className="experiment-notice">This older plan has no verified routine windows. It is available for history only.</p>}
      <ol className="experiment-nights" aria-label="Comparison night plan">
        {nights.map((night, index) => {
          const window = plan.version === 2 ? plan.schedule.windows[index] : null
          return (
            <li key={night.date}>
              <div>
                <strong>{experimentDate(night.date)}</strong>
                <p className="experiment-muted">
                  Pair
                  {' '}
                  {night.pair + 1}
                  {' '}
                  ·
                  {' '}
                  {night.role === 'settling' ? 'Settling night' : 'Comparison night'}
                </p>
              </div>
              <div>
                <strong>{format(night.targetF)}</strong>
                <p className="experiment-muted">{night.arm === 'baseline' ? 'Current setting' : 'Nearby setting'}</p>
              </div>
              {window && (
                <div className="experiment-window">
                  <p>
                    {time(window.windowStart)}
                    –
                    {time(window.windowEnd)}
                  </p>
                  <p className="experiment-muted">
                    {window.wake
                      ? `Then warm toward ${format(window.wake.temperatureF)}; wake at ${time(window.wake.at)}${window.wake.vibrationSeconds ? ` with ${window.wake.vibrationSeconds}s vibration` : ', no vibration'}.`
                      : `The existing routine ${window.endAction === 'turn_off' ? 'turns off' : 'continues at its saved setting'} at ${time(window.routineEnd)}.`}
                  </p>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      {plan.version === 2 && plan.schedule.skipped.length > 0 && (
        <details>
          <summary>
            {plan.schedule.skipped.length}
            {' '}
            skipped dates — no experiment adjustment
          </summary>
          <ul className="experiment-skipped">
            {plan.schedule.skipped.map(day => (
              <li key={day.date}>
                {experimentDate(day.date)}
                {' '}
                ·
                {' '}
                {skipped[day.reason]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
