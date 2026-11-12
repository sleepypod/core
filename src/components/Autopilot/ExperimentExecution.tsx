import { useEffect, useRef } from 'react'
import type { ExperimentBrowserState, ComfortExperimentBrowserWorkspace } from '@/src/comfort/experiments/browserWorkspace'
import { ExperimentPlanSummary } from './ExperimentNightPlan'

/** Saving a plan, permitting its control and observing a result are distinct states. */
export function ExperimentExecution({ state, workspace, format }: {
  state: ExperimentBrowserState
  workspace: ComfortExperimentBrowserWorkspace
  format(value: number): string
}) {
  const reviewRef = useRef<HTMLElement>(null), titleRef = useRef<HTMLHeadingElement>(null)
  const wasReviewing = useRef(false), reviewId = state.execution?.review?.id
  useEffect(() => {
    if (reviewId) reviewRef.current?.focus()
    else if (wasReviewing.current) titleRef.current?.focus()
    wasReviewing.current = Boolean(reviewId)
  }, [reviewId])
  const { detail, execution, busy, now } = state
  if (!detail) return null
  const plan = detail.record.plan
  const time = (instant: number) => new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: plan.context.timezone,
  }).format(instant)
  const sides = (values: ('left' | 'right')[]) => values.length === 2 ? 'Left and Right halves' : `${values[0] === 'left' ? 'Left' : 'Right'} half`
  const stale = !execution || execution.generatedAt < now - 120000 || execution.generatedAt > now + 60000
  const review = execution?.review
  const admitted = execution?.state === 'admitted'
  const closureIncomplete = detail.record.status === 'stopped' && admitted
  const mayReview = detail.record.status === 'planned' && detail.contextCurrent && !admitted && plan.version === 2
    && now < plan.schedule.windows[0].windowStart
  const titles = { not_admitted: 'Saved, not running', admitted: 'Scheduled to compare', revoked: 'Overnight control ended', ended: 'Comparison nights finished' }
  return (
    <div className="experiment-execution">
      <h4 ref={titleRef} tabIndex={-1}>{closureIncomplete ? 'Control cancellation needs checking' : execution ? titles[execution.state] : 'Overnight comparison control'}</h4>
      {!state.executionAvailable
        ? <p>This connection supports saving and reviewing plans. Overnight comparison control is unavailable.</p>
        : !execution
            ? <p>Refresh this comparison to check its current control status.</p>
            : (
                <>
                  {execution.state === 'not_admitted' && <p>Your usual routine continues. Review overnight control separately before allowing this comparison to change temperatures.</p>}
                  {closureIncomplete && <p className="experiment-notice">The plan is closed, but cancellation of its retained control permission is not yet confirmed. Use “Finish stopping control” above.</p>}
                  {admitted && !closureIncomplete && execution.admission && (
                    <>
                      <p>
                        Allowed on the
                        {' '}
                        <strong>{sides(execution.admission.sides)}</strong>
                        {' '}
                        during the saved night windows, through
                        {' '}
                        {time(execution.admission.endsAt)}
                        .
                      </p>
                      <p>Wake warming stays on its existing schedule. Manual changes and protection checks can interrupt the comparison.</p>
                    </>
                  )}
                  {execution.state === 'revoked' && <p>Permission for further experiment adjustments has ended. Your saved check-ins and recordings remain available.</p>}
                  {execution.state === 'ended' && <p>The authorized night windows have ended. Add your remaining morning check-ins to review the comparison.</p>}
                  {!execution.controllerRunning && <p className="experiment-notice">The experiment controller is unavailable. This saved permission does not establish that any adjustment is running.</p>}
                  {stale && <p className="experiment-notice" role="status">Control status needs refreshing. New confirmation is unavailable until it is checked again.</p>}
                  <p className="experiment-muted">
                    Last checked
                    {' '}
                    {time(execution.generatedAt)}
                    {' '}
                    ·
                    {' '}
                    {plan.context.timezone}
                    . A command acknowledgment does not confirm the temperature you felt.
                  </p>
                  {mayReview && !review && (
                    <>
                      <p className="experiment-muted">An attended control check and seven reviewed Preview nights are required before temperature changes can be allowed.</p>
                      <button type="button" className="experiment-primary" disabled={busy || stale || !execution.controllerRunning} onClick={() => void workspace.reviewExecution()}>Review overnight control</button>
                    </>
                  )}
                  {!mayReview && !admitted && detail.record.status === 'planned' && <p>To try another comparison, stop this saved plan and preview new nights.</p>}
                  {review && (
                    <section ref={reviewRef} tabIndex={-1} aria-label="Review overnight control" className="experiment-control-review">
                      <h4>Allow these scheduled temperatures?</h4>
                      <p>
                        The Pod checked its qualification and reviewed nights. This allows temperature requests on the
                        {' '}
                        <strong>{sides(review.sides)}</strong>
                        .
                      </p>
                      <ExperimentPlanSummary plan={plan} format={format} />
                      <p>Allowing this comparison pauses ordinary personal adaptation. You can stop it at any time; a manual temperature change interrupts its control.</p>
                      <p className="experiment-muted">
                        This control review expires in
                        {' '}
                        {Math.max(0, Math.ceil((review.expiresAt - now) / 1000))}
                        {' '}
                        seconds.
                      </p>
                      <div className="experiment-actions">
                        <button type="button" className="experiment-primary" disabled={busy || stale || now >= review.expiresAt || !execution.controllerRunning} onClick={() => void workspace.confirmExecution()}>Allow scheduled comparison</button>
                        <button type="button" disabled={busy} onClick={() => workspace.discardExecutionReview()}>Keep plan only</button>
                      </div>
                    </section>
                  )}
                  {execution.applications.filter(application => application.outcome === 'unknown' || application.outcome === 'attempting').map(application => (
                    <div key={application.id} className="experiment-control-review">
                      <h4>
                        {application.side === 'left' ? 'Left' : 'Right'}
                        {' '}
                        command needs checking
                      </h4>
                      <p>
                        The request for
                        {' '}
                        {format(application.requestedTargetF)}
                        {' '}
                        has no confirmed outcome. Check the Pod’s fresh reported target and end this control authorization. This does not repeat the temperature command.
                      </p>
                      <button type="button" disabled={busy || stale} onClick={() => void workspace.recoverExecution(application.id)}>
                        Check
                        {' '}
                        {application.side === 'left' ? 'Left' : 'Right'}
                        {' '}
                        target and end control
                      </button>
                    </div>
                  ))}
                  {execution.applications.length > 0 && (
                    <details>
                      <summary>Latest control receipts</summary>
                      <ul className="experiment-observations">
                        {execution.applications.map(application => (
                          <li key={application.id}>
                            <strong>
                              {application.side === 'left' ? 'Left' : 'Right'}
                              {' '}
                              ·
                              {' '}
                              {format(application.requestedTargetF)}
                              {' '}
                              requested
                            </strong>
                            <p>{time(application.attemptedAt)}</p>
                            <p>
                              {application.outcome === 'acknowledged'
                                ? 'Pod acknowledged the request; physical result not verified.'
                                : application.resolution
                                  ? `Later firmware target: ${format(application.resolution.targetF)} at ${time(application.resolution.observedAt)}. The original outcome remains unconfirmed.`
                                  : 'Command outcome unconfirmed.'}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
    </div>
  )
}
