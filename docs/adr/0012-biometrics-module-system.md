# ADR: Biometrics Module System

**Status**: Accepted
**Date**: 2026-02-23

## Context

sleepypod needs to process raw biometric sensor data from the Pod hardware and display health metrics (heart rate, HRV, breathing rate, sleep sessions, movement) in the UI.

The key constraints are:

- **Signal processing is compute-heavy**: Heart rate extraction from 500 Hz piezoelectric data requires FFT, bandpass filtering, and peak detection. Node.js is not suited for this; Python (scipy/numpy) or Rust handle it naturally.
- **Raw data is filesystem-based**: The hardware daemon writes binary CBOR files to `/persistent/*.RAW` continuously. There is no streaming API through `dac.sock` — that socket is command/response only.
- **Embedded hardware**: The Pod runs constrained Linux (ARM). Heavy dependencies (InfluxDB, message queues, etc.) are ruled out.
- **Community extensibility**: We want people to be able to swap in better algorithms (e.g., a Rust implementation, an ML-based sleep scorer) without touching the core app.
- **Time-series vs config data have different access patterns**: Config/state data is small and randomly accessed. Biometrics data is append-only, queried by time range, and may grow to tens of thousands of rows.

## Decision

We will use a **plugin/sidecar module system** with a **separate `biometrics.db` SQLite file** as the shared data contract.

The architecture:

```text
/persistent/*.RAW   ←  hardware daemon writes CBOR sensor data continuously
       ↓
[module process]    reads + tails RAW files, processes signals (any language)
       ↓
[biometrics.db]     module writes to agreed schema tables
       ↑
[sleepypod-core]    reads biometrics.db via tRPC API → UI
```

The **database schema is the public contract**. Modules do not call into the core app. The core app does not call into modules. They share only a file.

## Rationale

### Separate `biometrics.db`

Two SQLite files instead of one:

- `sleepypod.db` — device config, schedules, runtime state (existing)
- `biometrics.db` — vitals, sleep records, movement (new)

Benefits:
- Biometrics data can be cleared, backed up, or handed off independently
- Modules only need access to one file
- Different access patterns warrant different SQLite pragmas (biometrics is append-heavy, config is read-heavy)
- The core app is the only consumer that reads both

### Plugin/sidecar processes

Each module is an independent OS process managed by systemd:

- **Language agnostic**: Python is ideal for signal processing (scipy, numpy, heartpy). Rust for performance. Any language with SQLite bindings works.
- **Unix philosophy**: each module does one thing (HR extraction, sleep detection)
- **Independent lifecycle**: a crash in the HR module doesn't affect the core app or other modules
- **Community replaceable**: swap one module without touching others

### Schema as contract

The tRPC biometrics router (`getVitals`, `getSleepRecords`, `getMovement`) defines exactly what the UI needs. Those query shapes define the schema. Any module that writes rows matching the schema works automatically with the existing UI — no additional integration required.

### SQLite concurrency (WAL + busy_timeout)

Multiple modules may write to `biometrics.db` concurrently. SQLite handles this correctly with:

- **WAL mode**: allows concurrent readers while one writer holds the lock
- **`busy_timeout = 5000ms`**: writers wait rather than immediately failing if another write is in progress

At actual write frequencies (~60s intervals for vitals, rare for sleep records), contention is negligible. No external lock manager or message queue is needed.

### Manifest-based discovery

Each module ships a `manifest.json` declaring what it provides. The core app reads manifests to populate the system health/status page and know which modules are expected to be running.

```json
{
  "name": "piezo-processor",
  "version": "1.0.0",
  "description": "Heart rate, HRV, and breathing rate from piezo sensors",
  "provides": ["vitals.heartRate", "vitals.hrv", "vitals.breathingRate"],
  "writes": ["vitals"],
  "service": "sleepypod-piezo-processor.service",
  "language": "python"
}
```

## Implementation

### Biometrics schema (`src/db/biometrics-schema.ts`)

