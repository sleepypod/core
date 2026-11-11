# Approved platform improvements

Owner approval: 10 November 2026. This is an implementation and acceptance ledger,
not a statement that the features below are already delivered. All 24 items remain
in scope. Source, simulator, distributed app, live deployment and physical evidence
are separate acceptance states.

## Delivery sequence

1. Reliable authenticated access, private offline reading, recording health and the
   overnight comfort envelope.
2. Tonight, morning reports, clear wake plans and the learning journey.
3. Household activation, temporary arrangements and contextual onboarding.
4. Qualified home routines, one-night wake coordination and everyday remotes.
5. Prospective temperature response research, experiments and qualified base use.

Each change is tested on a focused branch, merged after checks, and recorded here.
Controller releases preserve data and require a current attended maintenance window.
Preview, physical qualification and reviewed-night gates remain real evidence gates.
No synthetic data or ordinary successful wake replaces a missing qualification.

The [product review](PLATFORM_PRODUCT_REVIEW_2026-11.md) connects these 24 approved
items to the current app source and official competitor documentation. It refines
priority and acceptance; it does not introduce an additional approval gate.

## Requirement and acceptance ledger

| ID | Approved improvement | Acceptance evidence required | State |
| --- | --- | --- | --- |
| 01 | Automatic home/away connection | Verified-origin pairing, authenticated route selection, credential isolation, expired access and work-network/cellular tests; no mutation replay | Native PR 69 consolidates verified enrollment and automatic selection of approved origins; hosted checks, gateway deployment and work-network/cellular acceptance remain |
| 02 | Useful offline app | Encrypted identity-scoped records, reports and confirmed schedules; timestamps; account-switch/revocation tests; offline phone/iPad walkthrough | Owner offline reading merged in native PR 58; integrated release is PR 69. Personal-account offline reading and physical acceptance remain |
| 03 | Tonight main screen | Bed, temperature, next wake and actual control mode; morning brief; accessible web/native layouts | Web source validated; native Tonight and morning entry consolidated in PR 69 with local phone/tablet validation; release and live acceptance remain |
| 04 | Overnight comfort envelope | Persisted narrow overnight range, explicit wake exception start, arbitration/override/DST tests and live acknowledged policy | Shared range and wake exception implemented in Core and native PR 69; live policy acceptance remains |
| 05 | Recording health | Freshness, dropout, storage and processing checks; actionable messages; failed-source fixtures and live verification | Read-only checks shipped in source; completed-interval interruption review in validation; live qualification pending |
| 06 | Watch recording assistant | Import receipt, coverage and uncertainty-aware troubleshooting; foreground/background tests with actual Watch history | Native PR 69 includes the tested import and coverage assistant; hosted checks and actual Watch delivery remain |
| 07 | Guided learning | Separate stage, baseline and temperature readiness with accurate missing evidence and usable next actions | Core PR 86 merged; native guided learning is consolidated and locally tested in PR 69 |
| 08 | Predictive temperature control | Target-change dataset, held-out response validation, bounded Preview evaluation, reviewed activation and prospective outcomes | Core PRs 93 and 94 merged evidence audit and response-model research; native parity is consolidated in PR 69. Prospective target-changing control remains pending |
| 09 | Optional daytime context | Consented workout/activity/history imports, source/time semantics, missingness and per-person isolation tests | Native owner-scoped context import and review consolidated in PR 69; local tests passed, hosted release and physical delivery remain |
| 10 | Comfort experiments | Reviewable nearby treatments, fixed wake, randomization/carryover handling, feedback, stop/revert and prospective observations | Pending |
| 11 | Habit discoveries | Optional timing/quantity, comparable counts, missing-data/confounding explanations; no causal claims | Core PR 95 merged owner/legacy comparisons; native parity is consolidated in PR 69. Person-owned journal editors are in Core PR 111 and native PR 71; private saved-only habit comparisons pass local source/browser checks and the independent review correction; hosted delivery and native parity remain |
| 12 | Morning brief | Three evidence-backed takeaways, comparison chart, badges, one experiment, grounded follow-up and expandable provenance | Native morning brief consolidated in PR 69, preserving its local test and independent design-review evidence. Web parity, hosted release and physical delivery remain |
| 13 | Explanation timeline | Requested/reported values, environment, manual origin and applied/withheld decisions joined without fabricated causality | Core PR 91 merged after hosted checks; native explanation timeline consolidated in PR 69; live acceptance remains |
| 14 | Clear wake plan | Actual warming/vibration summary, simple editor, advanced disclosure, app-owned backup alarm and qualified accessory receipts | Core and native PR 69 provide the clear plan and app-owned backup workflow; physical alarm and selected accessory acceptance remain |
| 15 | Sleep in tomorrow | One-occurrence preview, cross-device receipts, partial failure/recovery and recurring schedule restoration | Core PR 98 merged after hosted checks; native PR 69 includes reviewed Pod and app-owned phone coordination with fresh phone-state reconciliation. Qualified house devices and live acceptance remain |
| 16 | Complete two-person experience | Invite/sign-in/privacy/preferences/publication plus atomic reviewed Marissa-left/Luca-right activation; immutable historical attribution; solo until activation | Core PRs 99–110 integrate identity, history ingestion, command admission, reviewed storage/recovery, web maintenance and the private learning library. Native maintenance/library work is consolidated in PR 69 after local phone/tablet checks. Person-owned check-in storage/API and web editor are tested in Core PR 111; the matching native editor is tested in stacked PR 71. Both await hosted checks and merge. Archived-copy deletion, personal learning/enrollment, native release, public activation and physical acceptance remain. Live solo behavior is unchanged |
| 17 | Quiet and temporary arrangements | Explicit partner-resting/guest/side-swap state; shared-action arbitration and ambiguous-night training exclusion | Pending |
| 18 | In-app practice | Illustrated guide reused, interactive temperature/alarm/Stop practice; secure invitation without owner key | Pending |
| 19 | Coordinated bedroom | Fresh sensor requirements, approved currently-on lights/shades/purifier capabilities; separate physical tests and dry-run receipts | Pending |
| 20 | Endel bedtime ritual | Supported Shortcuts/AirPlay flow, selected volume/duration, actual route state and tested tap-to-finish fallback | Pending |
| 21 | Watch, ESP32 and widgets | Temperature/Stop/next alarm, person assignment and freshness parity; simulator and physical verification | Pending |
| 22 | Temporary cooling | Modest bounded request, explicit feedback, expiry/cancellation, no stale restoration over a newer manual command | Core PR 90 merged after hosted checks; native cooling flow consolidated in PR 69 with local phone/tablet review; live release remains |
| 23 | Bed-care center | Actionable real telemetry, backup age and recovery walkthrough; unavailable leak detection stays unavailable | Core PR 89 merged after hosted checks; native bed-care flow consolidated in PR 69 with local validation; live deployment remains |
| 24 | Base and snoring assistance | Attended movement/Stop/position qualification first; trustworthy snore signal and whole-bed partner constraints before automation | Pending |

