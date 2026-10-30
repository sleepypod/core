# Unified Sleep foundation

This fork starts from stable v3.4.0 (`f8948b04586542fab1817aadc72b65a9c2988f8c`).
It remains AGPL-3.0; the existing license and upstream attribution are retained.
The active native companion is in https://github.com/lucaandrea/sleepypod-ios.
The original Free Sleep native app remains in its separate repository; it is not
the current UI reference. See [navigation](UNIFIED_NAVIGATION.md).

## Implemented locally

- Separate read-only imported history, with source-labelled web views and direct v1 pagination for native clients. Original records remain byte-preserved; they are not live measurements or Preview-night evidence. See [Imported history](IMPORTED_HISTORY.md).
- Owner authorization across REST, tRPC, raw data, exports, diagnostics and the live sensor socket. See [owner access](OWNER_ACCESS.md). General MCP and raw actuator passthrough default to disabled.
- Legacy Pod 4 capacitance profiles and frame quality/freshness checks, with incomplete readings treated as unavailable.
- SleepyPod presentation: original neutral light/dark tokens and 3D temperature controls. Phone navigation matches the native Temp, Schedule and Sleep destinations, with a Settings entry for secondary controls. Desktop retains direct navigation for Base, Autopilot, Home, System and Settings. The former Free Sleep palette generator has been removed; `app/globals.css` owns the web theme.
- Autopilot's persisted setting is loaded before timers start. Missing/unreadable settings and new installations default to disabled. Existing explicit settings survive the generated migration.
- Persisted personal comfort Preview, with default 70–95°F limits, one-degree steps, 30-minute spacing, six-hour manual-pause semantics and explicit freshness/presence/water/artifact guards. The production runtime records proposals without changing hardware; active comfort remains unavailable. See [Personal comfort Preview](PERSONAL_COMFORT_PREVIEW.md).
- Passive policy proposals join the existing temperature authority without being erased by rule refreshes. Each producer owns its leases; failed freshness/consent guards revoke them, and the controller rechecks after transport recovery. Policy proposals cannot turn an off side on or extend a hardware duration.
- Next.js updated from 16.4.0 to 16.4.3 after review of the official October 14 security update and patch release notes.

## Validation

521 targeted tests passed across authorization, endpoint gates, streaming, occupancy,
navigation, startup settings and migrations. Changed TypeScript files pass ESLint.
The production build passes using Node 24 and pnpm 10.34.6. For the isolated build,
both SQLite databases were initialized/migrated before Next's parallel page workers;
the first attempt against new files hit WAL initialization contention.

The broader pre-push gate subsequently passed TypeScript, full ESLint, both Drizzle
schema checks and 3,507 related tests across 148 files. Authentication fixtures and
a rolling-date fixture were corrected; the piezo processor's locked uv environment
was installed for the Python integration test. API status/diagnostics now report
Autopilot disabled when settings are missing, matching the startup default.

The subsequent comfort policy/arbitration change passed 184 targeted tests across
the learner, shared controller, database-backed controller instance and rule engine.
These are deterministic software tests, not evidence of improved sleep outcomes.

Demo screens were inspected in the browser; they are labeled sample data and do not
operate a Pod. This is not deployment, hardware verification or an external security audit.
Production-browser checks reject an invalid synthetic connection key, accept a valid
local test key, and return to the connection gate after signing out. Real Pod credentials
were not used in these checks.

## Remaining integration gates

Production Preview wiring, the reversible offline importer, room-context input and
foreground notification delivery now exist in source, as documented below. Native
clients use negotiated direct version 1 APIs; the legacy compatibility adapter has
not shipped. Broker provisioning, actual home integration, hardware qualification
and the active comfort admission/application adapter remain required. Shared
[temperature application receipts](TEMPERATURE_APPLICATIONS.md) now record
attempts and acknowledgments separately from proposals and physical observations.
Active must include the
global Autopilot opt-in in every lease guard; Off/Preview must never submit leases.
Per-night reporting and exact-source owner review are now implemented in
[Preview night reports](PREVIEW_NIGHT_REPORTS.md), with separate real-night gates.

