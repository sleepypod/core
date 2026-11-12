# Comfort experiment execution controls

Mode: Operate. Extend the existing owner/personal comparison surface and its
light/dark tokens, typography, buttons and disclosure controls. Keep the native
version's meaning and sequence aligned with the browser version.

## Existing visual evidence

The retained phone screenshot `experiment-saved-390.png` in the browser test output
matches the current `ComfortExperiments.tsx` and `comfort-experiments.css`: the
saved comparison has a temperature summary, Stop, result, planned-night disclosure
and morning feedback. Its large-text rendering is legible but gives substantial
space to the old planning-only notice. Replace that notice with current execution
state and a concise next action; do not create a new visual identity.

## Task and hierarchy

1. See the two nearby settings and preserved wake plan.
2. Save the comparison without changing the bed.
3. Review the separately qualified overnight control, including affected halves,
   scheduled nights and the one-minute confirmation expiry.
4. Explicitly allow it to run. Show the saved admission as scheduled authority,
   never as proof that a temperature was physically delivered.
5. Stop the comparison in one clearly named flow. Close the plan before cancelling
   retained authority so a second device cannot authorize it during cancellation.
   If closure succeeds but cancellation is uncertain, show those outcomes
   separately and reconcile by reading before another change.
6. Read back after a disconnected or lost response. Never resend an actuator or
   automatically resubmit confirmation.

The execution section sits after the saved temperature summary and before the
result. Use a primary review/confirm action and an immediately visible Stop while
admitted. Use an inline review rather than a new modal. Keep detailed planned
nights and per-zone command history in disclosures. Restore focus after review
expiry or cancellation without jumping away during periodic refresh.

## States

- Saved only: explain that the normal routine continues; offer a control review.
- Review unavailable: show a useful qualification/readiness message and preserve
  read-only plan, feedback and Stop access.
- Review ready: affected halves, exact temperatures and wake boundary, expiry,
  confirm and back actions. Reject expiry locally and on the server.
- Admitted: show scheduled comparison, original wake boundary and controller
  availability. Sensor gaps or mere acknowledgment do not become physical proof.
- Stopped/ended: preserve results and feedback. A new comparison requires its own
  plan and reviewed admission where the original start is already in the past.
- Uncertain result: hide stale controls, offer read-back, show what is confirmed
  and what remains unknown. Account changes clear private content.
- Uncertain firmware attempt: clearly separate a server readback from retrying
  the command. Explicit recovery ends the old admission and requires a new review.

## Acceptance

Use the authenticated execution endpoints, the shared public contract and strict
owner/personal transport allowlists. Preserve account, scope, response-time and
visibility checks. Test saved-plan-only behavior, admission, expiry, lost replies,
Stop, recovery, revoked access and account switching with real services and fake
firmware. Inspect rendered light/dark phone and tablet screens, large text,
keyboard focus and reduced motion. Reuse the existing visual language and run the
Impeccable detector once after UI edits are complete. These checks do not qualify
physical movement, real overnight treatment or improved sleep.
