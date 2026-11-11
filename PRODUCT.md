# Sleepypod household app

This platform combines a local Eight Sleep Pod controller, a browser app and an
independently maintained native iPhone/iPad app. It helps household members set
comfortable temperatures, understand their recordings and manage clear wake plans.
The Pod remains the hardware authority; a phone or home server is not required for
its saved local routines. The approved improvement scope and acceptance ledger are
in [the platform plan](docs/PLATFORM_IMPROVEMENTS_2026-11.md).

## People and everyday tasks

The primary experience is for people who want to sleep comfortably without learning
the controller's internals. Household identity, private history and physical bed
side are separate. A second person's account and side assignment require an explicit
reviewed transition; occupancy alone cannot identify a sleeper.

Everyday tasks are checking tonight's temperature and wake time, changing a setting,
stopping an action, reading a morning report and resolving an understandable alert.
Detailed diagnostics remain available beneath those tasks.

## Existing visual direction

Extend the current restrained app identity: legible type, plain light/dark surfaces,
subtle dividers, familiar navigation and clear control labels. Web components follow
the existing AppShell and design tokens. Native views use the existing Theme,
system text styles, SF Symbols and SwiftUI navigation. Match meaning and behavior
across platforms while respecting native interactions and Dynamic Type. This scope
does not introduce a new visual world or replace the design system.

## Bed care

Bed care turns actual water, priming, circulation protection, recording, storage
and backup observations into practical next steps. Each source retains its own
freshness. Missing or expired observations cannot establish current condition;
their former advice belongs in a dated history disclosure. Reading the page never
primes, dismisses protection, enables a guard, deletes data or restarts the Pod.

Retain direct paths to relevant diagnostics, protection settings and backups.
Explain the difference between a recorded server export, a completed download,
an off-Pod copy and a verified restore. The hardware does not supply evidence of
physical leaks or maintenance-insert age, and the app must not imply otherwise.
See the [bed-care surface brief](docs/design/BED_CARE_BRIEF.md).

## Evidence and release boundaries

Owner/personal authentication and data isolation apply to every surface. Reconnects
perform reads; an expired or ambiguous client actuator request is not replayed.
Synthetic practice examples are labeled. Occupancy is separate from measured sleep,
and model suggestions are separate from approved deterministic control.

Source checks, browser/simulator results, distributed builds, live deployment and
physical observations are distinct evidence. Controller maintenance preserves data
and follows the current attended update procedure. A software test cannot prove
that water flowed, a base moved, an alarm vibrated or sleep improved.
