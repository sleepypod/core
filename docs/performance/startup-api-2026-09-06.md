# Startup and API performance — 2026-09-06

This pass follows PR #693 and is proposed in [PR #694](https://github.com/sleepypod/core/pull/694).
The measured implementation, `aeb3852`, is deployed on the same Pod at 192.168.1.88;
the starting deployment is `38e0695`, so the new build also incorporates the
process-wide DAC singleton correction merged into `dev` after that deployment.

## Changes

- Health requests use `SELECT 1` for connectivity. Full SQLite `quick_check`
  runs on a separate read-only worker connection, first after 30 seconds and
  then hourly. Its result and check timestamp appear in `database.integrity`.
  Pending integrity results are explicit; corruption and scan errors degrade
  health. Requests never trigger the scan.
- Firewall health uses asynchronous `execFile`, one listing per INPUT/OUTPUT
  chain, a cached executable path, and a shared 30-second result. Startup
  repair retains its ordering and invalidates cached diagnostics.
- Room climate and raw water-level metadata share a two-second snapshot across
  concurrent requests and Next bundles. Sidecars write their tables externally,
  so the TTL bounds visibility delay; original sample timestamps remain intact.
  Hardware status, alarm state, pump fault notices and mutations stay outside
  this cache. Failed enrichment returns null values and retries after the TTL.
- HTTP initialization awaits migrations, firewall setup and pump-guard
  rehydration. The DAC socket and sensor stream start before schedule loading;
  the clock gate lives in the shared scheduler singleton so early API consumers
  cannot bypass it. Optional integrations and the initial LED write run in the
  background. Cron loading yields after roughly 8 ms or 25 registrations,
  including between a power schedule's on/off registrations. Shutdown cancels
  and awaits pending scheduler initialization and prevents delayed integration
  starts or LED settings reads from reviving services or writing to hardware.
- NATS discovery inspects the individual Pod's installed service and JetStream
  storage, then verifies its greeting. Confirmed RAW-only Pods avoid the grace
  window. Known NATS installations keep retrying through delayed server starts;
  unknown installations retain the 60-second fallback and retry installation
  discovery during that window if the initial probe was inconclusive. Local overrides:
  `PIEZO_SENSOR_SOURCE=raw|nats`, or legacy `PIEZO_NATS_DISABLED=1` for RAW.
- Live RAW ingestion uses asynchronous file operations, scans for rotation once
  a second, polls every 25 ms, reads at most 64 KiB per batch, and decodes at most
  128 outer records or approximately 4 ms before yielding. Backlogs resume after
  yielding instead of waiting for the 25 ms idle poll interval. A single record may
  exceed that time budget; incomplete records are bounded to 1 MiB before
  resynchronizing. File offsets, split records, cap persistence, truncation and
  seek indexes are preserved. Shutdown waits for the active read to finish.
- `sp-maintenance` defaults to required boot repairs. Journal vacuum, old temp
  cleanup, backup pruning and pnpm pruning run via a timer ten minutes after
  activation and daily thereafter. Fresh and OTA installs both install the timer;
  directories containing recent activity are excluded from cleanup.
- Routine production tRPC request logging is disabled. `/api/health/performance`
  reports startup phases, source choice, first sensor frame, RSS and process-wide
  event-loop delay since instrumentation began (including remaining startup). It makes no hardware or database calls.

## Measurement method

`startup-api-2026-09-06/benchmark.mjs` preserves the earlier benchmark: 15 seconds
idle, 60 status requests at 2 Hz, 12 bursts of four status reads alongside DAC
health, HTML/assets, settings, and WebSocket cadence. It adds 20 system-health
requests each paired with a trivial HTTP healthcheck to expose interference.
CPU is percentage of one core. Measurements use loopback and include response
bodies; they do not measure browser rendering or Wi-Fi latency.

The fresh baseline is retained in `startup-api-2026-09-06/before.json`.
`startup.mjs` restarts only the web service and polls HTTP every 500 ms for
90 seconds, recording first capSense and device-status frames via WebSocket.
It distinguishes the first available cap frame from one within five seconds
of the current clock. Restart timing includes service shutdown and ExecStartPre.

## Validation

The measured implementation passed the production Next build and CI, including
patch coverage. The full local suite passed 3,668 tests in 158 files with one
skipped. TypeScript, ESLint, both Drizzle schema checks, shell syntax and
maintenance lifecycle checks passed. ESLint retains an existing warning in
`stryker.config.mjs` and reports no errors.

