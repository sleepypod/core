import { useState, useSyncExternalStore } from 'react'
import type { ArrangementReview } from '../arrangementContract'
import type { HouseholdMaintenanceWorkspace } from './maintenance'

type Confirmations = ReadonlyArray<readonly [string, string]>
const emptyBed = ['confirmEmptyAndAttended', 'The bed is empty, the cover is connected, the reservoir is filled, and I am beside the bed.'] as const

/** Each step starts with unchecked confirmations, including after a background or refreshed observation. */
function AttendedStep({ title, action, confirmations, submit, disabled }: {
  title: string
  action: string
  confirmations: Confirmations
  submit: (values: Record<string, boolean>) => void
  disabled: boolean
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      if (!disabled && confirmations.every(([field]) => checked[field])) submit(checked)
    }}
    >
      <fieldset disabled={disabled}>
        <legend>{title}</legend>
        {confirmations.map(([field, label]) => (
          <label className="check" key={field}>
            <input type="checkbox" checked={checked[field] ?? false} onChange={event => setChecked(value => ({ ...value, [field]: event.target.checked }))} />
            {label}
          </label>
        ))}
        <button type="submit" className="primary" disabled={disabled || !confirmations.every(([field]) => checked[field])}>{action}</button>
      </fieldset>
    </form>
  )
}

