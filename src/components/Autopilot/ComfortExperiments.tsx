import { experimentDate } from './experimentPresentation'
import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { ComfortExperimentBrowserWorkspace } from '@/src/comfort/experiments/browserWorkspace'
import type { ExperimentDetail } from '@/src/comfort/experiments/browserContract'
import { dateInTimeZone } from '@/src/lib/timeZoneDate'
import { formatSetpointF } from '@/src/lib/tempUtils'
import { ExperimentNightPlan, ExperimentPlanSummary } from './ExperimentNightPlan'
import { ExperimentFeedbackForm } from './ExperimentFeedbackForm'
import { ExperimentExecution } from './ExperimentExecution'
/** One renderer for the owner and personal account; each receives a separate scoped transport. */
export function ComfortExperiments({ workspace, unit = 'F' }: {
  workspace: ComfortExperimentBrowserWorkspace
  unit?: 'F' | 'C'
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot)
  const title = useId(), reviewRef = useRef<HTMLElement>(null), detailRef = useRef<HTMLElement>(null)
  const proposalRef = useRef<HTMLHeadingElement>(null), wasReviewing = useRef(false)
  const selectedPlanId = state.detail?.record.plan.id
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState !== 'visible')
        workspace.clear()
    }
    const clear = () => workspace.clear()
    const storage = (event: StorageEvent) => {
      if (event.key === 'sleepypod-account-change')
        clear()
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sleepypod-account')
    if (channel)
      channel.onmessage = clear
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', clear)
    window.addEventListener('storage', storage)
    const tick = setInterval(() => workspace.tick(), 1000)
    const check = setInterval(() => {
      if (document.visibilityState === 'visible')
        void workspace.checkAccess()
    }, 15000)
    return () => {
      clearInterval(tick)
      clearInterval(check)
      channel?.close()
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', clear)
      window.removeEventListener('storage', storage)
      workspace.clear()
    }
  }, [workspace])
  useEffect(() => {
    if (state.review)
      reviewRef.current?.focus()
    else if (wasReviewing.current)
      proposalRef.current?.focus()
    wasReviewing.current = Boolean(state.review)
  }, [state.review])
  useEffect(() => {
    if (selectedPlanId)
      detailRef.current?.focus()
  }, [selectedPlanId])
  const format = (value: number) => formatSetpointF(value, unit)
  const context = state.library?.availability.context
  const openPlan = state.library?.experiments.find(record => record.status === 'planned')
  return (
    <section className="comfort-experiments" aria-labelledby={title}>
      <div className="experiment-heading">
        <div>
          <h2 id={title}>Find your comfortable setting</h2>
          <p>Compare two nearby temperatures across your scheduled nights.</p>
        </div>
        <button type="button" disabled={state.busy} onClick={() => void workspace.open()}>
          {state.busy ? 'Checking comparison…' : state.library || state.detail ? 'Refresh comparisons' : 'Open my comparisons'}
        </button>
      </div>
      {!state.detail && <p className="experiment-notice">Saving a plan does not change the bed. Overnight control needs a separate review; your wake plan stays the same.</p>}
      {state.error && <p className="experiment-notice" role="alert">{state.error}</p>}
      {state.message && <p className="experiment-notice" role="status">{state.message}</p>}
      {state.busy && <p role="status">Checking your account and the saved result…</p>}
      {state.uncertain && <button type="button" disabled={state.busy} onClick={() => void workspace.reconcile()}>Check saved result</button>}
      {state.library && !state.review && !state.detail && !state.uncertain && (
        <>
          {!context && <p>{state.library.availability.reason}</p>}
          {context && !openPlan && (<ExperimentProposal focusRef={proposalRef} draft={state.draft} key={JSON.stringify(context)} baselineF={context.baselineF} minimumF={context.minimumF} maximumF={context.maximumF} today={dateInTimeZone(state.now, context.timezone)} timezone={context.timezone} format={format} busy={state.busy} preview={(date, target) => void workspace.preview(date, target)} />)}
          {openPlan && <p>You already have a saved comparison. Open it to review its nights, add feedback or stop it before planning another.</p>}
          {state.library.experiments.length === 0 && <p className="experiment-muted">No saved comparisons yet. A preview shows every eligible night before you save.</p>}
          {state.library.experiments.length > 0 && (
            <ul className="experiment-library" aria-label="Saved comparisons">
              {state.library.experiments.map(item => (
                <li key={item.id}>
                  <div>
                    <strong>
                      {format(item.baselineF)}
                      {' '}
                      and
                      {' '}
                      {format(item.variantF)}
                    </strong>
                    <p>
                      {experimentDate(item.firstNightDate)}
                      {' '}
                      ·
                      {' '}
                      {item.status === 'stopped' ? 'Stopped' : 'Saved plan'}
                    </p>
                    {!item.contextCurrent && <p>Routine or assignment changed since this plan was saved.</p>}
                  </div>
                  <button type="button" disabled={state.busy} onClick={() => void workspace.select(item.id)} aria-label={`Open comparison starting ${experimentDate(item.firstNightDate)}`}>Open comparison</button>
                </li>
              ))}
            </ul>
          )}
          {state.library.nextId && <button type="button" disabled={state.busy} onClick={() => void workspace.older()}>Older comparisons</button>}
        </>
      )}
      {state.review && (
        <section ref={reviewRef} tabIndex={-1} aria-label="Review comparison" className="experiment-reading">
          <h3>Review your nights</h3>
          <p>Each setting gets a settling night followed by a comparison night. The order is balanced and randomized across four pairs.</p>
          <ExperimentPlanSummary plan={state.review.plan} format={format} />
          <details>
            <summary>Review all 16 nights</summary>
            <ExperimentNightPlan plan={state.review.plan} format={format} />
          </details>
          <p className="experiment-muted">
            This review expires in
            {' '}
            {Math.max(1, Math.ceil((state.review.expiresAt - state.now) / 60000))}
            {' '}
            minutes. Changes to your routine require a new preview.
          </p>
          <div className="experiment-actions">
            <button type="button" className="experiment-primary" disabled={state.busy || state.now >= state.review.expiresAt} onClick={() => void workspace.confirm()}>Save comparison plan</button>
            <button type="button" disabled={state.busy} onClick={() => workspace.discardReview()}>Back to settings</button>
          </div>
        </section>
      )}
      {state.detail && (
        <section ref={detailRef} tabIndex={-1} aria-label="Saved comparison" className="experiment-reading">
          <div className="experiment-heading">
            <div>
              <h3>{state.detail.record.status === 'stopped' ? state.execution?.state === 'admitted' ? 'Finish stopping this comparison' : 'Comparison stopped' : 'Your saved comparison'}</h3>
              <p>
                {format(state.detail.record.plan.context.baselineF)}
                {' '}
                and
                {' '}
                {format(state.detail.record.plan.variantF)}
              </p>
            </div>
            {(state.detail.record.status !== 'stopped' || state.execution?.state === 'admitted') && <button type="button" disabled={state.busy} onClick={() => void workspace.stop()}>{state.detail.record.status === 'stopped' ? 'Finish stopping control' : 'Stop comparison'}</button>}
          </div>
          {!state.detail.contextCurrent && <p className="experiment-notice">Your routine or assignment has changed. This saved plan cannot authorize further adjustments. You can still read its record or stop it.</p>}
          <ExperimentExecution state={state} workspace={workspace} format={format} />
          <ExperimentResult detail={state.detail} />
          <details>
            <summary>See planned nights and wake boundaries</summary>
            <ExperimentNightPlan plan={state.detail.record.plan} format={format} />
          </details>
          <ExperimentFeedbackForm key={state.detail.record.revision} detail={state.detail} now={state.now} busy={state.busy} save={value => void workspace.feedback(value)} />
        </section>
      )}
    </section>
  )
}
function ExperimentProposal({ baselineF, minimumF, maximumF, today, timezone, format, busy, preview, draft, focusRef }: {
  focusRef: RefObject<HTMLHeadingElement | null>
  draft: { firstNightDate: string, variantF: number } | null
  baselineF: number
  minimumF: number
  maximumF: number
  today: string
  timezone: string
  format: (value: number) => string
  busy: boolean
  preview(date: string, target: number): void
}) {
  const dateId = useId(), targetId = useId()
  const targets = [-2, -1, 1, 2].map(offset => baselineF + offset).filter(value => value >= minimumF && value <= maximumF)
  const [date, setDate] = useState(draft?.firstNightDate ?? today), [target, setTarget] = useState(draft ? String(draft.variantF) : '')
  const maximumDate = new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10)
  return (
    <form
      className="experiment-proposal"
      onSubmit={(event) => {
        event.preventDefault()
        if (target)
          preview(date, Number(target))
      }}
    >
      <h3 ref={focusRef} tabIndex={-1}>A small change, within your comfort range</h3>
      <p>
        Your scheduled setting is
        {' '}
        <strong>{format(baselineF)}</strong>
        . Your overnight range is
        {' '}
        {format(minimumF)}
        –
        {format(maximumF)}
        ; wake warming stays separate.
      </p>
      <div className="experiment-fields">
        <label htmlFor={targetId}>
          Nearby setting
          <select id={targetId} required value={target} disabled={busy} onChange={event => setTarget(event.target.value)}>
            <option value="">Choose a setting</option>
            {targets.map(value => (
              <option key={value} value={value}>
                {format(value)}
                {' '}
                ·
                {' '}
                {value < baselineF ? 'cooler' : 'warmer'}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={dateId}>
          Start no earlier than
          <input id={dateId} type="date" required min={today} max={maximumDate} value={date} disabled={busy} onChange={event => setDate(event.target.value)} />
        </label>
      </div>
      <p className="experiment-muted">
        Dates follow
        {' '}
        {timezone}
        . We look for 16 eligible scheduled nights; skipped dates will be explained in the preview.
      </p>
      <button type="submit" className="experiment-primary" disabled={busy || !target}>Preview comparison nights</button>
    </form>
  )
}
function ExperimentResult({ detail }: {
  detail: ExperimentDetail
}) {
  const result = detail.comparison
  const titles = { inconclusive: 'More evidence needed', keep_baseline: 'Keep your current setting', consider_variant: 'A nearby setting to consider' }
  return (
    <div className="experiment-result">
      <h4>{titles[result.recommendation]}</h4>
      <p>{result.reason}</p>
      <p className="experiment-muted">
        {result.pairedDifferences.length}
        {' '}
        of 4 complete pairs ·
        {' '}
        {detail.record.feedback.length}
        {' '}
        of 16 morning check-ins
      </p>
      <p className="experiment-muted">This compares your reported comfort. It does not establish better sleep or change your routine automatically.</p>
    </div>
  )
}
