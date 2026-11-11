# Shell integration test budgets

The updater, deployment, diagnostic CLI and biometrics archiver suites execute
real child processes against temporary fixture directories. They run sequentially
in the Node environment after ordinary unit and thermal integration tests.
Their assertions, fixtures and production scripts remain unchanged.

On the development Mac, repeated isolated updater/archiver runs failed only the
default five-second Vitest deadline. Process profiling measured successful shell
commands taking about 5.3–5.8 seconds on the slow cases, usually about 0.5–1.3
seconds. Serial execution and changing Vitest's worker pool did not consistently
remove the failures. This identifies time spent waiting on real processes; it
does not establish the operating-system cause of those stalls or a production
runtime guarantee.

These integration cases now have a 20-second test budget. The updater and archiver
also use `fixtureCommand`, which limits each subprocess to ten seconds and throws
on launch or timeout errors. An expected nonzero exit cannot accidentally turn a
timed-out command into a passing rejection test. A dedicated real-process check
verifies cancellation. Ordinary unit tests keep their existing five-second limit.

Changing these budgets does not establish that a firmware update is safe on live
hardware. Backups, restoration rehearsal, current availability and deployment
acceptance remain separate gates.
