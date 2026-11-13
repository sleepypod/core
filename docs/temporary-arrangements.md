# Temporary guest and side-swap preparation

This is a **private review API**, disabled by default. It does not activate a guest,
change sides, replace a routine, alter personal records, or send hardware commands.
The activation/return coordinator and app screens remain separate implementation
work. Do not present a saved approval as a changed bed arrangement.

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

## Remaining activation requirements

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