A subsequent CodeRabbit review found that scheduled day/night LED callbacks
could resume a settings read after shutdown and still write brightness. Both
callbacks now check shutdown state after that read. Two regression tests fail
on the measured build and pass with the guards; all 106 JobManager tests pass.
This follow-up is separate from the deployed build and measurements below.

The first deployment (`8fc0933`) is retained in `initial-startup-after.json`
and `initial-after.json`. It reduced system-health median latency from 290.47
ms to 39.38 ms, but fixed-size scheduler batches still delayed local service
callbacks; discovery reported an unknown installation and waited. Its
first/current cap frames arrived at 68.85/85.74 seconds. These observations
motivated elapsed-time scheduler yielding, repeated inconclusive installation
discovery, and prompt resumption of RAW backlog batches.

## Final Pod measurements

The before and after startup runs each restarted only `sleepypod.service` and
observed the process for 90 seconds. The after run selected RAW on this Pod.

| Startup milestone, from restart request | Before `38e0695` | After `aeb3852` |
| --- | ---: | ---: |
| Service restart command completed | 6.44 s | 0.21 s |
| First successful HTTP healthcheck | 34.99 s | 9.30 s |
| First capSense frame | Not observed within 90 s | 9.62 s |
| First capSense frame within 5 s of the clock | Not observed within 90 s | 13.60 s |
| First device-status WebSocket frame | 34.87 s | 31.22 s |

HTTP readiness improved by 73%. Sensor data became available much earlier,
including the time required to catch up with the RAW file. HTTP readiness does
not imply that the scheduler or device-status stream has finished starting.

The steady-state benchmark started about 3 minutes 18 seconds after the final
restart. Each request statistic below is a median unless otherwise indicated.

| Metric | Before `38e0695` | After `aeb3852` |
| --- | ---: | ---: |
| System health | 290.47 ms | 39.09 ms |
| Trivial healthcheck paired with system health | 311.98 ms | 60.06 ms |
| Status, one request every 500 ms | 38.03 ms | 40.44 ms |
| Status p95 | 42.85 ms | 54.48 ms |
| Status, bursts of four concurrent reads | 82.86 ms | 72.49 ms |
| DAC health alongside each burst | 126.57 ms | 116.65 ms |
| Settings | 29.59 ms | 31.71 ms |
| Main-page HTML | 47.18 ms | 50.97 ms |
| Debug-page HTML | 31.64 ms | 35.81 ms |
| Device-status WebSocket gap | 1,000.68 ms | 1,000.59 ms |
| Idle CPU, percentage of one core | 12.65% | 7.40% |
| CPU during status polling, percentage of one core | 20.52% | 21.95% |
| RSS at the end of status polling | 193.71 MiB | 176.27 MiB |

System-health latency fell by 87%, and delay to the paired trivial request fell
by 81%. Ordinary status calls did not improve in this sample: their median rose
6%, p95 rose 27%, and polling CPU increased. Concurrent-status median improved,
but its p95 was essentially unchanged (113.34 ms to 114.46 ms). These results
support the startup and diagnostic changes; they do not establish a general
API, page-rendering or frontend bundle improvement.

Raw results are in `startup-api-2026-09-06/startup-before.json`,
`startup-api-2026-09-06/startup-after.json`, `startup-api-2026-09-06/before.json`
and `startup-api-2026-09-06/after.json`. The intermediate build results are also
retained. These are individual runs on a live RAW-only J00 Pod with its existing
sidecars and schedules, not controlled repeated trials. Physical NATS firmware
was not available for deployment validation; per-Pod identity, greeting,
delayed-service and fallback behavior are covered by automated tests.

## Deployment verification and remaining work

`startup-api-2026-09-06/verification.json` records the deployed version, system
health, worker integrity result, scheduler drift, service states and a fresh
WebSocket sensor frame. Application databases and shared native dependencies
were preserved, and the previous application release remains available for
rollback. Firmware and Python services were not restarted.

The new startup telemetry still shows roughly 15 seconds spent initializing
the scheduler and a maximum event-loop delay of 2.28 seconds during startup.
Its timing starts when instrumentation begins, whereas the restart benchmark
starts before service shutdown. The first device-status frame still takes
about 31 seconds. Profiling those remaining startup stalls and the status route
is the next step; this change does not eliminate those delays. Python sensor
followers also retain their existing NATS grace behavior, as documented in
`docs/nats-frame-readers.md`.