The working Pod has not been switched to this fork. No base movement, vibration or new
automatic thermal action was issued. Preserve its installation and dedicated SSH service
through migration and restore testing. Seven actual Preview nights are required before
reviewing bounded activation; no nightly evidence is synthesized.

## Web presentation alignment, 25 October 2026

The owner's current client direction uses SleepyPod's original presentation.
The web shell now follows its neutral theme and Temp / Schedule / Sleep phone
navigation; Settings keeps secondary controls, diagnostics and browser sign-out
accessible, with a direct desktop rail. Existing `/more` bookmarks redirect to
Settings. Owner authentication, explicit demo labeling and hardware guards remain.
The full-screen 3D bed has its own Settings entry and ignores navigation swipes;
interactive controls likewise do not become page swipes. The renderer uses the
reviewed local vendor file, with no CDN fetch. The light-mode 2D fallback now
inherits readable foreground colors.

The production build passed. The full ten-workflow browser run passed, followed
by two focused navigation/rendering checks after visual review: both software
WebGL rendering with external HTTP blocked and the forced 2D fallback passed.
Light/dark 390px screenshots and desktop navigation were inspected. The initial
focused suite passed 271 tests; 37 renderer/bed tests passed after the fallback
fix. These checks use isolated synthetic databases and no physical Pod commands.

## Mechanical signal qualification

See [Mechanical data quality](MECHANICAL_DATA_QUALITY.md) for the new observed
quiet-span journal, pre-dispatch exclusions, bounded vital-output quarantine and
automation eligibility. This is software validation; the working Free Sleep
controller remains the rollback owner until the attended migration gates pass.

## MQTT command delivery

MQTT now defaults to telemetry only. Explicitly enabled commands reuse the
durable control service with UUID deduplication, deadlines at the hardware write
boundary, non-retained receipts and bounded ingress. Home Assistant templates
generate 30-second requests. See [the protocol](MQTT_COMMANDS.md). This source
change does not enable the broker on the owner's Pod or qualify hardware.
Dedicated broker credentials/ACLs and sensor freshness for external automations
remain separate integration work.

## Qualified home telemetry

MQTT now uses source timestamps and per-field availability, current mechanical
proof for live vitals, and calibrated occupancy. Live environmental/pump caches
reject replay backlogs. HomeKit ambient and occupancy sensors fault when missing
or stale. Unsupported clog discovery is withdrawn. See [the contract and
validation limits](HOME_TELEMETRY.md). This is source-level integration; broker
provisioning, actual pairing, sensor qualification and household automations
remain pending.


## Personal baseline in sensor-aware Preview

The comfort panel now offers an explicit Pod sensor guard in Preview. Historical
live estimates require recorded quality and mechanical receipts, consistent
processing/source identity, complete five-minute summaries and equally weighted
qualified local dates. Fresh adjacent current summaries can hold proposals when
they differ substantially from that baseline. The API/journal retain evidence
and expiry; historical scanning yields before taking the hardware side lock.
See [Personal baseline Preview](PERSONAL_BASELINE_PREVIEW.md).

The seven baseline-data dates are distinct from the seven real Preview nights
and hardware qualification required for activation. Optional [bed-entry timing](BED_ENTRY_PREVIEW.md)
now shifts proposed phases only. Active comfort, actual phase adjustments,
snoring elevation and unattended motion remain unavailable. The
working Pod still runs Free Sleep; this source change does not deploy Core or
change live control.


## HomeKit reported-state availability

Thermostat reads now require fresh post-write DAC observations; absent values
are unavailable rather than fabricated neutral temperatures or OFF modes.
Current mode derives from the reported current level, while explicitly staged
targets remain requests. Telemetry and pump-warning faults combine without
clearing each other. Stable identities and existing command sequencing remain.
See [HomeKit reported state](HOMEKIT_REPORTED_STATE.md) for source semantics and
the remaining actual Apple Home qualification boundary.

## MQTT transport requirements

