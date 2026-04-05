# Biometrics System

Plugin/sidecar module architecture for processing raw sensor data into health metrics.

## Architecture

```
/persistent/*.RAW   ←  hardware daemon writes CBOR sensor data continuously
       ↓
[module process]    reads + tails RAW files, processes signals (any language)
       ↓
[biometrics.db]     module writes to agreed schema tables
       ↑
[sleepypod-core]    reads biometrics.db via tRPC API → UI
```

The **database schema is the public contract**. Modules do not call into the core app. The core app does not call into modules. They share only a file.

## Why Sidecar Processes

- **Language agnostic** — Python is ideal for signal processing (scipy, numpy); Rust for performance
- **Independent lifecycle** — a crash in one module doesn't affect the core app or others
- **Unix philosophy** — each module does one thing (HR extraction, sleep detection)
- **Community replaceable** — swap a module without touching others

Node.js was rejected for signal processing (FFT at 500 Hz requires native addons; a crash affects the entire app).

## Two Databases

| Database | Purpose | Access Pattern |
|----------|---------|----------------|
| `sleepypod.db` | Config, schedules, runtime state | Read-heavy, random access |
| `biometrics.db` | Vitals, sleep records, movement, [[sensor-calibration|calibration]] | Append-heavy, time-range queries |

Different access patterns warrant different SQLite pragmas. Biometrics data can be cleared, backed up, or handed off independently.

## SQLite Concurrency

Multiple modules write to `biometrics.db` concurrently using:
- **WAL mode** — concurrent readers while one writer holds the lock
- **`busy_timeout = 5000ms`** — writers wait rather than failing

At actual write frequencies (~60s intervals), contention is negligible.

## Schema Contract

### vitals
Written by [[piezo-processing]]: `heartRate` (bpm), `hrv` (ms), `breathingRate` (breaths/min). Fields may be null if sensor couldn't get a reliable reading.

### sleep_records
Written by [[sleep-detection]]: session boundaries, duration, bed exit count, present/absent intervals.

### movement
Written by [[sleep-detection]]: movement score per 60s epoch (0-1000, PIM delta-based).

## Module Manifest

Each module ships a `manifest.json`:

```json
{
  "name": "piezo-processor",
  "version": "1.0.0",
  "provides": ["vitals.heartRate", "vitals.hrv", "vitals.breathingRate"],
  "writes": ["vitals"],
  "service": "sleepypod-piezo-processor.service",
  "language": "python"
}
```

The core app reads manifests to populate the system health/status page.

## Bundled Modules

| Module | Service | Writes | Language |
|--------|---------|--------|----------|
| [[piezo-processing|piezo-processor]] | sleepypod-piezo-processor.service | vitals | Python |
| [[sleep-detection|sleep-detector]] | sleepypod-sleep-detector.service | sleep_records, movement | Python |
| [[sensor-calibration|calibrator]] | sleepypod-calibrator.service | calibration_profiles, calibration_runs | Python |

Community modules can be installed by dropping a directory into `/opt/sleepypod/modules/` with the same structure.

## Sources

- `docs/adr/0012-biometrics-module-system.md`
