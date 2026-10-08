# ADR 0024: Local adjustable-base control over Bluetooth

**Status:** Accepted for implementation; physical hardware qualification pending
**Date:** 2026-10-04

## Context

free-sleep beta adds TriMix adjustable-base support absent from its main branch. [Investigation](../research/free-sleep-adjustable-base.md) pins the history, protocol and known defects. sleepypod needs a local UI and API without coupling BLE failures to cooling or the DAC's sequential response stream.

## Decision

1. Add a pure, tested TriMix codec and a dedicated BlueZ D-Bus adapter using `dbus-next` (external server package; ordinary Unix socket, no required native addon). Retain the upstream degree/tick tables, synchronized motor selectors, checksum, stop packet and four presets. Validate integer angles and rate at the API and controller boundary. Attribute the MIT-derived data.
2. Read the existing stock configuration file, validating the MAC and SplitBase fields. Missing or malformed config is an explicit unavailable state; an API/UI reconnect action reloads it. No scan or unsolicited pairing with arbitrary devices. Connect only to the locally paired configured device through the system bus. One adapter/controller lives on `globalThis`, starts lazily, and shuts down with instrumentation.
3. Use one serialized BLE write stream, bounded D-Bus call timeouts, acknowledged subscriptions/writes, characteristic discovery by FFE1/FFE3 UUID within the configured device, notification scoping to its path and BlueZ bus owner, checksum validation and bounded resynchronization. Reconnect retries only establish the connection; they never replay movement. A call timeout disconnects the bus and rejects pending calls; D-Bus serials correlate replies.
4. Whole-bed moves acquire the existing side locks left then right. Reject overlapping moves instead of building a delayed queue. Stop cancels the active generation before waiting for the current BLE transaction, bypasses side locks and prevents the delayed leg command. Stop remains possible when telemetry is stale. Successful API response means a Bluetooth write was acknowledged, not that a physical target was reached. Display measured positions separately from requested controls.
5. Preserve per-side positions and distinguish missing/stale telemetry from flat/stopped. Motion is an estimate from raw tick changes; no inference of physical stop from a command acknowledgement. Missing updates become unknown. SplitBase is reported, but this implementation moves both halves together just as the evidenced protocol does.
6. Expose status, reconnect, set-position, preset and stop through tRPC and REST `/base/*`, using the existing LAN trust model. No new authentication model or cloud dependency.
7. Store recurring whole-bed elevation schedules in the configuration DB with generated Drizzle migration. Each row has day, time, enabled and validated head/feet/rate. Register with JobManager on the selected calendar day in the device timezone; re-check row/enabled and both sides' away modes at execution. Elevations do not require cooling to be powered. No catch-up/retry/replay of missed physical moves. This avoids upstream's competing per-side whole-bed schedules.
8. Add a responsive Base page reachable from the temperature page, with connection state, measured angles, an SVG bed preview of the selected target, explicit Apply, four presets, rate, always-reachable Stop and schedule management. Loading, absent config, stale/disconnected, pending and failed mutations are first-class states. Adjusting inputs alone never moves hardware.

## Alternatives

- Copy beta wholesale: rejected; incompatible architecture and known lifecycle/race defects.
- Send base commands over DAC: rejected; no evidence of a DAC base protocol.
- Interactive bluetoothctl: BlueZ 5.50 client/gatt.c write_reply emits no success message, only errors. A CLI prompt does not acknowledge an asynchronous write. Use direct D-Bus WriteValue replies instead.
- New native BLE package or Python daemon: avoid a second runtime and native bindings; dbus-next can use Node Unix sockets without its optional usocket addon. This adds a JS dependency and requires system-bus access already used by BlueZ.
- Independent split-base writes: not supported by the demonstrated synchronized protocol. Display this limitation explicitly rather than infer motor selectors.
- Per-side elevation schedules: rejected because both commands move the same actuator assembly.

## Consequences and validation

The BLE adapter must fail visibly on unexpected BlueZ responses. No command is silently queued for reconnection. Existing non-base installations continue normally. Transport tests exercise UUID discovery, scoped signals, acknowledged writes, errors/timeouts, disconnects and shutdown. Protocol tests include upstream known command bytes, corrupt frames and separate-side telemetry. Controller tests exercise stop during the inter-motor gap, lock waiting, concurrent requests and missing/stale state. API tests validate both input and failure mapping. Schedule tests cover away mode, disabled/deleted rows, timezone registration and no replay. UI tests cover explicit apply, presets, stop while movement is pending, errors and unavailable hardware. Typecheck, lint, relevant regression tests, build and browser layout inspection are required.

Physical qualification is still required on a TriMix base before claiming verified physical operation; the local implementation can be validated without energizing hardware. See the investigation for firmware assumptions and provenance.

The dbus-next package has an unguarded optional desktop X11 import. A pinned pnpm patch wraps only that require in try/catch; no X11 package or native addon is needed for the system bus. A package-scoped override excludes optional usocket and its native installer dependencies; ordinary filesystem Unix sockets use Node net. See [setup and qualification](../hardware/ADJUSTABLE-BASE.md).

## Per-side UI and schedule extension (2a/2b)

The Base page now provides both requested layouts behind an explicit `independentControl` capability. This supersedes the whole-bed-only UI and data-model choices in decisions 7–8, while retaining the hardware restriction in decision 5. The current TriMix transport advertises false; separate measurements or `SplitBase` alone are not evidence of independent actuation. Its controller rejects one-sided writes before taking locks or writing BLE. The demo advertises true and simulates per-side measured motion.

Targets are separate from telemetry in both layouts. Layout, link state, last scope, and opt-in immediate presets persist in browser storage. Stop is global and always enabled, with visible command failures. Calibrated limits remain 60°/45° and 30–100% speed; 25% is visibly unavailable. No motor selectors or calibration tables change.

Schedules carry side and preset name; generated migration 0018 creates `base_schedules` with both columns (side defaults to `both`). Recurrence includes Daily/Weekdays/Weekends. The scheduler checks only the affected side(s) for away mode, rechecks scope and targets under the controller lock, and skips callbacks or lock waits over one minute late. API validation prevents overlapping recurrence slots for the same side and rejects per-side schedules on synchronized transports. Existing update/pause API calls remain supported.

## Per-side lock and experimental status

Per-side movement is locked behind `INDEPENDENT_CONTROL_UNLOCKED = false` until a TriMix firmware dump confirms the per-side motor selectors. While it is locked, the demo and `?debug=1` simulators report `independentControl: false` and reject one-sided moves and schedules, just as the hardware controller does. Every surface therefore shows the whole-bed layout. The per-side UI, scheduler scope and simulator behavior remain in place and stay tested, so unlocking needs only the flag change plus physical qualification. The feature as a whole is labelled experimental in the UI and docs until a physical base is qualified.
