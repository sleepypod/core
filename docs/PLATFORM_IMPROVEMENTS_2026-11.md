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

## Requirement and acceptance ledger

| ID | Approved improvement | Acceptance evidence required | State |
| --- | --- | --- | --- |
| 01 | Automatic home/away connection | Verified-origin pairing, authenticated route selection, credential isolation, expired access and work-network/cellular tests; no mutation replay | Pending |
| 02 | Useful offline app | Encrypted identity-scoped records, reports and confirmed schedules; timestamps; account-switch/revocation tests; offline phone/iPad walkthrough | In progress: owner offline library |
| 03 | Tonight main screen | Bed, temperature, next wake and actual control mode; morning brief; accessible web/native layouts | Web source validated; native implementation and release checks in progress |
| 04 | Overnight comfort envelope | Persisted narrow overnight range, explicit wake exception start, arbitration/override/DST tests and live acknowledged policy | In progress: shared automatic range and explicit wake exception |
| 05 | Recording health | Freshness, dropout, storage and processing checks; actionable messages; failed-source fixtures and live verification | Read-only checks shipped in source; completed-interval interruption review in validation; live qualification pending |
| 06 | Watch recording assistant | Import receipt, coverage and uncertainty-aware troubleshooting; foreground/background tests with actual Watch history | Native implementation tested; hosted checks and actual Watch delivery pending |
| 07 | Guided learning | Separate stage, baseline and temperature readiness with accurate missing evidence and usable next actions | Core PR 86 merged; native PR 62 tested locally and awaiting hosted checks |
| 08 | Predictive temperature control | Target-change dataset, held-out response validation, bounded Preview evaluation, reviewed activation and prospective outcomes | Core PR 93 merged the evidence audit; local response-model fitting, comparison and research-preview UI are in validation; native parity and prospective control remain pending |
| 09 | Optional daytime context | Consented workout/activity/history imports, source/time semantics, missingness and per-person isolation tests | Native owner-scoped import and review passed local tests; hosted release, physical delivery and comfort associations remain |
| 10 | Comfort experiments | Reviewable nearby treatments, fixed wake, randomization/carryover handling, feedback, stop/revert and prospective observations | Pending |
| 11 | Habit discoveries | Optional timing/quantity, comparable counts, missing-data/confounding explanations; no causal claims | Core timing, quantity, explicit missingness and self-reported comfort comparisons in validation; native parity and live release remain |
| 12 | Morning brief | Three evidence-backed takeaways, comparison chart, badges, one experiment, grounded follow-up and expandable provenance | Pending |
| 13 | Explanation timeline | Requested/reported values, environment, manual origin and applied/withheld decisions joined without fabricated causality | Core PR 91 passed all hosted checks and merged; native timeline and live release in progress |
| 14 | Clear wake plan | Actual warming/vibration summary, simple editor, advanced disclosure, app-owned backup alarm and qualified accessory receipts | Source implementation and tests in progress; physical alarm and accessories remain unqualified |
| 15 | Sleep in tomorrow | One-occurrence preview, cross-device receipts, partial failure/recovery and recurring schedule restoration | Pending |
| 16 | Complete two-person experience | Invite/sign-in/privacy/preferences/publication plus atomic reviewed Marissa-left/Luca-right activation; immutable historical attribution; solo until activation | Pending |
| 17 | Quiet and temporary arrangements | Explicit partner-resting/guest/side-swap state; shared-action arbitration and ambiguous-night training exclusion | Pending |
| 18 | In-app practice | Illustrated guide reused, interactive temperature/alarm/Stop practice; secure invitation without owner key | Pending |
| 19 | Coordinated bedroom | Fresh sensor requirements, approved currently-on lights/shades/purifier capabilities; separate physical tests and dry-run receipts | Pending |
| 20 | Endel bedtime ritual | Supported Shortcuts/AirPlay flow, selected volume/duration, actual route state and tested tap-to-finish fallback | Pending |
| 21 | Watch, ESP32 and widgets | Temperature/Stop/next alarm, person assignment and freshness parity; simulator and physical verification | Pending |
| 22 | Temporary cooling | Modest bounded request, explicit feedback, expiry/cancellation, no stale restoration over a newer manual command | Core PR 90 passed hosted checks and merged; native PR 65 passed local validation and awaits hosted checks; live release remains |
| 23 | Bed-care center | Actionable real telemetry, backup age and recovery walkthrough; unavailable leak detection stays unavailable | Core PR 89 passed all hosted checks and merged; native consolidated PR 64 awaiting hosted checks; live deployment remains |
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
