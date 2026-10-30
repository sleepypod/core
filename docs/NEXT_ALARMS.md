# One-occurrence wake changes

The Temp Cards view now separates **Skip this alarm**, **Change this time** and **Restore routine
alarm** from **Weekly schedule**. The first three actions persist a temporary
change on the Pod without rewriting weekly alarm rows or bedtime routines.
Saved alarms remain accessible while live hardware status reconnects.
The same API is available to independently implemented native clients.

## Contract

Owner authentication is required for REST and tRPC; responses are private and
not cached. GET only reads saved configuration and delivery receipts. It does
not initialize a scheduler or contact hardware.

| Operation | REST | tRPC |
| --- | --- | --- |
| Read current occurrence | `GET /api/v1/alarm/next?side=left` | `nextAlarm.get` |
| Change one occurrence | `POST /api/v1/alarm/override` | `nextAlarm.change` |

`features.nextAlarmOverride` and `endpoints.nextAlarm` / `endpoints.alarmOverride`
in `/api/v1/capabilities` advertise this implementation. Physical verification
remains `unverified`.

A read returns `apiVersion: 1`, physical `side`, Pod `timeZone`, an opaque
`revision`, `state` (`scheduled`, `skipped`, `none`, `away`), `canChange`, an
explanatory `reason`, and these optional records:

- `alarm`: `scheduleIds`, absolute `at` and `originalAt`, local `time`,
  `source` (`routine` or `override`), `duration` in seconds, `wakeWindow` in
  minutes and `alarmTemperatureF`. `originalAt` retains the weekly event even
  after repeated time changes. For a skipped occurrence, `at` identifies the
  suppressed original event, not a command that will execute.
- `followingAt`: the next distinct weekly event after this occurrence. Show it
  when an alarm is skipped; do not label the skipped event the next vibration.
- `change`: UUID `revision`, `status` (`active`, `expired`, `invalidated`),
  `originalAt`, requested `at` (null means skipped) and `expiresAt`.
- `execution`: null, `attempting`, `acknowledged` or `unknown`. An acknowledgment
  is a protocol result, not evidence that the mattress physically vibrated.
  A crash after the durable claim can leave `attempting`; do not treat it as
  proof of either delivery or non-delivery.

Copy the displayed revision and timestamp strings verbatim into requests:

```json
{"side":"left","action":"skip","expectedRevision":"<GET revision>","expectedAt":"<alarm.at>"}
```

```json
{"side":"left","action":"time","time":"07:30","expectedRevision":"<GET revision>","expectedAt":"<alarm.at>"}
```

```json
{"side":"left","action":"restore","expectedRevision":"<GET revision>","expectedExpiresAt":"<change.expiresAt>"}
```

The write response has the read shape plus `schedulerUpdated`. False means the
change is persisted but timer registration was not confirmed. It is not a
hardware success. Normal startup and the scheduler heartbeat reconcile saved
future changes. An elapsed override is never caught up after restart.

Use HTTP 409 to refresh stale/consumed occurrences; 400 identifies invalid
requests or times; 412 indicates missing time-zone configuration. Preserve a
local time draft after errors. After a lost response, GET first and require
review before another write; never automatically retry a mutation against a
new revision. Restoring retains a generation tombstone, so an older request
cannot become valid again simply because the visible alarm matches its original
value. The web editor keeps its draft bound to the revision it opened with.

## Time and schedule behavior

A changed time uses the displayed alarm's local wake date. It must be in the
future and must not cross another scheduled alarm. Skipped DST wall times and
repeated fall-back times are rejected; weekly routines keep their existing cron
semantics. Identical simultaneous rows are one wake event. Differing simultaneous
profiles continue their individual weekly behavior, but one-time editing is
unavailable until that conflict is resolved in Schedule.

A change retains the original weekly row identities and plan fingerprint.
Editing enabled weekly rows or the Pod time zone invalidates the temporary
change; it does not replay a captured profile that has since been deleted or
edited. Away/inactive sides stay silent. Changing a wake event already attempted
is refused; existing stop/snooze controls still manage the active vibration.
Restore removes the temporary change but never replays a consumed or elapsed
original occurrence.

The single temperature authority uses the effective alarm's warm-up and hold:
`max(30 minutes, wakeWindow)` before wake, through `duration + 15 minutes` after.
A skip suppresses the original span. Moving earlier still suppresses the later
original span; expiry covers both. An off side is not powered on for warm-up.
A previously deferred power-off rechecks the current span at its deadline, so
an overlapping later wake window is not cut short. An explicit power-on still
invalidates the old deferred shutdown. A nonoverlapping, substantially later
alarm does not extend an already-finished heating session.

Personal comfort withholds adjustments for the affected bedtime routine and
active alarm spans. A change next week does not suppress unrelated nights.
Snooze configuration follows the original alarm profile. Existing pending
snoozes are neither canceled nor rescheduled by a future one-time edit.

## Delivery and recovery

```mermaid
flowchart LR
    Edit[Revision checked edit] --> Saved[(Temporary occurrence)]
    Saved --> Timers[Weekly and absolute timers]
    Timers --> Guard[Current plan and side lock]
    Guard --> Claim[(Durable occurrence attempt)]
    Claim --> Queue[DAC queue: recheck deadline and plan]
    Queue --> Result[Acknowledged or unknown]
```

Generated migration `0042_next_alarm_occurrences` adds `alarm_overrides` and
`alarm_occurrences`. Early movement wake, normal clock callbacks, temporary
callbacks and restarted schedulers share the original occurrence identity.
A durable claim is made before transport. Unknown outcomes and interrupted
claims are consumed, not resent. Claims older than 30 days are pruned on a new
claim; stale callbacks cannot use that pruning to execute because their deadline
has elapsed.

Before the actual DAC write, the shared transport rechecks the current plan,
side ownership and a maximum 60-second wall/monotonic deadline. A queue wait,
clock rollback, schedule edit or disconnection cannot revive an old command.
The heartbeat preserves an identical timer even at its exact deadline.
Temporary alarm and deferred-shutdown jobs are excluded from weekly-job drift
counts. Replacing a one-time shutdown from its own callback no longer removes
the replacement from the scheduler's registry.

The demo explicitly reports that a live authenticated Pod is required. No demo
change is presented as a saved wake command.

## Migration and acceptance

This does not silently translate active legacy Free Sleep overrides into new
Core occurrence identities. The offline importer preserves their original
settings and lists active overrides under `reviewRequired`. Review or let those
changes expire before the attended cutover; retain their rollback archive.
Create a fresh quiesced backup/import before switching controllers.

Software coverage uses migrated SQLite databases, real scheduler timers with a
fake clock, mocked DAC transport, and an isolated authenticated production web
server. It covers CAS/replay, side isolation, DST, original-row preservation,
expiry, warm-up/hold suppression, shutdown rescheduling, early-vs-clock duplicate
claims, connection/queue delays, uncertain delivery, restart, browser draft
recovery and phone layout. These checks do not qualify the Pod's actual routing,
intensity, duration, vibration cancellation or snooze behavior. Those attended
hardware checks, native adoption and the genuine Preview nights remain separate
release gates. No live Pod controller was switched for this implementation.
