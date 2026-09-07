# Remote remapping implementation

The Remote screen is available at `/{lang}/autopilot/remote`, alongside
Automations and Diagnostics. It implements the September 7 Remote handoff:
independent left/right overrides, three permanent single-press rows, six
optional double/combo rows, linked remote illustration, structured parameters,
copy/reset confirmation, device persistence, and live capture.

## Findings that change the prototype contract

The [field evidence](../adr/0024-cover-button-signals.md) takes precedence over
the prototype's illustrative firmware assumptions:

- Firmware natively aggregates click counts. Top counts 1–5 were observed;
  the UI exposes single and double as requested, and captures higher counts as
  unsupported without flattening them into single actions. The prototype's
  400 ms double-click claim is not verified and is not shown.
- Holds and chords are reconstructed from valid GPI 97/98/99 press/release
  logs using the embedded cover counter. Native click payloads alone cannot
  identify overlap. A hold of at least 1,000 counter ticks is observable but
  has no binding in this screen. This threshold is application policy.
- Two-button combos require overlapping presses within 200 cover-counter
  ticks and both releases. The 200 threshold is application policy, consistent
  with the handoff; it is not a firmware constant. Incomplete sequences are
  shown in capture without dispatching a combo. All-three and held-button
  sequences are observable but not bindable. A later valid edge after 10,000
  ticks invalidates stale held state. Keypad reset, counter regression, NATS
  disconnection, and shutdown also invalidate pending recognition.
- RAW can write the native click count before the corresponding edge logs.
  Count dispatch waits one second for those logs; observed holds and overlaps
  suppress their constituent native click bindings. Second-resolution source
  timestamps limit this correlation. Missing/delayed logs remain a firmware
  limitation, so combos are explicitly experimental.
- Native haptics and alarm behavior remain active. No verified command
  disables them. Therefore inherited rows say **Firmware default**, and
  **Nothing** means no custom software action. The prototype's temperature,
  elevation and power factory map is not executed or presented as verified.
- Elevation and soundscape controls have no implemented device API. Their
  catalog entries are visible and disabled; the server rejects those bindings.
  Supported actions use the same device/settings procedures as manual controls.
- Source timestamps have one-second precision. Capture displays unavailable
  latency instead of inventing millisecond delivery measurements.
- Stable combo IDs follow the explicit physical-order examples in the handoff
  (`top+mid.single`, etc.), rather than its contradictory alphabetical note.

The later middle+bottom trial also captured both presses and releases: presses
16 counter ticks apart and 160 ticks of overlap. These selected records are
included in the September 7 evidence fixture. Physical validation of the full
right-side catalog and all release permutations remains outstanding.

## Persistence and execution

Migration 0015 adds `remote_configuration`. Only software overrides and visible
extras are persisted, with a shared revision for optimistic concurrency.
Copy replaces the opposite side atomically, including extras. Reset removes
overrides; it does not program guessed native defaults. An outdated writer
receives a conflict instead of silently replacing another client's edits.

The frontend uses the existing tRPC stack: `remote.mapping`, `remote.update`
and `remote.status`. The update takes `{side, revision, edit}` with validated
structured values such as `{action: 'temp.up', deltaF: 2}`. This replaces the
prototype's assumed whole-map PUT endpoint. Mapping reads are also exposed
through the project's OpenAPI `GET /remote/mapping` route.

Edits save after 250 ms with a visible pending/error state. Saves are serialized;
leaving the app flushes an unsent edit. Mapping and selected side are held in
the Autopilot shell so switching screens preserves them.

Instrumentation starts the dispatcher before sensor streaming. Runtime state
and frame subscribers are process-wide so Next.js instrumentation and route
handlers see the same stream. No browser or armed capture is required for
execution. Commands are serialized, bounded to 20 queued detections, and
discarded after five seconds in the queue. Historical startup frames and
duplicate RAW file/offset/item identities do not dispatch actions.

Both RAW and live NATS sensor/log frames use the existing complete CBOR decoder.
NATS uses core subscriptions without replaying retained JetStream messages.
Its `raw.log` subscription supplies edge sequences; source identities include
the connection instance, message number and CBOR item number.

`automation.run` explicitly evaluates the chosen rule while retaining enabled,
global pause, conditions, cooldown, dry-run, runaway, and hardware safety gates.
Only its WHEN trigger is bypassed. See the automation run log for its outcome.

Diagnostics opens `GET /api/remote/detections` as SSE only while armed. It shows
the newest 12 unique detections and updates outcomes in place. Resolution uses
the current mapping, while the separate outcome records what execution did.
Stopping capture closes the subscription and retains the displayed rows.
There is no production injection control or fabricated detection data.

## Verification

Tests replay the selected real September 7 records in receipt order, including
triples through quintuples, a held middle, the complete held-top/bottom sequence,
and the incomplete all-three sequence. Additional tests cover replay, reset,
missing releases, side independence, action dispatch, concurrency conflicts,
shutdown, SSE cleanup, current-map resolution and UI editing interactions.

Local UI testing can use `CI=1 pnpm dev --port 3011`, which migrates and seeds
local databases while skipping hardware startup. This mode intentionally
reports that the device listener is unavailable. It does not exercise physical
hardware commands. Production builds use `pnpm build`.
