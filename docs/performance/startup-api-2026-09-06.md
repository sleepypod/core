# Startup and API performance — 2026-09-06

This pass follows PR #693. Measurements use the same Pod at 192.168.1.88;
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
  background. Shutdown cancels pending scheduler initialization and prevents
  delayed integration starts from reviving services.
- NATS discovery inspects the individual Pod's installed service and JetStream
  storage, then verifies its greeting. Confirmed RAW-only Pods avoid the grace
  window. Known NATS installations keep retrying through delayed server starts;
  unknown installations retain the 60-second fallback. Local overrides:
  `PIEZO_SENSOR_SOURCE=raw|nats`, or legacy `PIEZO_NATS_DISABLED=1` for RAW.
- Live RAW ingestion uses asynchronous file operations, scans for rotation once
  a second, polls every 25 ms, reads at most 64 KiB per batch, and decodes at most
  128 outer records or approximately 4 ms before yielding. A single record may
  exceed that time budget; incomplete records are bounded to 1 MiB before
  resynchronizing. File offsets, split records, cap persistence, truncation and
  seek indexes are preserved. Shutdown waits for the active read to finish.
- `sp-maintenance` defaults to required boot repairs. Journal vacuum, old temp
  cleanup, backup pruning and pnpm pruning run via a timer ten minutes after
  activation and daily thereafter. Fresh and OTA installs both install the timer;
  newly created update staging directories are excluded from cleanup.
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

Production Next build passed. The full suite passed 3,661 tests with one
skipped; an additional same-name RAW replacement regression subsequently
passed in the 158-test streaming suite. TypeScript, ESLint, both Drizzle schema
checks, shell syntax and maintenance lifecycle checks passed.

Deployment measurements will be recorded after the final build.
