import { useState } from 'react'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import type { ArrangementReview } from '../arrangementContract'
import type { PersonalWebState, PersonalWebWorkspace } from './workspace'
import { NightSummary } from './RoutineEditor'

const title = (value: string) => value[0].toUpperCase() + value.slice(1)
const statusText: Record<ArrangementReview['state'], string> = {
  awaiting_approval: 'Waiting for each person’s approval.',
  approved_for_separate_activation: 'Both approvals are saved. The bed has not switched sides.',
  stale: 'Settings changed. Cancel this review and prepare a fresh one.',
  expired: 'This review expired. Prepare a fresh review when you are both ready.',
  cancelled: 'This review was cancelled. The bed has not changed.',
  consumed: 'This review was used by a separate activation. Check the current bed arrangement.',
}

function OwnReview({ review, workspace, state }: { review: ArrangementReview, workspace: PersonalWebWorkspace, state: PersonalWebState }) {
  const [side, setSide] = useState(false)
  const [routine, setRoutine] = useState(false)
  const [separateActivation, setSeparateActivation] = useState(false)
  const current = state.arrangementLoaded && state.now >= review.createdAt && state.now < review.expiresAt
  const busy = state.busy.includes('arrangement')
  const pastValidity = state.now < review.createdAt || state.now >= review.expiresAt
  const status = pastValidity && ['awaiting_approval', 'approved_for_separate_activation'].includes(review.state) ? 'expired' : review.state
  return (
    <>
      <p className="notice" aria-live="polite">{statusText[status]}</p>
      <div className="personal-bed" aria-label="Proposed sides only">
        {[review.self, review.partner].sort((first, second) => first.proposedSide.localeCompare(second.proposedSide)).map(person => (
          <div className="bed-zone" key={person.proposedSide}>
            <div className="pillow" aria-hidden="true" />
            <h3>{title(person.proposedSide)}</h3>
            <strong>{person.displayName}</strong>
            <span>{person === review.self ? 'Your proposed side' : 'Partner’s proposed side'}</span>
            <span>{person.approved ? 'Approval saved' : 'Waiting for approval'}</span>
          </div>
        ))}
      </div>
      <h3>Your settings in this review</h3>
      <p>
        Preferred temperature:
        {' '}
        {review.self.preferences.preferredTemperatureF}
        °F ·
        {' '}
        {review.self.preferences.comfort.replaceAll('_', ' ')}
        .
        {' '}
        These are your settings only; your partner’s routine and health history stay private.
      </p>
      <p>{review.self.routineSource === 'preserved_operating_week' ? 'Your existing operating week will be preserved for your proposed side.' : 'Your saved private draft is included for your proposed side.'}</p>
      <p className="small">{`Times use ${review.timeZone}. Each night is named by its bedtime day. Wake warming begins 30 minutes before an enabled alarm. A disabled night does not run its alarm.`}</p>
      <div aria-label="Your proposed full week">
        {DAYS_OF_WEEK.map(day => (
          <details key={day}>
            <summary>
              {title(day)}
              {' '}
              night
            </summary>
            <NightSummary day={day} draft={review.self.week.find(night => night.dayOfWeek === day)?.draft} />
          </details>
        ))}
      </div>
      {!review.self.approved && (
        <fieldset disabled={!current || busy || !review.canApprove}>
          <legend>Your independent approval</legend>
          <label className="check">
            <input type="checkbox" checked={side} onChange={event => setSide(event.target.checked)} />
            {title(review.self.proposedSide)}
            {' '}
            is my intended side.
          </label>
          <label className="check">
            <input type="checkbox" checked={routine} onChange={event => setRoutine(event.target.checked)} />
            I reviewed my temperatures, nights and wake alarms.
          </label>
          <label className="check">
            <input type="checkbox" checked={separateActivation} onChange={event => setSeparateActivation(event.target.checked)} />
            I understand that switching the bed needs a separate activation.
          </label>
          <button className="primary" type="button" disabled={!side || !routine || !separateActivation} onClick={() => void workspace.approveArrangement({ side, routine, separateActivation })}>Approve my side and routine</button>
        </fieldset>
      )}
      {['awaiting_approval', 'approved_for_separate_activation', 'stale', 'expired'].includes(review.state) && <button type="button" disabled={busy || !state.arrangementLoaded} onClick={() => void workspace.cancelArrangement()}>Cancel side review</button>}
      <p className="small">{`Review valid until ${new Date(review.expiresAt).toLocaleTimeString([], { timeZone: review.timeZone, hour: 'numeric', minute: '2-digit' })} in ${review.timeZone}. Changing either person’s plan requires fresh approvals.`}</p>
    </>
  )
}

/** Preparation is intentionally separate from changing operating schedules. */
export function ArrangementReviewPanel({ workspace, state }: { workspace: PersonalWebWorkspace, state: PersonalWebState }) {
  const [ownerSide, setOwnerSide] = useState<'left' | 'right'>('right')
  const [preserve, setPreserve] = useState(false)
  const session = workspace.dependencies.session
  if (!session.capabilities.arrangementReview) return null
  const review = state.arrangement
  const canPrepare = state.arrangementLoaded && (!review || ['cancelled', 'expired'].includes(review.state))
  const busy = state.busy.includes('arrangement')
  return (
    <article className="arrangement-review" aria-label="Shared side review">
      <p className="eyebrow">When you are both ready</p>
      <h2>Review your future sides together.</h2>
      <p>The bed stays in solo mode during this review. Both people first save their own preferences; the joining person also prepares a private routine draft.</p>
      <button type="button" disabled={busy} onClick={() => void workspace.refreshArrangement()}>Check current side review</button>
      {!state.arrangementLoaded && <p className="notice">Check the current review before making a change. A missing reply is never retried automatically.</p>}
      {review && <OwnReview key={`${review.reviewId}:${review.state}:${review.self.approved}`} review={review} workspace={workspace} state={state} />}
      {session.role === 'owner' && canPrepare && (
        <form onSubmit={(event) => {
          event.preventDefault()
          void workspace.proposeArrangement(ownerSide, preserve)
        }}
        >
          <label>
            My future side
            <select value={ownerSide} onChange={event => setOwnerSide(event.target.value as 'left' | 'right')}>
              <option value="right">Right</option>
              <option value="left">Left</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={preserve} onChange={event => setPreserve(event.target.checked)} />
            Keep my current operating week, including wake alarms, for my proposed side.
          </label>
          <button className="primary" type="submit" disabled={busy || !preserve}>Prepare shared side review</button>
        </form>
      )}
      <p className="notice">This step saves a proposal and approvals only. Switching to two sleepers is not available in this release.</p>
    </article>
  )
}
