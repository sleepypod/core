# Sensor Calibration

Adaptive threshold system that replaces hardcoded values with per-pod calibration profiles. Used by [[piezo-processing]] and [[sleep-detection]].

## Why Calibration

Hardcoded thresholds fail across pods:
- Piezo processor reports HR 200+ on empty beds (ambient vibration)
- Sleep detector's fixed presence threshold (1500) doesn't match all mattress/sensor combinations
- Thermistor factory tolerance varies +/-0.5°C between pods

free-sleep had calibration, but each module embedded its own logic with different formats and no shared library.

## Architecture

Single-writer/multiple-reader pattern via a shared Python library (`modules/common/calibration.py`):

- **Calibrator module** — sole writer to `calibration_profiles` table
- **Processing modules** — read-only consumers, poll every 60s for updates
- **tRPC router** — exposes profiles to iOS app for inspection

### Trigger Mechanisms

| Trigger | Mechanism | Timing |
|---------|-----------|--------|
| Pre-prime | jobManager schedules calibration 30min before pod prime time | Primary path |
| Daily fallback | Internal 25h timer | If priming disabled |
| On-demand | Trigger file from iOS via tRPC | ~10s latency (poll interval) |

Trigger files use atomic writes (`.tmp` then rename) with unique filenames for queuing concurrent requests.

## Calibration Profiles

One row per (side, sensor_type) in `calibration_profiles` table. Key fields:

| Field | Sensor | Purpose |
|-------|--------|---------|
| `noise_floor_rms` | All | Adaptive threshold computation |
| `noise_floor_p95` | All | Spike rejection |
| `baseline_mean/std` | All | DC offset and stability |
| `presence_threshold` | Capacitance | 6× noise floor RMS (replaces fixed 200,000) |
| `hr_noise_floor_bpm` | Piezo | Minimum detectable HR |
| `temp_offset_c` | Temperature | Factory thermistor correction |

## Medical-Informed Thresholds

Key changes from free-sleep with medical rationale:

| Parameter | free-sleep | sleepypod | Why |
|-----------|-----------|-----------|-----|
| HR max | 90 bpm | 100 bpm | AHA tachycardia definition; REM surges average 26% above baseline |
| HR min | 40 bpm | 30 bpm | Elite athletes document sleeping HR in low 30s (AHA bradycardia guidelines) |
| BR range | 8-20 | 6-22 | Deep N3 can dip near 7; mild tachypnea during REM accommodated |
| HRV max | 200 ms | 300 ms | Young adults exceed 200ms SDNN during deep NREM |
| HRV metric | SDNN | RMSSD | Parasympathetic dominance during sleep; industry standard (Oura, Garmin, Fitbit) |
| Presence | Fixed 200k | 6× noise floor | Adapts to sensor drift, mattress aging, material differences |

## Quality Scoring

Each vitals reading gets a composite quality score (0.0-1.0) in the `vitals_quality` table:

```
quality = 0.35 × SNR + 0.30 × HR_confidence + 0.15 × BR_confidence + 0.20 × motion_score
```

| Score | Meaning |
|-------|---------|
| 0.80-1.00 | High confidence (green) |
| 0.50-0.79 | Moderate (yellow) |
| 0.20-0.49 | Low — values may be inaccurate (orange) |
| < 0.20 | Reject — treat as null (red) |

## Module Integration Pattern

### Startup
Load profile from DB; if none exists (fresh install), use hardcoded defaults. If profile > 48h old, use with warning.

### Running
Poll `calibrated_at` every 60s. If newer, hot-swap thresholds (no restart needed).

### Graceful Degradation
| State | Behavior |
|-------|----------|
| No profile | Hardcoded defaults |
| Stale (>48h) | Use with warning log |
| Fresh (<48h) | Full adaptive thresholds |
| Calibration fails | Previous profile remains |

## Sources

- `docs/adr/0014-sensor-calibration.md`
- `docs/hardware/calibration-architecture.md`