## Cross-cutting contracts

- The Pod remains the sole hardware authority. Network recovery performs reads;
  queued or expired actuator commands are never replayed.
- Account identity and dated sleeper assignment are distinct from physical side.
  Cached data must not cross an owner/personal boundary or device credential change.
- Missing measurements remain unknown. Watch nightly wrist-temperature aggregates
  are not real-time body temperature; occupancy is not person identification.
- Cloud report requests retain explicit sharing consent. Models propose experiments;
  approved deterministic policies control hardware.
- Existing weekday wake remains 07:00, warming from 06:30 toward 105°F and vibration
  for 20 seconds. Do not silently enable weekend alarms or change home audio volume.
  Weekend time and audio-volume discrepancies in older plans must be resolved before
  activating those routines.
- Homebridge/Apple Home pairings are preserved. Home controls reflect actual
  capabilities: the saved diffuser is power-only.
- Remote access requires authenticated HTTPS with origin enforcement and native
  login support; do not publish an unauthenticated Pod or require disabling work VPN.

## Validation and release records

- **02 — owner offline library:** [native PR 58](https://github.com/lucaandrea/sleepypod-ios/pull/58)
  merged after all hosted checks and adds encrypted, identity-scoped records, reports and schedules. Local signed
  simulator checks passed on iPhone and iPad; physical and personal-account work
  remains. Detailed receipts are in native `Integration/parity/OFFLINE_LIBRARY.md`.
- **05 — recording readiness:** [implementation and validation](RECORDING_READINESS.md)
  covers eight independent equipment/history checks, source expiry and web status.
  Core PR 84 passed hosted checks and merged. Native PR 59 adds matching cards;
  classification-dropout analysis and physical deployment remain separate work.
- **04 — automatic comfort range:** [authority and validation](OVERNIGHT_COMFORT_LIMIT.md)
  documents the range, wake exception and dispatch guards. Live activation remains
  separate from the software implementation.
- **06 — Watch recording assistant:** [native PR 61](https://github.com/lucaandrea/sleepypod-ios/pull/61)
  adds provenance-specific sleep coverage and automatic morning refresh opportunities.
  The signed iPhone suite passed 1,208 tests with nine skips; seven focused refresh
  regressions and two iPad UI tests passed. Physical delivery and release are pending.
- **07 — guided learning:** [scope and evidence](GUIDED_LEARNING.md) separates
  stages, private baseline and temperature learning. Web unit, production-build and
  mobile/desktop browser checks passed; native and live release remain separate.

- **03 — Tonight:** [everyday plan and evidence](TONIGHT_OVERVIEW.md) describes fresh control mode, range, wake occurrence, morning entry, side ownership and responsive layouts. No live routine was changed.

- **14 — clear wake plan:** [contract and boundaries](CLEAR_WAKE_PLAN.md) documents authoritative warming, a simpler editor and explicit app-owned system backup. Home coordination and physical delivery remain separate acceptance gates.

- **23 — bed care:** [read-only sources and recovery boundaries](BED_CARE.md)
  preserves independent observation freshness and distinguishes a server export
  from a verified off-Pod backup. It cannot detect physical leaks or insert age.
  Core PR 89 merged as `0a1b6360` after all hosted checks passed. The first unit
  run timed out in existing notification retention; its isolated coverage check
  and the complete failed-job rerun passed. The original failure is retained.
- **22 — temporary cooling:** [authority and recovery behavior](TEMPORARY_COOLING.md)
  documents the expiring physical-zone lease, explicit moment feedback, preserved
  firmware countdown and one-time guarded return. Policy/storage/context/UI tests
  and authenticated mobile/tablet browser flows cover normal and uncertain replies.
  No live cooling request, wake routine or personal adaptation mode was changed.
  Core PR 90 merged as `a6f0798e` after all hosted checks passed. Native PR 65
  adds the matching reviewed proposal, expiry, cancellation and uncertain-request
  recovery. Signed iPhone/iPad tests and an independent design verdict passed;
  hosted checks, TestFlight and physical acceptance remain separate.
- **13 — overnight explanations:** [source semantics and validation](NIGHT_EXPLANATION.md)
  records read-only source boundaries, DST windows, gap-preserving charts,
  controller/Preview distinctions and cached room clocks. Native parity and
  actual overnight verification are in progress. Core PR 91 merged as `01643599`
  after 8,977 unit tests (19 skips), hosted browser checks, typecheck, lint and
  builds passed. Its merged tree matches the tested source tree exactly.

- **05 — repeated presence interruptions:** Core PR 92 passed every hosted check and merged as `122614d7ab8f94295d533c3f1ab0b8b8c9501154`; its tree equals tested head `65e2e1cb3df7b79b070688762185ecbe6e05f71c`. This is source integration, not live sensor qualification.
- **08 — target-response evidence:** [data rules and research boundaries](TARGET_RESPONSE_EVIDENCE.md) explain the authenticated audit of actual 1°F changes, reviewed-night proofs and observed outcomes. The first delivery is evidence inspection; it does not fit or activate predictive control.

- **08 — fitted response research:** [model, API and display contract](TARGET_RESPONSE_MODEL.md) defines a local night-separated ridge model with three baseline comparisons, immutable source references and explicit conditional previews. Core PR 94 merged as `2a2d283b82c8410ef222ab36db695a9ea84b2e41`; its tree equals tested head `b80c73f981dc033e862753753aaa7cbffe29f790`. The new model is a research artifact, not activated predictive control. No live measurements, hardware settings or routine changes were made during this source implementation.

- **11 — habit discoveries:** Core PR 95 merged as `bf7622f64dc6d837beb1a5de10f2eb49d1a3687d`; its tree equals tested head `a29b0b5657db1ad6303ab7a7589bcd93f6a540a0`. Native implementation is committed as `b42d646`, with 1,314 passing regression tests, nine existing skips, focused iPhone/iPad UI checks and an independent visual review. It has not been distributed.
- **01 — connection enrollment:** [installation identity and transport boundaries](CONTROLLER_CONNECTION_IDENTITY.md) records an authenticated persistent logical-installation identifier and a fresh request challenge. Native enrollment is being tested independently. Automatic routing, gateway setup and work-network/cellular verification remain pending.
- **01 — verified connection delivery:** Core PR 96 merged as `565c030ef5018796b7d84213c7512bb796d62242`; its tree equals tested head `c42c61981a093f9a5b249a0f6d5982078a414043`. Native verify-before-save enrollment is committed as `a974be5` with 1,284 passing unit/framework tests, nine existing skips, ten passing phone/tablet UI scenarios and an independent design-review pass. Native `37558ad` adds a separately tested identity/route-selection foundation (22 focused tests); it is not wired into automatic reconnection. Native hosted integration, stable data/alarm ownership, gateway setup and physical work-network/cellular checks remain.

- **15 — later wake:** [review and application contract](LATER_WAKE_REVIEW.md) documents authenticated, expiring, revision-checked Pod-only preview and save. Cross-device coordination remains separate work; no live alarm changed.

- **Integrated native delivery:** [native PR 69](https://github.com/lucaandrea/sleepypod-ios/pull/69)
  consolidates the tested connection, Tonight, learning, context, morning, wake,
  cooling and care work. Its `d2a22c4` head passed 1,400 local model/application
  tests (nine existing skips), nine iPhone and nine iPad wake-flow scenarios,
  strict SwiftLint and build-for-testing. The independent reviewer resolved all
  three wake-flow findings: action-local errors, persistent restore boundaries
  and reconciliation against current phone alarms. Hosted checks, TestFlight
  distribution and live hardware acceptance are still distinct and pending.
- **15 — Core later wake release:** Core PR 98 merged as
  `0933e901b87011f2dcbf9adaadb1b88da8e54718`, with the same tree as tested
  `63d0642846d3de062c7230ab27181302fdb9831f`. Hosted checks and main packaging
  passed. No live alarm or home automation was changed.
- **16 — personal recording identity:** [source and import boundary](PERSONAL_HISTORY_SOURCE.md)
  describes the reviewed database binding, private immutable attribution and
  bounded completed-presence importer. These are prerequisites for the remaining
  activation coordinator, not a claim that the shared-bed transition is enabled.

- **16 — reviewed personal history:** Core PR 99 merged as `eab8713d7ffffbaa92e1abf8b0c0b7dbeeefdf12` after all hosted checks passed. Its tree equals tested head `97ca2b3ee8260edf4ddb75c297d66d7a2d0f9531` (`a99f0bf819634b2dcb9d7d13c423c7a6e1442235`). Local tests passed 9,216 cases with 19 existing skips. Source binding and the bounded completed-presence importer preserve immutable ownership and withdraw edited source copies. There is no automatic claiming, activation endpoint or ingestion loop yet; see [source contract](PERSONAL_HISTORY_SOURCE.md).
- **16 — transition command admission:** [dispatch and recovery contract](HARDWARE_ADMISSION.md) describes the durable hold, queued-intent revisions, explicit Stop and reply drain. The upcoming arrangement coordinator still owns reviewed activation and recovery. No live hold or arrangement was changed.
- **16 — command boundary release:** Core PR 100 merged as `8f262979ec5fd21e2c9edda61859b533a313c60b` after all hosted checks passed. Its tree (`4aaf2d5f916497d7faa6a9c51fada8bceca18351`) equals tested head `c80a7e9c3eb07715e1c24927ef5fbc8f6c63ffb3`. Local full validation passed 9,266 tests with 19 existing skips; hosted unit/browser checks, typecheck, lint and builds also passed. No live controller update was performed.
- **16 — continuous personal history:** [worker lifecycle and source boundaries](PERSONAL_HISTORY_SOURCE.md#continuous-ingestion-and-revalidation) describe independently bounded new-record and audit scans, restart replay, capped retries and privacy-preserving invalidation. Startup never claims unassigned history or changes the household arrangement. Final local validation passed 9,293 tests (19 existing skips), TypeScript, full ESLint and the production build; no live import was enabled.

### Continuous personal history — merged PR 101

- Tested head `cffac88f60a45734ba2a8a6a0902ef8081a6c5e6`; merged main
  `f8a3c8bd1049a3d8b618c4e5cc6868f3852e414e` on November 11, 2026.
- Both have tree `a79b7223951c9852a543e54f1013c75d726c705f`.
- Local full suite: **9,293 passed, 19 existing skips**. Pre-push related suite:
  **7,637 passed, 17 existing skips**. Types, lint, production build, generated
  migration checks and all hosted PR checks passed.
- Main package, release, OpenAPI, ref-collision and back-merge workflows passed. No live deployment,
  household flag, source binding, routine or hardware change was made.

### Reviewed arrangement commit — local implementation

See [the storage and recovery contract](HOUSEHOLD_ARRANGEMENT_COMMIT.md). A durable
hold and receipt now share one transaction; another transaction consumes both
approvals and changes both weeks, identities and control state atomically. The
old solo attribution interval closes at commit; the reload gap remains unassigned
until a separately verified runtime cutover. Public activation stays unavailable.

Focused household/admission tests passed **409 cases**, including SQL failure
rollback, private history preservation, in-flight Stop, stale observations, source
replacement and database reopening. Final full suite: **9,328 passed, 19 existing
skips**. TypeScript, full ESLint, both migration checks and production build pass.
The initial full-run failure was two omitted schema-contract expectations for the
new receipt table; both were updated and the complete suite passed afterward.
Hosted checks and the complete runtime recovery path remain separate gates.

### Arrangement automatic-service lifecycle — local implementation

Core PR 104 is merged as `32e08120650142bf011bb4ea1f7e1b7538e6d3f0`;
its tree `8d87a7568ee55506c6ed944fd3ebd8aac9e7ba1b` matches the tested head.
The follow-up adds shared, drainable suspension and explicit fresh resume for
automatic services, including old keepalive refreshes, occupancy producers,
rule evaluations and post-command alarm state updates. Held startup retains
diagnostics and Stop but cannot restore automatic producers.

The focused lifecycle suite passes 344 tests; the full suite passes 9,501 tests
with 19 existing skips. TypeScript, full ESLint and production build pass. An
earlier full run had one WebSocket handshake failure (HTTP 501); all 137 streaming
cases passed in isolation, and the final full suite passed without changing the
streaming implementation, assertions or timeouts. The failed log remains retained.
The public arrangement API still reports
activation unavailable; coordinator wiring, private learning migration and
attended hardware acceptance remain outstanding. Live solo behavior is unchanged.

The hosted thermal-forecast audit timeout was profiled and traced to repeated ICU
timezone formatter construction. Shared bounded formatter reuse preserves every
recording/source audit, fixture, assertion and timeout. The corrected local full
coverage suite passes **9,512 tests, 19 existing skips**; production build,
TypeScript and focused lint pass. Final hosted checks remain a separate gate.


### Household runtime coordination — local implementation

Core PR 105 passed all hosted checks and merged as
`01535709a5a535d5efc3b4c23696d694e3294430`. Its tree matches tested
`3c39c4f725f34e3a49c584dc4ee896c40dac7486`.

The internal coordinator now serializes activation, recovery and cancellation,
drains automatic services and base/DAC writes, and rechecks original source
clocks before committing. A failed automatic restart reports unavailable
separately from the durable release; a failed subsequent drain rejects further
non-Stop writes until runtime replacement. Producers start outside the attended
request's old command context. Historical replay cannot restart them.

Source verification includes 269 focused tests and a full coverage run with
9,556 passing tests and 19 existing skips. The subsequent request-context
regression and final base/lifecycle cases pass a further 73-test focused run.
These are simulated-observation checks over real migrated stores; public
activation remains unavailable. Production runtime registration, the attended
web/native workflow, personal learning migration and physical acceptance remain.
See [the coordinator contract](HOUSEHOLD_ARRANGEMENT_COMMIT.md).

### Household maintenance API — locally validated

Core PR 106 merged as `b41ff431cded68c2695ca3d0fb73fde361c778be` after all hosted
checks passed. The merged tree matches tested `7ed4e87dfd1ebd684caa86c066fb62e0c47eed7c`.
The follow-up registers the coordinator in the household host and adds personally
authenticated status, activation, restart, recovery and cancellation endpoints.
Restart intent is durable before a fixed controller-service submission; reconnect
reads never dispatch another restart or release the hardware hold.

All mutating maintenance paths retain the activation feature flag, off by default.
Browser identity and device authorization are rechecked across awaited work.
Source validation and migration preservation are recorded in the maintenance
contract. Web/native review and recovery screens, private learning migration,
two-person acceptance and attended Pod qualification remain required. No live
Pod, alarm, account assignment, phone or home accessory changed in this work.

The final local full suite passes 9,594 tests with 19 existing skips. The 181-test
focused suite, generated schema and migration preservation checks, full lint,
production build and post-build TypeScript check pass. The first stalled build
and its generated cache remain preserved; the fresh-cache build is the passing
result. Hosted checks and the attended client workflow remain separate work.

- **11/16 — private personal journal:** Core PR 111 contains the person-owned
  editor, scoped storage and API, with 9,766 passing source tests (19 existing
  skips) and 106 passing production-browser scenarios. Native PR 71 is stacked
  on PR 69; its 1,314 model/application tests pass (nine existing skips), focused
  iPhone/iPad UI scenarios pass and an independent full design review returned
  `ship`. Neither release is represented as deployed.
- **11/16 — private habit comparisons:** the follow-up branch reuses the existing
  descriptive comparisons for saved personal journals, grouping by retained
  time zone without pooling people, legacy records or unsaved drafts. Seventy
  focused contract/HTTP/state tests and all six browser scenarios pass. The
  independent reviewer scored the exclusion-order correction resolved after
  recapture; hosted release and native parity remain in progress. The
  findings never train a model or change hardware.
