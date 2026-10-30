# Client capability discovery, v1

`GET /api/v1/capabilities` requires the existing owner Bearer credential or
browser session. It is also available as tRPC `capabilities.get({})` and is
included in `/api/openapi.json`. REST responses use `private, no-store`.

The read observes existing DAC, Bluetooth and MQTT state without starting a
connection, creating a controller or issuing a hardware command. Missing build
metadata returns a null revision; the recorded revision comes from `.git-info`.
The upstream baseline is v3.4.0, not a claim that the fork is an upstream release.

Each feature separates:

- `implemented`: the route/runtime integration exists in this revision.
- `runtime`: `ready`, `not_ready` or `unknown`, describing observed technical
  prerequisites. It is not permission to execute a command or a guarantee that
  the next command will succeed. Command handlers still perform their checks.
- `reason`: a machine-readable explanation; clients should tolerate new values.
- `physicalVerification`: `unverified` or `not_applicable`. No hardware-qualified
  state is advertised until a real qualification record is implemented.

Device observations expire after 15 seconds; base observations after 10 seconds.
`observedAt` and `expiresAt` are UTC ISO timestamps, separate from response
`generatedAt`. Missing, nonfinite, fractional, nonpositive or future timestamps
never become fresh. Cached device reports invalidated by a write/disconnect
remain stale even if their timestamps are recent. Reading an old report does not
refresh it. The controller's clock is authoritative; clients must stop treating
a saved response as current after its expiry or loss of connection.

Whole-bed base movement remains the only supported scope. Stop remains a
separate capability when connected, including stale-position, busy and unknown
motion states. Keep Stop visible; never infer successful stopping or movement
from HTTP success. Temperature, base and vibration remain physically unverified
on this Core fork, even when their technical prerequisites are ready.

`nativeCompatibility` remains null and its feature remains unimplemented: the
legacy `/api/native/v1/` adapter has not shipped. `personalComfortPreview` now
describes the production Preview service; it never issues actuator requests.
`personalComfort` still reports active control unavailable. See
[Personal comfort Preview](PERSONAL_COMFORT_PREVIEW.md) for its versioned API.
Room context now has a separately negotiated direct version 1 API; see
[Room context](ROOM_CONTEXT.md). Music vibration remains unavailable. MQTT
connection alone does not imply that room inputs are connected or qualified.
`features.nightReports` on the comfort response advertises per-night reports and
owner review; see [Preview night reports](PREVIEW_NIGHT_REPORTS.md). These routes
and optional bed-entry timing fields are not forwarded through a legacy adapter.
Clients should decode the compatibility prefix as a nullable string and receipt
and expiry support as booleans; these values are not permanent schema constants.
Only enable a feature when this controller reports it.

`importedHistory` advertises the direct read-only history API at
`endpoints.importedHistory`. Read that endpoint's status before offering records:
software readiness does not mean a snapshot exists. Legacy presence and
five-minute vitals remain a separate, unqualified source and never count as
Preview nights. See [Imported history](IMPORTED_HISTORY.md) for pagination,
units and the remaining Health/coaching boundaries.

`morningJournal` and `endpoints.journal` advertise the full private check-in API.
`comfort.get.features.modeOnly` advertises the atomic Off/Preview operation.
Both use direct versioned contracts, with revision conflicts for journal edits;
see [Morning journal and comfort mode](MORNING_JOURNAL.md).

Durable command receipts and expiry are implemented **only** for the versioned
control endpoint advertised by `endpoints.controls`, with
`controlSemantics.receiptScope = "versioned_controls_only"`. Legacy actuator
routes do not gain these guarantees. Query an uncertain request's existing ID;
never replay it as a new request. A successful acknowledgment does not prove a
physical outcome. See [control receipts](CONTROL_RECEIPTS.md). Versioned
measurement envelopes remain separate work.

`alarmSnooze` describes the implemented per-alarm length/taper contract, including
complete bedtime routines. It is ready as a software settings capability without
a live DAC connection; actual vibration still uses `wakeVibration` prerequisites
and remains physically unqualified. `curveLibrary` reports the calendar curve
library as ready, with the reason `calendar_curves_with_bedtime_ownership_guard`.
An imported bedtime side must still use the complete-routine API: attempts to
apply calendar curves to it return HTTP 412 without writes. Empty alarm or
template collections must not be used to infer either capability. See
[alarm snooze](ALARM_SNOOZE.md) and [schedule library](SCHEDULE_LIBRARY.md).