The web form, partial settings updates, test probe and running bridge now reject
plaintext broker URLs when TLS is required. The URL and port remain explicit.
Unreadable saved settings stop new connections instead of discarding a stored
TLS policy. Connection tests use only the password entered for that test.
The settings page explains these behaviors and clears stale test results when
connection inputs change. See [MQTT configuration](integrations.md#configuration).

Local validation includes actual loopback MQTT, MQTT/TLS and secure WebSocket
handshakes, certificate rejection and zero socket connections for a TLS/URL
mismatch. These fixtures contain no household credentials and do not provision
the real broker, enable Pod control or qualify physical effects.

## Explicit service restart

Device settings now uses the allowlisted maintenance endpoint instead of the
software updater. Core restart requests are queued without waiting for the
calling service to stop itself; denied requests and lost replies are distinguished
from acceptance. See [the contract and deployment limits](SERVICE_RESTART.md).
The isolated Pod runtime still needs a scoped supervisor mechanism compatible
with its existing privilege restriction and attended restart/recovery testing.
The optional restricted supervisor now provides the source implementation: a
private Unix socket, current-process and reviewed-plan checks, expiring requests,
durable attempt receipts, and a shared migration lock. Rendering its service
plan does not install or enable it. See [Service restart](SERVICE_RESTART.md)
for provisioning and the remaining physical qualification.
The deployment tool now supports inspect, stopped installation, socket enablement
and rollback for that helper. Core opts in through its reviewed unit, so private
credentials are never rewritten. Failed installs and lost enablement replies
retain a recoverable journal; removal does not require a working release. The
tooling does not replace the pending attended restart and recovery qualification.

## Automation alert delivery

Live notification actions now persist an owner-authenticated inbox and return a
durable receipt. The shared web toolbar shows new alerts while the app is open,
read/expired history, explicit acknowledgment and network failures. Dry-run rules
record Activity proposals only. See [Automation notifications](AUTOMATION_NOTIFICATIONS.md)
for the REST/tRPC native contract, retention, deduplication and restart behavior.
Production-browser and real SQLite checks use synthetic alerts and do not operate
hardware. Native integration, APNs/Web Push and live Pod qualification remain
separate work; background push is explicitly unavailable in the API.

## Home Assistant room input

Home now supports explicitly mapped, timestamped room temperature, humidity,
CO₂, fine-particle and light measurements over the existing MQTT connection.
Source clocks, revisions, units, expiry and persisted replay watermarks gate
the live signals; broker loss and restart withdraw them. The owner UI and
versioned native API expose mapping, status, bounded history and generated HA
publishers. See [Room context](ROOM_CONTEXT.md) for the contract and qualification
steps. Input is opt-in and does not activate rules or household actions. Synthetic
loopback/browser evidence is separate from deployment and physical acceptance.

## Full personal check-ins and atomic comfort mode

The morning journal now preserves restfulness, habits and private notes alongside
comfort feedback. The offline importer restores full original entries with source
provenance, and the web editor uses revision checks, retained drafts and explicit
conflict/deletion handling. Habit comparisons keep current Core and imported
Free Sleep bed-presence sources separate; unknown data is not zero.

The direct comfort mode operation reads current settings under the write lock,
so a mode switch preserves concurrent limit/sensor updates. Active remains locked.
Native adoption, the future one-occurrence alarm override, target deployment and
physical qualification are separate gates. See [the API and storage contract](MORNING_JOURNAL.md).

## One-occurrence wake changes

The Temp alarm card now separates skip/time/restore for one wake occurrence from
weekly schedule editing. The authenticated native-ready contract, persistent
compare-and-swap semantics, temperature spans, durable attempt records and
migration limits are documented in [Next alarms](NEXT_ALARMS.md). Existing
weekly schedules are preserved; actual Pod vibration remains unqualified.

## Disabled house templates

Six optional [Home Assistant blueprints](../integrations/home-assistant/README.md)
cover selected wind-down, night-path, morning bed-exit and empty-bed scenes, plus
humidity/PM2.5 review notifications. All start disabled and require an explicit
Allow input inside their action sequences. The scene templates do not command
the Pod; room review uses source timestamps and withdraws expired proposals.
Morning bed exit is not synchronized to a Pod alarm, and automatic appliance
control remains unavailable until device capability and behavior qualification.
Real Home Assistant schemas and script execution are validated locally with
synthetic states and stub services. Actual home import, broker provisioning,
device selection and physical acceptance remain separate gates.
