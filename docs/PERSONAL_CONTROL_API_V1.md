# Personal bed and control API v1

The request/response shapes below are implemented and covered by database and
HTTP tests. They are additive to the household preparation contract. They are
**not deployed or enabled** on the owner's Pod. Full two-person operation also
needs the reviewed assignment coordinator, private history/Health integration,
legacy owner access restrictions, shared telemetry consent and both clients.
The assigned household in the tests is seeded data, not an activation workflow.

Both `SLEEPYPOD_HOUSEHOLD_PREPARATION=1` and `SLEEPYPOD_PERSONAL_RUNTIME=1` are
required for live personal commands. Both default off. Do not enable these flags
as a substitute for finishing and reviewing the household release gates.
Preparation draft writes remain inert; this change does not publish a schedule,
change assignments, start an alarm or grant access to a partner's Health data.

## Transport

All requests use the personal device credential established by preparation v1.
Never use the existing owner key as fallback. Native uses `Authorization: Bearer`;
the browser uses its signed HttpOnly personal session and persisted browser scope.
Browser writes also require same-origin headers and `X-Sleepypod-Sleeper-Id`.
Clients should send that sleeper header on reads too. Browser account switching
uses the existing `X-Sleepypod-Browser-Revision` compare-and-swap mechanism.

Every response uses `Cache-Control: private, no-store` and
`Vary: Authorization, Cookie`. Errors use `householdErrorSchema`.

| Route | Method | Contract |
|---|---|---|
| `/api/v1/household/session` | GET | Existing session; `capabilities.personalControls` reflects the current runtime and arrangement |
| `/api/v1/me/bed` | GET | `personalBedSchema` |
| `/api/v1/me/controls` | POST | `personalControlRequestSchema` → `personalControlReceiptSchema` |
| `/api/v1/me/controls/{requestId}` | GET | Own `personalControlReceiptSchema`, or indistinguishable 404 for absent/another person's receipt |

Schemas: `src/household/bedContract.ts`, `controlContract.ts` and `contract.ts`.
Frozen synthetic fixtures: `src/household/fixtures/personal-controls-v1.json`.
No fixture contains a usable connection key or real sleeper data.

## Bed reading and per-action routing

The response pins `podId`, `householdId`, `sleeperId`, `sessionRevision`,
`assignmentRevision` and the opaque `configurationRevision`. The server derives
these and the allowed zones from the current database. A display name or selected
side never establishes identity. The revision also changes when the physical
arrangement, timezone or away modes change.

`availability` is `ready`, `unassigned`, `configuration_changed` or
`runtime_disabled`. Only `ready` authorizes a new command. Other states return no
zone measurements or routing authority and do not poll the hardware.

`routing` deliberately separates temperature, power, vibration cancellation,
scheduled vibration and the source routine. A verified solo/follow configuration
allows temperature and power across both zones. Its scheduled vibration still
targets only the source routine's zone; thermal following is not evidence that
the other side vibrates. An assigned person has only their own zone. These fields
describe routing, not a physical qualification or an alarm-edit capability.

`observation.state=fresh` requires a timestamp less than 15 seconds old and not
in the future. Unavailable/stale readings use null temperatures/power/priming and
unknown water status; they do not become zero, off or the last cached value.
The per-zone `measuredTemperatureF`, `reportedTargetF` and `requestedTargetF` are
distinct. A requested target may exist without a current hardware observation.
`reportedPowered` is null when the status cannot establish power state.
`physicalVerification` is always `unverified` for a network response.

The response is explicitly constructed from permitted fields. It includes no
raw diagnostics, other-side readings, vitals, gestures, sleep history or account
roster. Device revocation, account switch and configuration changes during an
asynchronous read invalidate that read before it can be returned.

## Commands and durable reconciliation

The client persists the exact request before sending it. A request has a random
UUID, the complete last reviewed scope, `issuedAt`, `expiresAt` and one action:

- `temperature`: integer `temperatureF` 55–110 and `holdMinutes` 1–1440.
- `power`: `powered` plus optional integer `temperatureF` 55–110.
- `vibration.clear`: cancellation only.

There is no caller-supplied physical side. Base motion, vibration playback,
snooze and routine publication are not part of this contract. Manual control
ranges are not permission to bypass the narrower adaptive-comfort policy.

The validity window must be positive and at most 60 seconds. Delayed or future
commands fail without a write. Scope and credentials are rechecked at each zone
and every hardware FIFO write. An account switch while a command is queued cannot
carry the old authority into another person's zone. The service also checks the
browser binding and device authorization before returning a private receipt.

Receipts retain the original `scope`, action and `resolvedZones`. Outcomes:

| State | Interpretation |
|---|---|
| `executing` | Claimed by this live process; still awaiting an outcome |
| `acknowledged` | The transport acknowledged the dispatched operation on every resolved zone; physical effect remains unverified |
| `not_dispatched` | No hardware write, including a superseded/debounced request |
| `rejected` / `expired` | Refused before a hardware write |
| `unknown` | Some write may have occurred or the process was interrupted; inspect/reconcile before a new action |

`dispatchCount` counts actual transport writes, not the number of zones. Each
zone can require several writes. If one solo zone was superseded without writing
but the other wrote, the result is `unknown`, not whole-bed acknowledgment.

After a lost response, GET the same request ID with the same personal account.
An exact duplicate POST also returns the historical receipt without dispatching.
Changing the payload under an existing ID returns 409. Every receipt has
`replayAllowed=false`; reconnecting, rebooting or moving sides never replays it.
Unknown is not a reason to issue a fresh UUID automatically.

Another account cannot retrieve the receipt, even if it knows the UUID. A later
side move permits the original author to inspect their old receipt but does not
apply it to their new side. No old-side Shortcut is silently redirected.

## Client integration requirements

Pin each asynchronous response to the connection, full person scope and local
workspace generation. Discard a result after logout, account change, side move
or a newer view request. Isolate pending requests and caches by Pod, household
and sleeper. The native parent workspace remains the sole Keychain-vault writer;
children receive scoped storage callbacks, not a second vault writer.

Do not adapt this private DTO into the existing owner-wide device manager or
WebSocket stream. Use a dedicated personal transport/view and the extracted pure
temperature presentation. Refresh session plus bed scope before a new command;
return explicit reconnection/review UI on 401/403/409. Hide controls while capability
is false, preserve unknown outcomes visibly, and keep Stop accessible when current
authority allows it. Weekly schedule drafts still say **draft only**. Publishing
them requires the separately gated [routine publication contract](PERSONAL_ROUTINE_API_V1.md).

## Atomic routine storage prerequisite

`replaceBedtimeRoutineBatch` reuses the existing routine normalization, compiled
row ownership and revision checks in one SQLite transaction across both sides.
It can nest in a future reviewed assignment transaction. A stale second side,
failed insert or outer rollback cannot leave the first side partly moved.
Scheduler refresh follows commit and has a separate acknowledgment. This is a
storage primitive; it does not by itself perform an assignment transition, revoke
leases/snoozes or publish a person's draft.