```typescript
export const vitals = sqliteTable('vitals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  heartRate: real('heart_rate'),       // bpm, null if unreliable
  hrv: real('hrv'),                    // ms
  breathingRate: real('breathing_rate'), // breaths/min
})

export const sleepRecords = sqliteTable('sleep_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  enteredBedAt: integer('entered_bed_at', { mode: 'timestamp' }).notNull(),
  leftBedAt: integer('left_bed_at', { mode: 'timestamp' }).notNull(),
  sleepDurationSeconds: integer('sleep_duration_seconds').notNull(),
  timesExitedBed: integer('times_exited_bed').notNull().default(0),
  presentIntervals: text('present_intervals', { mode: 'json' }),
  notPresentIntervals: text('not_present_intervals', { mode: 'json' }),
})

export const movement = sqliteTable('movement', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  totalMovement: integer('total_movement').notNull(),
})
```

### Module manifest type (`src/modules/types.ts`)

```typescript
export interface ModuleManifest {
  name: string
  version: string
  description: string
  provides: string[]    // e.g. ["vitals.heartRate", "vitals.hrv"]
  writes: string[]      // DB table names: ["vitals"]
  service: string       // systemd unit name
  language: string      // informational: "python" | "rust" | etc.
  minVersion?: string   // minimum sleepypod-core version required
}
```

### Bundled modules (`modules/`)

```text
modules/
├── piezo-processor/       # HR, HRV, breathing rate from 500Hz piezo data
│   ├── manifest.json
│   ├── main.py
│   ├── requirements.txt
│   └── sleepypod-piezo-processor.service
└── sleep-detector/        # Sleep session boundaries from capacitance presence data
    ├── manifest.json
    ├── main.py
    ├── requirements.txt
    └── sleepypod-sleep-detector.service
```

Each module:
1. Tails `/persistent/*.RAW` for new CBOR sensor data
2. Processes its relevant signal type
3. Writes results to `biometrics.db` using transactions
4. Writes its health status to `system_health` table in `sleepypod.db`

### Installation

The install script installs bundled modules automatically:
- Creates a Python virtualenv per module
- Installs requirements via pip
- Registers and starts the systemd service

Community modules can be installed the same way by dropping a directory into `/opt/sleepypod/modules/` with the same structure.

## Alternatives Considered

### Monolithic Node.js biometrics processing

**Pros**: No additional process, single language
**Cons**: Node.js is unsuited for FFT/signal processing; would require native `.node` addons; a crash affects the entire app
**Verdict**: Rejected

### WebSocket proxy (core app re-streams raw data)

**Pros**: Modules don't need filesystem access to `/persistent`; enables modules running on separate hardware
**Cons**: Unnecessary complexity for the current single-device setup — modules run on the same device and can read the files directly; adds latency and a failure point
**Verdict**: Not adopted for now (file access is simpler on a single device). **Not ruled out** — if modules need to run on a separate host, or if the core app wants to push real-time sensor data to the UI, a WebSocket transport is a natural fit for that phase.

### InfluxDB or other time-series DB

**Pros**: Purpose-built for time-series, better analytics queries
**Cons**: Requires a separate server process; too heavy for embedded ARM hardware; sqlite at this data volume (< 500 rows/night) is fine
**Verdict**: Rejected

### HTTP API contract (modules POST results to core app)

**Pros**: Core app controls writes, can validate
**Cons**: Round-trip overhead, requires core app to be running for modules to work, more failure points
**Verdict**: Rejected (schema-as-contract is simpler)

## Consequences

### Positive

- Any language can implement a module
- Modules fail independently — a crash doesn't affect the app or other modules
- Community can ship better algorithms without touching the core app
- Biometrics DB can be cleared/inspected/backed up independently
- Core app stays clean — no signal processing code

### Negative

- Two DB connections to manage (minor)
- Module installation requires Python on the device
- Schema changes are a breaking change for all modules (mitigated by versioning in manifest)

### Neutral

- The UI never knows or cares which module produced the data — it just reads rows

## Future Considerations

- A `minVersion` field in the manifest allows modules to declare compatibility with schema changes
- A `sp-module install <url>` CLI command could automate community module installation
- Modules could write to additional tables beyond the core three (`vitals`, `sleep_records`, `movement`) for extended analytics — as long as the core app's API also reads those tables

## References

- [free-sleep biometrics stream processor](https://github.com/samholton/free-sleep) — prior art this system is based on
- [SQLite WAL mode](https://www.sqlite.org/wal.html)
- [HeartPy — Python heart rate analysis](https://python-heart-rate-analysis-toolkit.readthedocs.io/)
- [CBOR RFC 8949](https://www.rfc-editor.org/rfc/rfc8949)

---

**Authors**: @ng (decision), Claude (documentation)
**Last Updated**: 2026-02-23