export function ArrangementMaintenancePanel({ workspace, review, standalone = false }: {
  workspace: HouseholdMaintenanceWorkspace
  review?: ArrangementReview | null
  standalone?: boolean
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot)
  const operation = state.loaded ? state.status?.operation : null
  const pending = operation && ['held', 'committed'].includes(operation.state)
  const held = operation?.admission === 'held_for_this_transition'
  const freshKey = `${state.status?.observedAt}:${operation?.state}:${operation?.controllerRestarted}:${state.cancellation?.observedAt}`
  const activationReady = state.loaded && !operation && state.canActivate && review?.canActivate && review.state === 'approved_for_separate_activation'
  const title = !state.loaded
    ? 'Check your side change'
    : !operation
        ? 'Switch to your reviewed sides'
        : operation.state === 'completed'
          ? 'Your assigned sides are saved'
          : operation.state === 'cancelled' ? 'Your solo arrangement is kept' : 'Finish your side change'
  return (
    <article className="arrangement-maintenance" aria-label="Side change maintenance">
      <h2 tabIndex={-1}>{title}</h2>
      {state.error && <p role="alert" className="maintenance-result">{state.error}</p>}
      {state.message && <p role="status" className="maintenance-result">{state.message}</p>}
      <p>
        {state.entered
          ? 'Bed controls and personal editors stay closed here until the saved transition is checked and completed.'
          : 'Before changing sides, check whether this connection has an unfinished transition. Checking never repeats an action.'}
      </p>
      <button type="button" disabled={state.busy} onClick={() => void workspace.refresh()}>{state.busy ? 'Checking or saving…' : 'Check saved transition'}</button>
      {!state.loaded && <p>Reconnect if needed, then check again. A missing response does not mean an action failed.</p>}
      {state.loaded && state.status && <p className="small">{`Checked ${new Date(state.status.observedAt).toLocaleString()}. Each next step checks the controller again.`}</p>}
      {state.loaded && !operation && !activationReady && (
        <p>
          {state.entered
            ? 'No saved receipt was found for this attempt. Its outcome is still uncertain. Check again; do not repeat the side change.'
            : 'No unfinished side change was found. Both people must approve their sides and routines, and this Pod must support activation, before switching becomes available.'}
        </p>
      )}
      {activationReady && review && (
        <div key={`activation:${freshKey}:${review.reviewId}`}>
          <p>{`Your reviewed side: ${review.self.proposedSide}. Your partner’s reviewed side: ${review.partner.proposedSide}.`}</p>
          <p>Starting pauses automatic services and clears temporary actions. A controller restart and a separate recovery check follow before either person uses the bed.</p>
          <AttendedStep
            title="Before starting"
            action="Start reviewed side change"
            disabled={state.busy}
            confirmations={[
              emptyBed,
              ['confirmClearTemporaryActions', 'Clear the current temporary controls and overrides.'],
              ['confirmPauseLearningAndSharedAutomations', 'Pause personal learning and shared automations during the change.'],
              ['acknowledgeHeldUntilRecovery', 'Keep bed commands paused until I finish restart and recovery.'],
            ]}
            submit={values => void workspace.activate(review, values as Parameters<typeof workspace.activate>[1])}
          />
        </div>
      )}
      {pending && (
        <div key={freshKey}>
          <p>
            {operation.state === 'committed'
              ? 'The side assignment is saved. The controller must load it before routine services can resume.'
              : 'The change paused before new sides were saved. After a verified restart, you can keep the current solo arrangement.'}
          </p>
          {!held && <p role="alert">The controller’s pause could not be verified for this transition. Check controller status before continuing.</p>}
          {held && operation.controllerRestarted === null && <p>The controller’s restart state is unavailable. Check again when the Pod is reachable; no restart will be repeated automatically.</p>}
          {held && operation.controllerRestarted === false && operation.restart === null && (
            <AttendedStep
              title="Restart the controller"
              action="Request controller restart"
              disabled={state.busy}
              confirmations={[
                emptyBed,
                ['acknowledgeConnectionWillClose', 'The connection may close while the controller restarts.'],
                ['acknowledgeControlsRemainPaused', 'Bed commands stay paused until the next attended check.'],
              ]}
              submit={values => void workspace.restart(values as Parameters<typeof workspace.restart>[0])}
            />
          )}
          {held && operation.controllerRestarted === false && operation.restart !== null && (
            <p>A restart request is already saved. Check again after the controller reconnects. If it remains unchanged, use controller diagnostics; this page will not submit another restart.</p>
          )}
          {held && operation.controllerRestarted === true && operation.state === 'committed' && (
            <AttendedStep
              title="Resume the reviewed arrangement"
              action="Finish recovery"
              disabled={state.busy}
              confirmations={[
                emptyBed,
                ['confirmAssignedSides', 'Both people have reviewed their assigned sides. Saved routines may resume.'],
                ['acknowledgeRecordingGap', 'The change creates a recording gap; it is not counted as sleep.'],
                ['acknowledgeLearningRemainsOff', 'Personal learning stays off until separately reviewed.'],
              ]}
              submit={values => void workspace.recover(values as Parameters<typeof workspace.recover>[0])}
            />
          )}
          {held && operation.controllerRestarted === true && operation.state === 'held' && (
            <>
              {!state.cancellation && <button type="button" disabled={state.busy} onClick={() => void workspace.previewCancellation()}>Review keeping solo arrangement</button>}
              {state.cancellation && (
                <AttendedStep
                  title="Keep the existing solo arrangement"
                  action="Keep solo and release pause"
                  disabled={state.busy}
                  confirmations={[
                    emptyBed,
                    ['confirmKeepSoloArrangement', 'Keep the existing solo arrangement and its saved control settings.'],
                    ['acknowledgeSavedRoutinesMayResume', 'Saved routines may resume when the pause is released.'],
                  ]}
                  submit={values => void workspace.cancel(values as Parameters<typeof workspace.cancel>[0])}
                />
              )}
            </>
          )}
        </div>
      )}
      {state.loaded && operation && ['completed', 'cancelled'].includes(operation.state) && (
        <p>The transition receipt is saved. It does not confirm physical heating, vibration or movement. Check the controller and the bed before ordinary use.</p>
      )}
      {standalone && state.loaded && operation && ['completed', 'cancelled'].includes(operation.state) && operation.admission === 'open' && (
        <button type="button" className="primary" disabled={state.busy} onClick={() => void workspace.returnToControls()}>Return to my controls</button>
      )}
    </article>
  )
}
