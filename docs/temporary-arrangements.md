# Temporary guest and side-swap preparation

This is a **private review API and browser workspace**, disabled by default. It does not activate a guest,
change sides, replace a routine, alter personal records, or send hardware commands.
The activation/return coordinator and native app integration remain separate
implementation work. Do not present a saved approval as a changed bed arrangement.

## Behavior

- In an already assigned household, a swap carries each person's actual operating
  week to the proposed opposite side. Private, unpublished drafts are left alone.
- A guest proposal keeps the owner on their selected physical side. An assigned
  partner also reviews their temporary absence and can see their preserved original
  week. An invited but unassigned account is not treated as a sleeper or reviewer.
- A guest has no invented personal account. The proposed policy withholds personal
  recording attribution for the guest interval. Learning and shared effects would
  stay paused until a separately reviewed return; this API does not apply that policy.
- Every response includes only the authenticated person's private preferences and
  routine. Shared information is limited to the other participant's display name,
  proposed side and approval state.
- Each participant approves using their own authenticated device. Revoking that
  device, changing source data or revising settings invalidates the approval.
- Review validity is at most one hour; the proposed temporary interval is at most
  72 hours. Expiry never switches sides or restores routines automatically.

## Private API

Set `SLEEPYPOD_TEMPORARY_ARRANGEMENT_REVIEW=1` only when intentionally enabling
preparation, alongside the existing household preparation configuration.
`temporaryArrangementReview` reports availability; `activateTemporaryArrangement`
is always false. Existing accounts and personal browser protections apply.

| Method | Path after `/api/v1/household` | Result |
| --- | --- | --- |
| GET | `/temporary-arrangement` | Most recent review for this participant, or null |
| POST | `/temporary-arrangement` | Owner prepares a guest or side-swap review |
| GET | `/temporary-arrangement/:id` | This participant's private projection |
| POST | `/temporary-arrangement/approve` | Save the current account's approval |
| POST | `/temporary-arrangement/cancel` | Either participant cancels an inert review |

There is deliberately no activation endpoint. The current remote ingress also
withholds arrangement maintenance routes. No owner key can substitute for a
personal credential on these endpoints.

The server reads current physical configuration, operating routine revisions,
preferences, policy and the verified biometric dataset/attribution epoch inside
the review transaction. It does not accept a client-supplied source snapshot.
Unreadable current sources withdraw approval while preserving cancellation of an
existing inert review. No historical record is reassigned during preparation.

## Browser review

The personal household workspace offers an explicit check before showing a plan.
Owners can prepare a guest interval or, in an assigned household, a temporary side
swap. Each participant sees their own operating week, required acknowledgments and
the other participant's approval state. Partner schedules stay private.

After 30 seconds, or when a read fails, the dated plan remains available for
reference but approval and preparation require a fresh check. Draft choices remain
visible. A lost write reply shows a read-only recovery action; it never repeats the
write automatically. Changing accounts or hiding the page clears private content.
Nothing is saved in browser storage. An expired or changed plan can be cancelled
before preparing a replacement, but it can never activate the bed.

## Remaining activation requirements

The internal `returnPlan.ts` planner defines the return review independently of
activation. Given a verified committed interval and a server-read current source,
it maps each resident's **current** operating week back to their original side. An
absent partner retains their preserved original week; guest-zone settings are not
substituted for that person's routine. Current personal preferences are retained.
Every participant reviews their own result without seeing the other person's
routine, and changes to the source invalidate the review.

The intended end is a reminder to review, not authority to switch back. The return
planner works before or after that date, keeps learning paused for separate
qualification and preserves each person's quiet request. It requires a new
recording epoch after the eventual return. This planner is not registered on HTTP
and cannot establish that a physical transition happened. Durable interval storage,
the current-source adapter, return approvals and the coordinator below are still
required before exposing a return action.

An implementation must preserve the existing transition coordinator's producer
drain, hardware admission hold, attended empty-bed evidence, immutable archives,
atomic routine/identity/history change and restart recovery. It must also add:

1. A durable temporary-interval identity and original-arrangement archive.
2. Guest recording suppression and separate reviewed attribution at entry/return.
3. Revision invalidation across app, Watch, MQTT/HomeKit, timers and offline caches.
4. A reviewed return that preserves intervening edits; no timer-only restoration.
5. Failure/restart testing at each transition boundary and actual two-account
   device checks before physical activation.

`approvedForCommit` and `consumeForCommit` are internal transaction boundaries for
that future coordinator. They cannot be called outside a configuration transaction
and do not themselves perform a transition.

## Validation

Run `pnpm exec vitest run src/household/temporary/tests --project unit` for migrated
SQLite, private source, independent approval, replay, cancellation, revocation,
expiry, rollback and authenticated HTTP cases. Tests use isolated synthetic
households and recordings, never a connected Pod or real Health data.

`src/household/web/tests/temporary.test.ts` covers transport scope, privacy, freshness,
uncertain writes and read recovery. `tests/browser/personal-temporary.e2e.ts` covers
the visible review and recovery flows on phone, tablet and desktop sizes with
keyboard, large text and light/dark appearances. The UI uses synthetic fixtures;
these checks are not physical or two-device activation evidence.
