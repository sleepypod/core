# Sleep Detection

Bed occupancy tracking, movement scoring, and sleep session boundaries from capacitance sensor data. Part of the [[biometrics-system]].

## Overview

The sleep-detector tails CBOR-encoded `.RAW` files, processes `capSense` (Pod 3) and `capSense2` (Pod 5) records at ~2 Hz, and writes to `sleep_records` and `movement` tables in `biometrics.db`.

## Movement Scoring (PIM)

Movement is the sum of absolute sample-to-sample deltas across 3 sensing channel pairs, accumulated over 60-second epochs. This is the bed-sensor analog of wrist actigraphy's Proportional Integration Mode.

### Why deltas, not z-scores

The previous approach measured "how present" someone was, not "how much they moved." A person lying still scored 28,000-75,000 — nearly the same as rolling over. Delta scoring removes the DC presence offset entirely:

| Score | State | Expected during sleep |
|-------|-------|-----------------------|
| 0-50 | Still (deep sleep) | 70-80% of epochs |
| 50-200 | Minor fidgeting | 10-15% |
| 200-500 | Limb repositioning | 5-10% |
| 500+ | Major position change | 1-3% (~1-2/hour) |

### Processing Pipeline

1. **Sentinel filter** — capSense2 firmware occasionally emits -1.0; handled via zero-order hold
2. **Pair averaging** — average redundant channel pairs (A1+A2)/2, etc.
3. **Reference compensation** — subtract ref channel drift from nominal 1.16 (common-mode rejection)
4. **Pump gate** — suppress deltas during pump activity (see below)
5. **Per-channel delta** — |current - previous| per channel
6. **60s epoch accumulation** → `raw_score = min(1000, sum × scale)`
7. **Baseline subtraction** — subtract P5 of trailing 30 epochs (removes slow-building noise)
8. **3-epoch median filter** — suppress isolated spike artifacts
9. **Clamp** to [0, 1000]

Scale factor is sensor-dependent: capSense2 (Pod 5) uses ×10, capSense (Pod 3) uses ×0.5 to normalize different ADC ranges.

## Pump Artifact Gating

Without gating, pump vibrations accumulate to raw scores of 60-200 per pump-active epoch, escalating from ~50 to 960-990 by early morning.

Three-signal detection:
1. **frzHealth pump RPM** (Pod 5 only, ~0.06 Hz) — any RPM > 0 means pump running
2. **Reference channel anomaly** — |ref_delta| > 0.02 AND 2+ active channels correlate
3. **3-second guard period** after pump-off (shorter than [[piezo-processing|piezo's 5s]] — capacitive sensors are less sensitive to mechanical vibration)

## Presence Detection

Uses calibrated z-score thresholds from `calibration_profiles` when available (see [[sensor-calibration]]), falling back to fixed thresholds (1500 for capSense, 60.0 for capSense2). Profiles reloaded every 60 seconds.

## Sleep Sessions

- **Start**: first present sample
- **End**: after 120s consecutive absence (`ABSENCE_TIMEOUT_S`)
- **Minimum**: 300s (5 min) — shorter periods discarded as false positives
- **Bed exits**: mid-session absences counted

Records include entry/exit timestamps, duration, exit count, and present/absent interval arrays.

## Known Limitations

1. Cross-side vibration coupling causes brief spikes (200-500) on the empty side
2. Presence chattering on drifted baselines inflates `times_exited_bed`
3. No sleep stage classification (wake vs sleep only via movement density)
4. Scale calibration tuned on one Pod 5
5. frzHealth pump signal is Pod 5 only with ~16s detection latency
6. Pump gate field names not confirmed on all firmware versions
7. Baseline subtraction cold start: first 10 minutes not baseline-subtracted

## Sources

- `docs/sleep-detector.md`
