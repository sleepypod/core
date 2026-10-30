import { useState, useSyncExternalStore } from 'react'
import type { PersonalWebWorkspace } from './workspace'
import { RoutineEditor } from './RoutineEditor'
import { ArrangementReviewPanel } from './ArrangementReviewPanel'
export function PersonalWorkspace({ workspace, preferredTemperatureF, displayUnit }: {
  workspace: PersonalWebWorkspace
  preferredTemperatureF: number
  displayUnit: 'F' | 'C'
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot)
  const [target, setTarget] = useState<number | null>(null)
  const [hold, setHold] = useState(30)
  const bed = state.bed
  const format = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${displayUnit === 'C' ? ((value - 32) * 5 / 9).toFixed(1) : value}°${displayUnit}`
  const reportedTargets = bed?.zones.map(zone => zone.reportedTargetF) ?? []
  const common = state.fresh && reportedTargets.length && reportedTargets.every(value => value !== null && value === reportedTargets[0]) ? reportedTargets[0] : null
  const starting = target !== null && Number.isFinite(target) ? target : Math.round(common ?? preferredTemperatureF)
  return (
    <div className="personal-runtime">
      {state.error && <p role="alert" className="notice">{state.error}</p>}
      {state.message && <p className="notice" data-testid="personal-result" aria-live="polite">{state.message}</p>}
      <article>
        <div className="row">
          <div>
            <p className="eyebrow">Tonight · your permitted bed zones</p>
            <h2>{bed?.arrangement === 'solo-anywhere' ? 'Room to sleep anywhere.' : 'Your side, your comfort.'}</h2>
          </div>
          <button type="button" onClick={() => void workspace.refresh()} disabled={state.busy.includes('refresh')}>Refresh bed</button>
        </div>
        {!bed || bed.availability !== 'ready'
          ? <p className="notice">{bed?.availability === 'unassigned' ? 'Your personal account is ready. A reviewed side assignment is still needed before controls become available.' : bed?.availability === 'configuration_changed' ? 'The current bed arrangement needs review before personal controls can resume.' : 'Personal controls are not enabled on this Pod yet. Your existing operating routines continue.'}</p>
          : (
              <>
                <p>{bed.arrangement === 'solo-anywhere' ? 'One sleeper, both temperature zones. These controls do not identify a person from their body position.' : 'Only your assigned temperature zone is shown here.'}</p>
                <div className="personal-bed" aria-label="Bed zone readings">
                  {bed.zones.map(zone => (
                    <div className="bed-zone" key={zone.side}>
                      <div className="pillow" aria-hidden="true" />
                      <h3>{zone.side === 'left' ? 'Left' : 'Right'}</h3>
                      <strong className="bed-temperature">{format(state.fresh ? zone.measuredTemperatureF : null)}</strong>
                      <span>Measured water temperature</span>
                      <dl>
                        <dt>Controller target</dt>
                        <dd>{format(state.fresh ? zone.reportedTargetF : null)}</dd>
                        <dt>Last requested target</dt>
                        <dd>{format(zone.requestedTargetF)}</dd>
                        <dt>Reported power</dt>
                        <dd>{!state.fresh || zone.reportedPowered === null ? 'Unavailable' : zone.reportedPowered ? 'On' : 'Off'}</dd>
                      </dl>
                    </div>
                  ))}
                </div>
                <p className="small">
                  {state.fresh ? 'Fresh controller reading' : 'Live readings unavailable — showing no cached measurements'}
                  . A reported state does not confirm the bed’s physical response.
                </p>
                {state.fresh && reportedTargets.length > 1 && common === null && <p className="notice">Mixed targets — Left and Right currently report different settings.</p>}
                {state.fresh && (bed.observation.water !== 'ok' || bed.observation.priming !== false) && <p className="notice">{bed.observation.priming ? 'Temperature changes are paused while the Pod is priming.' : bed.observation.water === 'low' ? 'The Pod reports low water. Check the reservoir before changing temperature.' : 'Water or priming status is unavailable. Refresh before changing temperature.'}</p>}
                {state.scopeNeedsReview && (
                  <p className="notice">
                    The bed configuration changed.
                    <button type="button" onClick={() => workspace.reviewScope()}>I reviewed the current zones</button>
                  </p>
                )}
                <form onSubmit={(event) => {
                  event.preventDefault()
                  if (target !== null)
                    void workspace.control({ kind: 'temperature', temperatureF: target, holdMinutes: hold })
                }}
                >
                  <label>
                    New target (°F)
                    <input type="number" min="55" max="110" step="1" required placeholder="Choose a target" value={target === null || Number.isNaN(target) ? '' : target} onChange={event => setTarget(event.target.valueAsNumber)} />
                  </label>
                  <div className="actions">
                    <button type="button" aria-label="Choose one degree cooler" disabled={!workspace.canControl()} onClick={() => setTarget(Math.max(55, starting - 1))}>−1°F</button>
                    <span>{target === null || Number.isNaN(target) ? 'Choose before sending' : format(target)}</span>
                    <button type="button" aria-label="Choose one degree warmer" disabled={!workspace.canControl()} onClick={() => setTarget(Math.min(110, starting + 1))}>+1°F</button>
                  </div>
                  <label>
                    Manual hold
                    <select value={hold} onChange={event => setHold(Number(event.target.value))}>
                      {[30, 60, 120, 360].map(value => (
                        <option key={value} value={value}>
                          {value}
                          {' '}
                          minutes
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primary" type="submit" disabled={!workspace.canControl() || target === null || !Number.isInteger(target) || target < 55 || target > 110}>Apply my target</button>
                  <button type="button" disabled={!workspace.canControl()} onClick={() => void workspace.control({ kind: 'power', powered: true })}>Turn temperature on</button>
                </form>
                <div className="stop-controls">
                  <button type="button" disabled={!workspace.canControl(true) || state.busy.includes('stop-power')} onClick={() => void workspace.control({ kind: 'power', powered: false })}>Stop temperature</button>
                  <button type="button" disabled={!workspace.canControl(true) || state.busy.includes('stop-vibration')} onClick={() => void workspace.control({ kind: 'vibration.clear' })}>Stop vibration</button>
                </div>
                <p className="small">
                  {`Temperature controls: ${bed.routing.temperature.join(' + ')}. Scheduled wake vibration: ${bed.routing.scheduledVibration.join(' + ')} only. A temperature follower does not prove vibration on both sides.`}
                </p>
              </>
            )}
        {!state.storageReady && <p className="small">Checking private request recovery storage. New commands stay unavailable until it is ready.</p>}
      </article>
      {state.references.length > 0 && (
        <article aria-label="Saved request recovery">
          <h2>Check a previous result</h2>
          <p>A lost response can mean a change happened. Check its saved result; this never sends the request again.</p>
          {state.references.map(reference => (
            <div className="item" key={reference.requestId}>
              <strong>
                {reference.kind === 'control' ? 'Bed control' : 'Routine publication'}
                {' '}
                ·
                {' '}
                {reference.requestId.slice(-6)}
              </strong>
              <p>{state.results[reference.requestId]?.state ?? 'Result not yet verified'}</p>
              <button type="button" onClick={() => void workspace.reconcile(reference)}>Check saved result</button>
              <button
                type="button"
                disabled={!workspace.canMarkReviewed(reference)}
                onClick={() => {
                  if (confirm('Have you checked the bed or operating week yourself? Removing this reference does not prove an unknown command failed. It will never resend it.'))
                    void workspace.markReviewed(reference)
                }}
              >
                I checked it myself
              </button>
            </div>
          ))}
        </article>
      )}
      {state.drafts && <RoutineEditor key={`${state.drafts.revision}:${state.draftLoad}`} workspace={workspace} state={state} preferredTemperatureF={preferredTemperatureF} />}
      <ArrangementReviewPanel workspace={workspace} state={state} />
    </div>
  )
}
