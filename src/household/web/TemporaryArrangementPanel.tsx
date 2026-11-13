import { useState, useSyncExternalStore } from 'react'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import type { TemporaryReview } from '../temporary/contract'
import type { TemporaryArrangementWorkspace } from './temporary'
import { NightSummary } from './RoutineEditor'

const sideName = (value: string | null) => value === null ? 'Away from the bed' : value === 'solo' ? 'Either side' : value === 'left' ? 'Left' : value === 'right' ? 'Right' : 'Not assigned'
const messages: Record<TemporaryReview['state'], string> = {
  awaiting_approval: 'Waiting for independent approvals',
  approved_for_separate_activation: 'Approvals saved · bed unchanged',
  stale: 'Settings changed · cancel this review before preparing another',
  expired: 'Review expired · prepare a fresh plan',
  cancelled: 'Review cancelled · bed unchanged',
  consumed: 'Review already used · check the current arrangement',
}
const dayName = (day: string) => day[0].toUpperCase() + day.slice(1)
const when = (instant: number, timeZone: string) => new Date(instant).toLocaleString(undefined,
  { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function SavedReview({ review, workspace, editable, busy, fresh }: { review: TemporaryReview, workspace: TemporaryArrangementWorkspace, editable: boolean, busy: boolean, fresh: boolean }) {
  const [confirmed, setConfirmed] = useState({ side: false, routine: false, recording: false, separate: false })
  const allConfirmed = Object.values(confirmed).every(Boolean)
  const usable = fresh && ['awaiting_approval', 'approved_for_separate_activation'].includes(review.state)
  return (
    <>
      <p className="temporary-status" role="status">{fresh ? messages[review.state] : `Saved status: ${messages[review.state]}`}</p>
      <dl className="temporary-comparison">
        <div>
          <dt>Your side when saved</dt>
          <dd>{sideName(review.self.assignmentAtReview)}</dd>
        </div>
        <div>
          <dt>Your proposed side</dt>
          <dd>{sideName(review.self.proposedSide)}</dd>
        </div>
        <div>
          <dt>Intended end</dt>
          <dd>{when(review.intendedEnd, review.timeZone)}</dd>
        </div>
      </dl>
      <div className="temporary-bed" aria-label="Proposed bed sides, not active">
        {(['left', 'right'] as const).map((side) => {
          const person = [review.self, ...review.others].find(value => value.proposedSide === side)
          return (
            <div className="temporary-zone" key={side}>
              <div className="pillow" aria-hidden="true" />
              <span>{sideName(side)}</span>
              <strong>{review.guestSide === side ? 'Guest' : person?.displayName ?? 'No sleeper assigned'}</strong>
              <span>{review.guestSide === side ? 'Personal recording withheld' : !usable ? 'Fresh review needed' : person?.approved ? 'Approval saved' : 'Approval needed'}</span>
            </div>
          )
        })}
      </div>
      {review.others.filter(person => person.proposedSide === null).map(person => (
        <p key={person.displayName}>
          {person.displayName}
          {' '}
          would be away from the bed.
          {' '}
          {!usable ? 'These are details saved with this review.' : person.approved ? 'Their approval is saved.' : 'Their independent approval is still needed.'}
        </p>
      ))}
      <h3>Your routine in this plan</h3>
      <p>
        {review.self.proposedSide === null
          ? 'Your operating nights would pause while you are away. Your original week is preserved for a separately reviewed return.'
          : 'The operating nights saved with this review would follow you to your proposed side. Unpublished drafts are not substituted.'}
      </p>
      <p>{`Your preferred temperature when saved: ${review.self.preferences.preferredTemperatureF}°F. Other people’s temperatures, alarms and recordings stay private.`}</p>
      <details>
        <summary>Review your nights and wake alarms</summary>
        <p className="small">{`Times use ${review.timeZone}. Nights are named by their bedtime day. These are proposed settings, not a new live schedule.`}</p>
        {DAYS_OF_WEEK.map(day => (
          <details key={day}>
            <summary>
              {dayName(day)}
              {' '}
              night
            </summary>
            <NightSummary day={day} draft={review.self.operatingWeek.find(night => night.dayOfWeek === day)?.draft} />
          </details>
        ))}
      </details>
      <h3>Recording and return</h3>
      <p>
        {review.kind === 'guest'
          ? 'If activated later, personal recordings would be withheld for the guest interval, including yours. This prevents guest data entering either person’s history.'
          : 'If activated later, new recordings would follow the reviewed side assignments. Existing recordings stay with their original person.'}
      </p>
      <p>Learning would pause and shared bedroom actions would stay quiet until a fresh return review. Reaching the intended end would not automatically switch sides or restore older settings.</p>
      {!fresh && (
        <div className="temporary-recheck">
          <p>Check the latest review before saving an approval or cancellation. Your selections stay here; checking sends no approval.</p>
          <button type="button" disabled={busy} onClick={() => void workspace.refresh()}>Refresh before deciding</button>
        </div>
      )}
      {!review.self.approved && review.canApprove && (
        <fieldset disabled={!editable}>
          <legend>Your independent approval</legend>
          {([
            ['side', `I reviewed my proposed side: ${sideName(review.self.proposedSide)}.`],
            ['routine', 'I reviewed my temperatures, operating nights and wake alarms.'],
            ['recording', 'I understand the recording, learning and return policy above.'],
            ['separate', 'I understand that this review does not switch the bed.'],
          ] as const).map(([key, label]) => (
            <label className="check" key={key}>
              <input type="checkbox" checked={confirmed[key]} onChange={event => setConfirmed(value => ({ ...value, [key]: event.target.checked }))} />
              {label}
            </label>
          ))}
          <button type="button" className="primary" disabled={!allConfirmed} onClick={() => void workspace.approve(allConfirmed)}>Save my approval</button>
        </fieldset>
      )}
      {review.canCancel && <button type="button" disabled={!editable} onClick={() => void workspace.cancel()}>Cancel temporary review</button>}
      <p className="small">{`Review deadline: ${when(review.reviewExpiresAt, review.timeZone)} (${review.timeZone}). Changes require fresh approvals.`}</p>
    </>
  )
}

export function TemporaryArrangementPanel({ workspace }: { workspace: TemporaryArrangementWorkspace }) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot)
  const [kind, setKind] = useState<'guest' | 'side_swap'>('guest')
  const [residentSide, setResidentSide] = useState<'left' | 'right'>('right')
  const [hours, setHours] = useState(12)
  const [recordingAcknowledged, setRecordingAcknowledged] = useState(false)
  if (!state.available) return null
  const session = workspace.dependencies.session
  const review = state.loaded ? state.review : null
  const editable = state.fresh && !state.busy && !state.pending
  const canPrepare = state.loaded && !state.pending && session.role === 'owner' && (!review || ['cancelled', 'expired', 'consumed'].includes(review.state))
  return (
    <article className="temporary-panel" aria-labelledby="temporary-heading">
      <div className="row">
        <h2 id="temporary-heading">Plan a temporary change</h2>
        <button type="button" disabled={state.busy} onClick={() => void workspace.refresh()}>
          {state.busy ? 'Checking the review…' : state.pending ? 'Check saved review result' : 'Check temporary plans'}
        </button>
      </div>
      <p>Prepare for a guest visit or a short side swap. Each sleeper reviews their own settings.</p>
      <p className="temporary-boundary">
        <strong>Review only.</strong>
        {' '}
        Saving a plan or approval leaves the bed unchanged. Switching and returning are not available yet.
      </p>
      {state.error && <p className="temporary-message" role="alert">{state.error}</p>}
      {state.message && <p className="temporary-message" role="status">{state.message}</p>}
      {!state.fresh && !state.pending && <p>{review ? 'Showing your saved review. Check temporary plans before saving an approval or cancellation.' : 'Check temporary plans to load a current private review.'}</p>}
      {review && <SavedReview key={`${review.reviewId}:${review.state}:${review.self.approved}`} review={review} workspace={workspace} editable={editable} busy={state.busy} fresh={state.fresh} />}
      {state.fresh && !review && <p>No temporary review is saved for your account.</p>}
      {canPrepare && (
        <form onSubmit={(event) => {
          event.preventDefault()
          void workspace.prepare(kind, residentSide, hours, recordingAcknowledged)
        }}
        >
          {!state.fresh && (
            <div className="temporary-recheck">
              <p>Your choices are kept below. Refresh the current plans before preparing this review.</p>
              <button type="button" disabled={state.busy} onClick={() => void workspace.refresh()}>Refresh before preparing</button>
            </div>
          )}
          <fieldset disabled={!editable}>
            <legend>Prepare a private review</legend>
            <div className="temporary-fields">
              <label>
                Change to review
                <select value={kind} onChange={event => setKind(event.target.value as 'guest' | 'side_swap')}>
                  <option value="guest">Guest visit</option>
                  {session.arrangement.mode === 'assigned' && <option value="side_swap">Swap our sides</option>}
                </select>
              </label>
              {kind === 'guest' && (
                <label>
                  My proposed side
                  <select value={residentSide} onChange={event => setResidentSide(event.target.value as 'left' | 'right')}>
                    <option value="right">Right</option>
                    <option value="left">Left</option>
                  </select>
                </label>
              )}
              <label>
                Intended duration from now
                <select value={hours} onChange={event => setHours(Number(event.target.value))}>
                  {[8, 12, 24, 48, 72].map(value => (
                    <option value={value} key={value}>
                      {value}
                      {' '}
                      hours
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {kind === 'guest' && (
              <label className="check">
                <input type="checkbox" checked={recordingAcknowledged} onChange={event => setRecordingAcknowledged(event.target.checked)} />
                I understand that a guest interval would withhold personal recordings for everyone.
              </label>
            )}
            <p className="small">The next step shows your operating nights and proposed side for review. It does not move the base or change temperature.</p>
            <button type="submit" className="primary" disabled={kind === 'guest' && !recordingAcknowledged}>Prepare review</button>
          </fieldset>
        </form>
      )}
      {session.arrangement.mode === 'solo-anywhere' && <p className="small">Side swaps become available after two people have their own reviewed side assignments.</p>}
    </article>
  )
}
