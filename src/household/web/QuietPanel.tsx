import { useState, useSyncExternalStore } from 'react'
import type { PersonalQuietWorkspace } from './quiet'

export function QuietPanel({ quiet }: { quiet: PersonalQuietWorkspace }) {
  const state = useSyncExternalStore(quiet.subscribe, quiet.getSnapshot)
  const [minutes, setMinutes] = useState(120)
  if (!state.available) return null
  const page = state.fresh ? state.page : null
  const time = (instant: number) => new Date(instant).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  const editable = state.fresh && !state.busy && !state.pending
  return (
    <article className="quiet-panel" aria-labelledby="quiet-heading">
      <div className="row">
        <h2 id="quiet-heading">Someone is resting</h2>
        <button type="button" disabled={state.busy} onClick={() => void quiet.refresh()}>{state.busy ? 'Checking quiet time…' : 'Refresh quiet status'}</button>
      </div>
      <p>Pause shared bedroom actions for a while. Each person controls their own quiet request.</p>
      <div className="quiet-reading" aria-live="polite">
        <strong>{!page ? 'Quiet status unavailable' : page.shared.paused ? 'Quiet time active' : 'No quiet requests active'}</strong>
        {page && <p>{page.shared.until === null ? 'Connected bedroom routines can follow their normal rules.' : `Until ${time(page.shared.until)}. Ending your request cannot cancel someone else’s.`}</p>}
        <p>{!page ? 'Refresh to see the current state before making a change.' : page.mine.until === null ? 'You have no active quiet request.' : `Your request ends ${time(page.mine.until)}.`}</p>
      </div>
      {state.error && <p className="quiet-message" role="alert">{state.error}</p>}
      {state.message && <p className="quiet-message" role="status">{state.message}</p>}
      {state.pending && <button type="button" disabled={state.busy} onClick={() => void quiet.reconcile()}>Check saved quiet result</button>}
      <form onSubmit={(event) => {
        event.preventDefault()
        void quiet.change(minutes)
      }}
      >
        <label htmlFor="quiet-duration">Keep shared actions quiet for</label>
        <div className="quiet-actions">
          <select id="quiet-duration" disabled={!editable} value={minutes} onChange={event => setMinutes(Number(event.target.value))}>
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
            <option value={120}>2 hours</option>
            <option value={480}>8 hours</option>
          </select>
          <button type="submit" className="primary" disabled={!editable}>{page?.mine.until ? 'Update my quiet time' : 'Start quiet time'}</button>
          {page?.mine.until && <button type="button" disabled={!editable} onClick={() => void quiet.change(null)}>End my quiet request</button>}
        </div>
      </form>
      <p className="small">Times use this device’s time zone. Your temperature routine and wake alarm continue.</p>
      <details>
        <summary>What quiet time pauses</summary>
        <p>New base movements and the connected Sleepypod routines for lights, shades and the purifier. Other home automations and audio are not connected to quiet time yet.</p>
        <p>Home routines receive the pause over your home connection, which can take a few seconds.</p>
        <p>A movement already in progress may continue. Use the base’s Stop control when you need to stop it.</p>
      </details>
    </article>
  )
}
