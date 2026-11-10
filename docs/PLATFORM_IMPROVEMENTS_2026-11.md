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
| 03 | Tonight main screen | Bed, temperature, next wake and actual control mode; morning brief; accessible web/native layouts | Pending |
| 04 | Overnight comfort envelope | Persisted narrow overnight range, explicit wake exception start, arbitration/override/DST tests and live acknowledged policy | Pending |
| 05 | Recording health | Freshness, dropout, storage and processing checks; actionable messages; failed-source fixtures and live verification | In progress: authenticated read-only checks and web cards |
| 06 | Watch recording assistant | Import receipt, coverage and uncertainty-aware troubleshooting; foreground/background tests with actual Watch history | Pending |
| 07 | Guided learning | Separate stage, baseline and temperature readiness with accurate missing evidence and usable next actions | Pending |
| 08 | Predictive temperature control | Target-change dataset, held-out response validation, bounded Preview evaluation, reviewed activation and prospective outcomes | Pending |
| 09 | Optional daytime context | Consented workout/activity/history imports, source/time semantics, missingness and per-person isolation tests | Pending |
| 10 | Comfort experiments | Reviewable nearby treatments, fixed wake, randomization/carryover handling, feedback, stop/revert and prospective observations | Pending |
| 11 | Habit discoveries | Optional timing/quantity, comparable counts, missing-data/confounding explanations; no causal claims | Pending |
| 12 | Morning brief | Three evidence-backed takeaways, comparison chart, badges, one experiment, grounded follow-up and expandable provenance | Pending |
| 13 | Explanation timeline | Requested/reported values, environment, manual origin and applied/withheld decisions joined without fabricated causality | Pending |
| 14 | Clear wake plan | Actual warming/vibration summary, simple editor, advanced disclosure, app-owned backup alarm and qualified accessory receipts | Pending |
| 15 | Sleep in tomorrow | One-occurrence preview, cross-device receipts, partial failure/recovery and recurring schedule restoration | Pending |
| 16 | Complete two-person experience | Invite/sign-in/privacy/preferences/publication plus atomic reviewed Marissa-left/Luca-right activation; immutable historical attribution; solo until activation | Pending |
| 17 | Quiet and temporary arrangements | Explicit partner-resting/guest/side-swap state; shared-action arbitration and ambiguous-night training exclusion | Pending |
| 18 | In-app practice | Illustrated guide reused, interactive temperature/alarm/Stop practice; secure invitation without owner key | Pending |
| 19 | Coordinated bedroom | Fresh sensor requirements, approved currently-on lights/shades/purifier capabilities; separate physical tests and dry-run receipts | Pending |
| 20 | Endel bedtime ritual | Supported Shortcuts/AirPlay flow, selected volume/duration, actual route state and tested tap-to-finish fallback | Pending |
| 21 | Watch, ESP32 and widgets | Temperature/Stop/next alarm, person assignment and freshness parity; simulator and physical verification | Pending |
| 22 | Temporary cooling | Modest bounded request, explicit feedback, expiry/cancellation, no stale restoration over a newer manual command | Pending |
| 23 | Bed-care center | Actionable real telemetry, backup age and recovery walkthrough; unavailable leak detection stays unavailable | Pending |
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
  adds encrypted, identity-scoped records, reports and schedules. Local signed
  simulator checks passed on iPhone and iPad; physical and personal-account work
  remains. Detailed receipts are in native `Integration/parity/OFFLINE_LIBRARY.md`.
- **05 — recording readiness:** [implementation and validation](RECORDING_READINESS.md)
  covers eight independent equipment/history checks, source expiry and web status.
  Native presentation, classification-dropout analysis and physical deployment
  remain separate acceptance work.
