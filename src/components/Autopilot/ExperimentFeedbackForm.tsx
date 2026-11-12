import { useId, useState } from 'react'
import type { ExperimentDetail } from '@/src/comfort/experiments/browserContract'
import type { ExperimentFeedback } from '@/src/comfort/experiments/contract'
import { experimentDate, experimentGapLabels } from './experimentPresentation'
export function ExperimentFeedbackForm({ detail, now, busy, save }: {
  detail: ExperimentDetail
  now: number
  busy: boolean
  save(value: Omit<ExperimentFeedback, 'recordedAt'>): void
}) {
  const prefix = useId()
  const [date, setDate] = useState(''), [comfort, setComfort] = useState(''), [full, setFull] = useState('')
  const [unwanted, setUnwanted] = useState(''), [problem, setProblem] = useState('')
  const plan = detail.record.plan
  const eligible = plan.version === 2 ? plan.schedule.windows.filter(window => now >= window.windowEnd && now <= window.windowEnd + 14 * 86400000) : []
  const selected = detail.record.feedback.find(item => item.nightDate === date)
  const valid = eligible.some(window => window.date === date) && comfort !== '' && full !== '' && unwanted !== '' && problem !== ''
  return (
    <div className="experiment-feedback">
      <h4>Morning check-in</h4>
      {!eligible.length && <p>Check-ins open after a planned night ends and remain available for 14 days.</p>}
      {eligible.length > 0 && (
        <form onSubmit={(event) => {
          event.preventDefault()
          if (valid)
            save({ nightDate: date, comfort: Number(comfort), confirmedFullNight: full === 'yes', unwantedAdjustments: Number(unwanted), problem: problem === 'yes' })
        }}
        >
          <div className="experiment-fields">
            <label htmlFor={`${prefix}-date`}>
              Night beginning
              <select
                id={`${prefix}-date`}
                required
                value={date}
                disabled={busy}
                onChange={(event) => {
                  setDate(event.target.value)
                  const existing = detail.record.feedback.find(item => item.nightDate === event.target.value)
                  setComfort(existing ? String(existing.comfort) : '')
                  setFull(existing ? existing.confirmedFullNight ? 'yes' : 'no' : '')
                  setUnwanted(existing ? String(existing.unwantedAdjustments) : '')
                  setProblem(existing ? existing.problem ? 'yes' : 'no' : '')
                }}
              >
                <option value="">Choose a night</option>
                {eligible.map(window => <option key={window.date} value={window.date}>{experimentDate(window.date)}</option>)}
              </select>
            </label>
            <label htmlFor={`${prefix}-comfort`}>
              Comfort, from 0 to 10
              <select id={`${prefix}-comfort`} required value={comfort} disabled={busy || !date} onChange={event => setComfort(event.target.value)}>
                <option value="">Choose a rating</option>
                {Array.from({ length: 11 }, (_, value) => (
                  <option key={value} value={value}>
                    {value}
                    {value === 0 ? ' · Very uncomfortable' : value === 10 ? ' · Very comfortable' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${prefix}-full`}>
              Was this a full night for you?
              <select id={`${prefix}-full`} required value={full} disabled={busy || !date} onChange={event => setFull(event.target.value)}>
                <option value="">Choose</option>
                <option value="yes">Yes</option>
                <option value="no">No, a partial night</option>
              </select>
            </label>
            <label htmlFor={`${prefix}-unwanted`}>
              Unwanted temperature changes
              <input id={`${prefix}-unwanted`} type="number" inputMode="numeric" min="0" max="100000" step="1" required value={unwanted} disabled={busy || !date} onChange={event => setUnwanted(event.target.value)} />
            </label>
            <label htmlFor={`${prefix}-problem`}>
              Did you notice a problem?
              <select id={`${prefix}-problem`} required value={problem} disabled={busy || !date} onChange={event => setProblem(event.target.value)}>
                <option value="">Choose</option>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
          </div>
          <button className="experiment-primary" type="submit" disabled={busy || !valid}>{selected ? 'Update morning feedback' : 'Save morning feedback'}</button>
        </form>
      )}
      <details>
        <summary>Saved check-ins and recording gaps</summary>
        <ul className="experiment-observations">
          {detail.comparison.nights.map(night => (
            <li key={night.date}>
              <strong>{experimentDate(night.date)}</strong>
              <p>
                {night.comfort === null ? 'No morning rating' : `Comfort ${night.comfort}/10`}
                {night.problem ? ' · Problem reported' : ''}
                {night.unwantedAdjustments ? ` · ${night.unwantedAdjustments} unwanted changes` : ''}
              </p>
              <p className="experiment-muted">{night.usable ? 'Usable comparison observation' : night.role === 'settling' ? 'Settling night, not a scored comparison' : 'Not included in the scored comparison'}</p>
              {night.exclusions.length > 0 && <ul>{night.exclusions.map(reason => <li key={reason}>{experimentGapLabels[reason]}</li>)}</ul>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
